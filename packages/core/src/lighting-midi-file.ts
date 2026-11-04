import { parseMidi, type MidiEvent } from 'midi-file';
import { z } from 'zod';
import { createLightingDocument, lightingDocumentSchema, type LightingDocument, type LightingEvent, type LightingTempo, type LightingTrack } from '@tb/schema';
import { LightingTempoMap, lightingEventTime } from './lighting-edit';
import { compileLightingPackets } from './lighting-playback';
import { isLightingTempoMetadata, lightingMidiConductor, restoreLightingMidiTempo } from './lighting-midi-tempo';
import { writeLightingMidi } from './lighting-midi-writer';

export type LightingImport = { document: LightingDocument; warnings: string[] };
// SMF has point markers but no regions. A sequencer-specific extension follows
// each region's ordinary marker, so other MIDI readers still see its start.
const regionPrefix = [0x7d, ...new TextEncoder().encode('TBLINK:REGION:')];
const regionMetadataSchema = z.object({ version: z.literal(1), name: z.string(), endBeat: z.number().finite().nonnegative() }).strict();
export function importLightingMidi(bytes: Uint8Array): LightingImport {
  if (bytes.length > 32 * 1024 * 1024) throw new Error('MIDI 文件超过 32 MB');
  const midi = parseMidi(bytes);
  if (midi.header.format === 2) throw new Error('暂不支持 MIDI Format 2 独立序列，请导出为 Format 1');
  const ppq = midi.header.ticksPerBeat;
  if (!ppq) throw new Error('请使用按节拍计时的 MIDI 文件，当前文件为 SMPTE 分帧格式');
  const document = createLightingDocument();
  const warnings = new Set<string>();
  const timedTracks = midi.tracks.map((events) => { let tick = 0; return events.map((event) => { tick += event.deltaTime; return { beat: tick / ppq, event }; }); });
  const tempoEvents = timedTracks.flat().filter(({ event }) => event.type === 'setTempo' || event.type === 'timeSignature').sort((a, b) => a.beat - b.beat);
  let current: LightingTempo = { beat: 0, bpm: 120, numerator: 4, denominator: 4 };
  const tempos = new Map<number, LightingTempo>([[0, current]]);
  for (const { beat, event } of tempoEvents) {
    if (event.type === 'setTempo') current = { ...current, beat, bpm: 60000000 / event.microsecondsPerBeat };
    if (event.type === 'timeSignature') {
      if (![1, 2, 4, 8, 16].includes(event.denominator)) throw new Error('MIDI 拍号分母不支持');
      current = { ...current, beat, numerator: event.numerator, denominator: event.denominator as LightingTempo['denominator'] };
    }
    tempos.set(beat, current);
  }
  document.tempos = restoreLightingMidiTempo(timedTracks.flat().sort((a, b) => a.beat - b.beat), [...tempos.values()], warnings).map((tempo) => {
    if (tempo.bpm !== 60000000 / Math.round(60000000 / 999)) return tempo;
    warnings.add('MIDI 的 999 BPM 因整数微秒舍入略超上限，已还原为 999 BPM');
    return { ...tempo, bpm: 999 };
  });
  const map = new LightingTempoMap(document.tempos);
  for (const [trackIndex, timed] of timedTracks.entries()) {
    const trackNameEvent = timed.find(({ event }) => event.type === 'trackName')?.event;
    const name = trackNameEvent?.type === 'trackName' ? decodeText(trackNameEvent.text) : `MIDI ${trackIndex + 1}`;
    const tracks = new Map<number, LightingTrack>();
    const pending = new Map<string, Array<{ at: number; velocity: number }>>();
    const get = (channel: number): LightingTrack => {
      let track = tracks.get(channel);
      if (!track) {
        track = { id: crypto.randomUUID(), name: `${name} · Ch ${channel + 1}`, kind: 'midi', color: '#52b5dd', group: name, muted: false, solo: false, locked: false, channel: channel + 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: crypto.randomUUID(), name, start: 0, duration: Math.max(0.001, (timed.at(-1)?.beat ?? 0) + 0.001), timeLock: 'beat', muted: false, events: [] }] };
        tracks.set(channel, track);
      }
      return track;
    };
    const add = (channel: number, event: LightingEvent): void => { get(channel).clips[0]?.events.push(event); };
    for (const [eventIndex, { beat, event }] of timed.entries()) {
      const id = crypto.randomUUID();
      const channel = 'channel' in event ? event.channel : 0;
      switch (event.type) {
        case 'noteOn': case 'noteOff': {
          const key = `${channel}:${event.noteNumber}`;
          if (event.type === 'noteOn' && event.velocity > 0) { const list = pending.get(key) ?? []; list.push({ at: beat, velocity: event.velocity }); pending.set(key, list); }
          else {
            const opened = pending.get(key)?.shift();
            if (opened && beat > opened.at) add(channel, { id, kind: 'note', at: opened.at, duration: beat - opened.at, note: event.noteNumber, velocity: opened.velocity, ...(event.velocity > 0 ? { releaseVelocity: event.velocity } : {}) });
            else warnings.add('文件里有没配对或长度为零的音符，没有转换');
          }
          break;
        }
        case 'controller': add(channel, { id, kind: 'cc', at: beat, controller: event.controllerType, value: event.value }); break;
        case 'programChange': add(channel, { id, kind: 'program', at: beat, program: event.programNumber }); break;
        case 'pitchBend': { const value = event.value + 8192; add(channel, { id, kind: 'raw', at: beat, label: 'Pitch Bend', bytes: [0xe0 + channel, value & 127, value >> 7] }); break; }
        case 'channelAftertouch': add(channel, { id, kind: 'raw', at: beat, label: 'Channel Pressure', bytes: [0xd0 + channel, event.amount] }); break;
        case 'noteAftertouch': add(channel, { id, kind: 'raw', at: beat, label: 'Note Pressure', bytes: [0xa0 + channel, event.noteNumber, event.amount] }); break;
        case 'sysEx': add(channel, { id, kind: 'raw', at: beat, label: 'SysEx / MSC', bytes: [0xf0, ...Array.from(event.data)] }); break;
        case 'marker': case 'cuePoint': document.markers.push({ id, name: decodeText(event.text), startMs: map.beatToMs(beat), endMs: null }); break;
        case 'sequencerSpecific': {
          if (isLightingTempoMetadata(event)) break;
          const data = Array.from(event.data);
          if (!regionPrefix.every((byte, index) => data[index] === byte)) { warnings.add('未转换 MIDI 元数据或事件：sequencerSpecific'); break; }
          let metadata: z.infer<typeof regionMetadataSchema>;
          try { metadata = regionMetadataSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(data.slice(regionPrefix.length))))); }
          catch { throw new Error('MIDI 区域扩展数据损坏或版本不支持'); }
          const previous = timed[eventIndex - 1];
          const marker = document.markers.at(-1);
          if (previous?.event.type !== 'marker' || previous.beat !== beat || decodeText(previous.event.text) !== metadata.name || !marker || metadata.endBeat <= beat) throw new Error('MIDI 区域扩展缺少对应起点或结束时间无效');
          marker.endMs = map.beatToMs(metadata.endBeat);
          break;
        }
        case 'setTempo': case 'timeSignature': case 'endOfTrack': case 'trackName': break;
        default: warnings.add(`未转换 MIDI 元数据或事件：${event.type}`);
      }
    }
    if ([...pending.values()].some((list) => list.length)) throw new Error('MIDI 含缺少 Note Off 的音符，请修正后导入');
    document.tracks.push(...tracks.values());
  }
  return { document: lightingDocumentSchema.parse(document), warnings: [...warnings] };
}

export function exportLightingMidi(document: LightingDocument): Uint8Array {
  const map = new LightingTempoMap(document.tempos); const ppq = 960;
  const tempoConductor = lightingMidiConductor(document.tempos, ppq);
  const tempoMetadata = tempoConductor.filter(({ event }) => isLightingTempoMetadata(event));
  const conductor = tempoConductor.filter(({ event }) => !isLightingTempoMetadata(event));
  for (const marker of document.markers) {
    const tick = Math.round(map.msToBeat(marker.startMs) * ppq);
    conductor.push({ tick, event: { deltaTime: 0, type: 'marker', text: encodeText(marker.name) } });
    if (marker.endMs !== null) {
      const endBeat = Math.max((tick + 1) / ppq, Math.round(map.msToBeat(marker.endMs) * ppq) / ppq);
      const data = [...regionPrefix, ...new TextEncoder().encode(JSON.stringify({ version: 1, name: marker.name, endBeat }))];
      conductor.push({ tick, event: { deltaTime: 0, type: 'sequencerSpecific', data } });
    }
  }
  const tracks = [deltaTrack(conductor)];
  for (const track of document.tracks) {
    const events: Array<{ tick: number; event: MidiEvent }> = [{ tick: 0, event: { deltaTime: 0, type: 'trackName', text: encodeText(track.name) } }];
    const channel = track.channel - 1;
    for (const clip of track.clips) for (const event of clip.events) {
      const tick = Math.round(map.msToBeat(lightingEventTime(clip, event, map)) * ppq);
      switch (event.kind) {
        case 'note': {
          // A positive duration must survive rounding to the file's tick grid.
          const endTick = Math.max(tick + 1, Math.round(map.msToBeat(lightingEventTime(clip, { ...event, at: event.at + event.duration }, map)) * ppq));
          events.push({ tick, event: { deltaTime: 0, type: 'noteOn', channel, noteNumber: event.note, velocity: event.velocity } });
          events.push({ tick: endTick, event: { deltaTime: 0, type: 'noteOff', channel, noteNumber: event.note, velocity: event.releaseVelocity ?? 0 } });
          break;
        }
        case 'cc': events.push({ tick, event: { deltaTime: 0, type: 'controller', channel, controllerType: event.controller, value: event.value } }); break;
        case 'program': events.push({ tick, event: { deltaTime: 0, type: 'programChange', channel, programNumber: event.program } }); break;
        case 'raw': {
          const status = event.bytes[0] ?? 0; const a = event.bytes[1] ?? 0; const b = event.bytes[2] ?? 0;
          if (status === 0xf0) events.push({ tick, event: { deltaTime: 0, type: 'sysEx', data: event.bytes.slice(1) } });
          else if ((status & 0xf0) === 0xe0) events.push({ tick, event: { deltaTime: 0, type: 'pitchBend', channel: status & 15, value: (a | b << 7) - 8192 } });
          else if ((status & 0xf0) === 0xd0) events.push({ tick, event: { deltaTime: 0, type: 'channelAftertouch', channel: status & 15, amount: a } });
          else if ((status & 0xf0) === 0xa0) events.push({ tick, event: { deltaTime: 0, type: 'noteAftertouch', channel: status & 15, noteNumber: a, amount: b } });
          else throw new Error('有暂时不能导出的原始 MIDI 消息');
          break;
        }
        case 'ma2-fader': throw new Error('MIDI 文件无法保存 MA2 控台原有的推杆，请导出灯光工程');
        case 'ma2': case 'point': break;
      }
    }
    const controlTrack = { ...track, muted: false, solo: false, portProfileId: 'file-export', clips: track.clips.map((clip) => ({ ...clip, muted: false, events: clip.events.filter((event) => event.kind === 'ma2' || event.kind === 'point') })) };
    const controls = compileLightingPackets({ ...document, tracks: [controlTrack] });
    for (const control of controls) {
      const tick = Math.round(map.msToBeat(control.atMs) * ppq);
      if (control.bytes[0] === 0xf0) events.push({ tick, event: { deltaTime: 0, type: 'sysEx', data: control.bytes.slice(1) } });
      else events.push({ tick, event: { deltaTime: 0, type: 'controller', channel, controllerType: control.bytes[1] ?? 0, value: control.bytes[2] ?? 0 } });
    }
    tracks.push(deltaTrack(events));
  }
  // Keep the potentially large original tempo model in its own track. The SMF
  // writer otherwise copies that payload on every variable-length delta write.
  if (tempoMetadata.length) tracks.push(deltaTrack(tempoMetadata));
  return writeLightingMidi(tracks, ppq);
}
function deltaTrack(input: Array<{ tick: number; event: MidiEvent }>): MidiEvent[] {
  let previous = 0;
  const events = input.sort((a, b) => a.tick - b.tick || Number(b.event.type === 'noteOff') - Number(a.event.type === 'noteOff')).map(({ tick, event }) => { const next = { ...event, deltaTime: tick - previous }; previous = tick; return next; });
  return [...events, { deltaTime: 0, type: 'endOfTrack' }];
}
function encodeText(text: string): string { return Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join(''); }
function decodeText(text: string): string { return new TextDecoder().decode(Uint8Array.from(text, (char) => char.charCodeAt(0))); }

