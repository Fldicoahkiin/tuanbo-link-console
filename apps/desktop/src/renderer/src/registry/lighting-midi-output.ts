import { LightingNetworkOutput } from './lighting-network-output';
import { requestMidiAccess } from './midi-access';
import { requireOutputLicense } from './license-output';
import { compileLightingPackets, compileLightingReleasePackets, LightingScheduler, LightingOutputRelease, type LightingPacket } from '@tb/core/link';
import type { IntegrationProfile, LightingDocument } from '@tb/schema';

export class LightingMidiOutput {
  private readonly releaseOutput = new LightingOutputRelease({ getMa2NetworkStatus: () => window.tbLink.getMa2NetworkStatus(), playMa2Cue: request => window.tbLink.playMa2Cue(request) });
  private readonly network = new LightingNetworkOutput();
  private networkEnabled = false;
  private generation = 0;
  private scheduler: LightingScheduler | null = null;
  private readonly outputs = new Map<string, MIDIOutput>();
  private releasePackets: { output: MIDIOutput; packet: LightingPacket }[] = [];
  async prepare(document: LightingDocument, profile: IntegrationProfile | null, positionMs: number): Promise<void> {
    this.stop();
    this.releasePackets = [];
    const generation = this.generation;
    await this.releaseOutput.prepare(document);
    if (generation !== this.generation) return;
    const packets = compileLightingPackets(document, profile?.lighting?.mscDeviceId ?? 127);
    const ids = new Set(packets.map((packet) => packet.portProfileId));
    if (ids.size) {
      await requireOutputLicense();
      if (generation !== this.generation) return;
      const access = await requestMidiAccess({ sysex: true });
      if (generation !== this.generation) return;
      for (const id of ids) {
        const mapping = profile?.midiPortProfiles.find((entry) => entry.id === id && entry.direction === 'output');
        const ports = [...access.outputs.values()].filter((port) => port.name === mapping?.portName && port.state === 'connected');
        const port = ports[0]; if (!port || ports.length !== 1) throw new Error(`灯光输出不可用或不唯一：${id}`);
        await port.open(); if (generation !== this.generation) return; this.outputs.set(id, port);
      }
    }
    this.networkEnabled = document.outputMode === 'network';
    if (this.networkEnabled) await this.network.prepare(document, positionMs);
    if (generation !== this.generation) return;
    this.releasePackets = compileLightingReleasePackets(document, profile?.lighting?.mscDeviceId ?? 127).map(packet => {
      const output = this.outputs.get(packet.portProfileId);
      if (!output) throw new Error(`灯光关闭端口未准备：${packet.portProfileId}`);
      return { output, packet };
    });
    this.scheduler = new LightingScheduler(packets, (packet) => this.send(packet)); this.scheduler.locate(positionMs);
  }
  tick(positionMs: number): void { this.network.tick(positionMs); this.scheduler?.tick(positionMs); }
  async release(): Promise<void> {
    const packets = this.releasePackets; this.releasePackets = [];
    for (const { output, packet } of packets) {
      if (output.state !== 'connected' || output.connection !== 'open') throw new Error('MIDI 灯光关闭未发送：原播放端口已断开');
      output.send(packet.bytes);
    }
    await this.network.close(); await this.releaseOutput.release();
  }
  finish(positionMs: number): Promise<void> | void { this.scheduler?.finish(positionMs); if (this.networkEnabled) return this.network.finish(positionMs); }
  loop(startMs: number, endMs: number): void { this.network.loop(startMs, endMs); this.scheduler?.loop(startMs, endMs); }
  locate(positionMs: number): void { this.network.locate(positionMs); this.scheduler?.locate(positionMs); }
  stop(): void { this.generation += 1; this.releaseOutput.cancelPreparation(); this.networkEnabled = false; this.network.stop(); this.scheduler?.stop(); this.scheduler = null; this.outputs.clear(); }
  private send(packet: LightingPacket): void {
    const port = this.outputs.get(packet.portProfileId);
    if (!port || port.state !== 'connected') throw new Error(`灯光输出已断开：${packet.portProfileId}`);
    port.send(packet.bytes);
  }
}
