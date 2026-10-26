import { LightingNetworkOutput } from './lighting-network-output';
import { requestMidiAccess } from './midi-access';
import { requireOutputLicense } from './license-output';
import { compileLightingPackets, compileLightingReleasePackets, LightingScheduler, LightingOutputRelease, type LightingOnAir, type LightingPacket } from '@tb/core/link';
import type { IntegrationProfile, LightingDocument } from '@tb/schema';

/** `rebuild` is for the internal player only (B): resume, seek and clock gaps send
 * the state at the position instead of replaying or dropping events. P1 follow
 * and previews keep plain locate. */
export class LightingMidiOutput {
  private readonly releaseOutput = new LightingOutputRelease({ getMa2NetworkStatus: () => window.tbLink.getMa2NetworkStatus(), playMa2Cue: request => window.tbLink.playMa2Cue(request) });
  private readonly network = new LightingNetworkOutput();
  private networkEnabled = false;
  private generation = 0;
  private scheduler: LightingScheduler | null = null;
  private readonly outputs = new Map<string, MIDIOutput>();
  private releasePackets: { output: MIDIOutput; packet: LightingPacket }[] = [];
  private document: LightingDocument | null = null;
  private carried: { document: LightingDocument; onAir: LightingOnAir } | null = null;
  private ticked: number | null = null;
  /** Direct or network lighting is sent from here; console timecode sends nothing locally. */
  private local = false;
  private fault: string | null = null;
  constructor(private readonly rebuild = false) {}
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
        const port = ports[0]; if (!port || ports.length !== 1) throw new Error(`灯光输出端口不可用，或有多个同名端口：${id}`);
        await port.open(); if (generation !== this.generation) return; this.outputs.set(id, port);
      }
    }
    this.networkEnabled = document.outputMode === 'network';
    const restored = this.networkEnabled ? await this.network.prepare(document, positionMs, this.rebuild) : 0;
    if (generation !== this.generation) return;
    this.releasePackets = compileLightingReleasePackets(document, profile?.lighting?.mscDeviceId ?? 127).map(packet => {
      const output = this.outputs.get(packet.portProfileId);
      if (!output) throw new Error(`用于关闭灯光的端口还没准备好：${packet.portProfileId}`);
      return { output, packet };
    });
    this.scheduler = new LightingScheduler(packets, (packet) => this.send(packet), this.rebuild && this.carried?.document === document ? this.carried.onAir : undefined);
    this.document = document; this.carried = null; this.ticked = positionMs; this.local = packets.length > 0 || this.networkEnabled;
    if (!this.rebuild) { this.scheduler.locate(positionMs); return; }
    const sent = restored + this.scheduler.restore(positionMs);
    if (sent) this.fault = `灯光已按播放位置恢复（发送 ${sent} 条），中间错过的事件不补发`;
  }
  tick(positionMs: number): void {
    const gap = this.ticked === null ? 0 : positionMs - this.ticked; this.ticked = positionMs;
    if (this.rebuild && this.local && gap > 100) {
      const sent = (this.networkEnabled ? this.network.restore(positionMs) : 0) + (this.scheduler?.restore(positionMs) ?? 0);
      this.fault = `灯光位置更新中断了 ${Math.round(gap)} ms，已按当前位置恢复（发送 ${sent} 条），中间错过的事件不补发`; return;
    }
    this.network.tick(positionMs); this.scheduler?.tick(positionMs);
  }
  takeFault(): string | null { const fault = this.fault; this.fault = null; return fault ?? this.network.takeFault(); }
  async release(): Promise<void> {
    const packets = this.releasePackets; this.releasePackets = [];
    for (const { output, packet } of packets) {
      if (output.state !== 'connected' || output.connection !== 'open') throw new Error('关闭灯光的 MIDI 消息没有发出：原来的播放端口已断开');
      output.send(packet.bytes);
    }
    this.carried = null; this.document = null; this.network.forget();
    await this.network.close(); await this.releaseOutput.release();
  }
  finish(positionMs: number): Promise<void> | void { this.scheduler?.finish(positionMs); if (this.networkEnabled) return this.network.finish(positionMs); }
  loop(startMs: number, endMs: number): void { this.network.loop(startMs, endMs); this.scheduler?.loop(startMs, endMs); }
  locate(positionMs: number): void { this.network.locate(positionMs); this.scheduler?.locate(positionMs); }
  stop(): void {
    if (this.scheduler && this.document) this.carried = { document: this.document, onAir: this.scheduler.onAir() };
    this.ticked = null; this.generation += 1; this.releaseOutput.cancelPreparation(); this.networkEnabled = false; this.network.stop(); this.scheduler?.stop(); this.scheduler = null; this.outputs.clear(); }
  private send(packet: LightingPacket): void {
    const port = this.outputs.get(packet.portProfileId);
    if (!port || port.state !== 'connected') throw new Error(`灯光输出已断开：${packet.portProfileId}`);
    port.send(packet.bytes);
  }
}
