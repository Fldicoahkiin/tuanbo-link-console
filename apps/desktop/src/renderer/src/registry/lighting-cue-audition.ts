import { compileLightingPackets } from '@tb/core/link';
import type { IntegrationProfile, LightingDocument } from '@tb/schema';

/** Explicit operator selection only; never called when restoring editor selection. */
export class LightingCueAudition {
  private generation = 0;
  cancel(): void { this.generation += 1; }

  async play(document: LightingDocument, eventId: string, profile: IntegrationProfile | null): Promise<number> {
    const generation = ++this.generation;
    const selected = document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events)).find(event => event.id === eventId);
    if (!selected || selected.kind !== 'ma2') return 0;
    const group = selected.effectGroupId ?? selected.id;
    const preview: LightingDocument = { ...document, outputMode: 'direct', tracks: document.tracks.map(track => ({
      ...track, muted: false, solo: false,
      clips: track.clips.map(clip => ({ ...clip, muted: false, start: 0, timeLock: 'time', events: clip.events.filter(event => event.kind === 'ma2' && (event.id === group || event.effectGroupId === group)).map(event => ({ ...event, at: 0 })) }))
    })) };
    const packets = compileLightingPackets(preview, profile?.lighting?.mscDeviceId ?? 127);
    try {
      const access = await deadline(navigator.requestMIDIAccess({ sysex: true }), 'MIDI 访问超时');
      if (generation !== this.generation) return 0;
      const outputs = new Map<string, MIDIOutput>();
      for (const id of new Set(packets.map(packet => packet.portProfileId))) {
        const name = profile?.midiPortProfiles.find(port => port.id === id && port.direction === 'output')?.portName;
        const matches = [...access.outputs.values()].filter(port => port.name === name && port.state === 'connected');
        const port = matches[0];
        if (!port || matches.length !== 1) throw new Error(`Cue MIDI 输出不可用或不唯一：${name || '请先一键连接或配置灯光动作输出'}`);
        await deadline(port.open(), 'Cue MIDI 端口打开超时');
        if (generation !== this.generation) return 0;
        outputs.set(id, port);
      }
      for (const packet of packets) {
        const output = outputs.get(packet.portProfileId);
        if (!output || output.state !== 'connected') throw new Error('Cue 发送中断：MIDI 端口已断开，部分动作可能已发送');
        output.send(packet.bytes);
      }
      return packets.length;
    } catch (error) {
      if (generation !== this.generation) return 0;
      throw error;
    }
  }
}

async function deadline<T>(operation: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), 5000); })]);
  } finally { clearTimeout(timer); }
}
