import { planLightingCueRuns } from './lighting-cue-run';
import { ma2PlaybackActionSchema, type Ma2PlaybackAction } from '@tb/schema';
import type { LightingClip, LightingDocument, LightingEvent, LightingTrack } from '@tb/schema';
import { LightingTempoMap, lightingEventTime, lightingCurveValue } from './lighting-edit';

/*
 * 2026-11-01 the user removed the 'direct' (MIDI) and 'network' lighting playback modes: a playing song only
 * sends MIDI timecode and the console's Timecode show runs the lighting. The timeline is never sent from here
 * while a song plays. These compilers remain for what still sends Cues on purpose: a click to audition a Cue
 * and the MIDI file export.
 */
export type LightingPacket = { atMs: number; portProfileId: string; bytes: number[]; phase: 'on' | 'off' | 'control' };
/** The tracks that sound: unmuted, and only the soloed ones when any is soloed. */
function selectedLightingTracks(document: LightingDocument): LightingTrack[] {
  if (document.ma2Bindings?.some(binding => binding.nativeEvents?.length || binding.playback === 'native-timecode')) throw new Error('保持控台原样的时间线只能由控台按时间码播放，不能用本地的部分事件代替');
  const solo = document.tracks.some(track => track.solo && !track.muted);
  return document.tracks.filter(track => !track.muted && (!solo || track.solo));
}
export function compileLightingPackets(document: LightingDocument, ma2DeviceId = 127): LightingPacket[] {
  if (!Number.isInteger(ma2DeviceId) || ma2DeviceId < 0 || ma2DeviceId > 127) throw new Error('MA2 MSC 设备号应为 0–127');
  const map = new LightingTempoMap(document.tempos);
  const packets: LightingPacket[] = [];
  for (const sourceTrack of selectedLightingTracks(document)) {
    // An empty per-track selection explicitly means the configured default lighting output.
    const track = sourceTrack.portProfileId ? sourceTrack : { ...sourceTrack, portProfileId: 'lighting-events-output' };
    for (const clip of track.clips) {
      if (clip.muted || !clip.events.length) continue;
      for (const event of clip.events.filter(event => event.kind !== 'empty-cue' && event.kind !== 'ma2')) {
        appendEvent(packets, track, clip, event, map, ma2DeviceId);
      }
      const points = clip.events.filter((event) => event.kind === 'point').sort((a, b) => a.at - b.at);
      for (let index = 0; index + 1 < points.length; index += 1) {
        const from = points[index]; const to = points[index + 1];
        if (!from || !to || from.shape === 'hold') continue;
        const startMs = lightingEventTime(clip, from, map); const endMs = lightingEventTime(clip, to, map);
        let previous = Math.round(from.value);
        for (let atMs = startMs + 40; atMs < endMs; atMs += 40) {
          const position = clip.timeLock === 'time' ? atMs - clip.start : map.msToBeat(atMs) - clip.start;
          const t = (position - from.at) / (to.at - from.at);
          const value = Math.round(lightingCurveValue(from, to, t));
          if (value !== previous) packets.push(packet(track, atMs, [0xb0 + track.channel - 1, track.controller, value]));
          previous = value;
        }
      }
    }
  }
  for (const entry of planLightingCueRuns(document)) {
    const track = { ...entry.track, portProfileId: entry.track.portProfileId || 'lighting-events-output' };
    appendEvent(packets, track, { id: '', name: '', start: 0, duration: 1, timeLock: 'time', muted: false, events: [] }, { ...entry.event, at: entry.atMs }, map, ma2DeviceId);
  }
  const rank = { off: 0, control: 1, on: 2 };
  return packets.sort((a, b) => a.atMs - b.atMs || rank[a.phase] - rank[b.phase]);
}
function packet(track: LightingTrack, atMs: number, bytes: number[]): LightingPacket { return { atMs, portProfileId: track.portProfileId, bytes, phase: 'control' }; }
function appendEvent(packets: LightingPacket[], track: LightingTrack, clip: LightingClip, event: LightingEvent, map: LightingTempoMap, ma2DeviceId: number): void {
  const atMs = lightingEventTime(clip, event, map); const channel = track.channel - 1;
  switch (event.kind) {
    case 'empty-cue': return;
    case 'ma2-fader': throw new Error('MA2 控台原有的推杆请同步到控台 Timecode 播放，不能用 MIDI CC 代发');
    case 'raw': packets.push(packet(track, atMs, event.bytes)); return;
    case 'note': {
      packets.push({ ...packet(track, atMs, [0x90 + channel, event.note, event.velocity]), phase: 'on' });
      const endMs = lightingEventTime(clip, { ...event, at: event.at + event.duration }, map);
      packets.push({ ...packet(track, endMs, [0x80 + channel, event.note, event.releaseVelocity ?? 0]), phase: 'off' }); return;
    }
    case 'cc': packets.push(packet(track, atMs, [0xb0 + channel, event.controller, event.value])); return;
    case 'program': packets.push(packet(track, atMs, [0xc0 + channel, event.program])); return;
    case 'point': packets.push(packet(track, atMs, [0xb0 + channel, track.controller, Math.round(event.value)])); return;
    case 'ma2': {
      // MA2 interprets MSC GO as Goto, not the console's next-cue action.
      if (event.action === 'go') throw new Error('MIDI 发不了“播放控台下一步”，请改成指定 Cue');
      if (!event.executor) throw new Error('序列池里的 Cue 没有绑定执行器，不能用 MIDI 发送');
      const [page, executor] = event.executor.split('.');
      if (!page || !executor || !/^[1-9]\d*$/.test(page) || !/^[1-9]\d*$/.test(executor)) throw new Error('MA2 执行器必须为有效的页.编号');
      const [whole, fraction = ''] = (event.cue ?? '').split('.');
      if (event.action === 'goto' && (!whole || !/^\d+$/.test(whole) || !/^\d{0,3}$/.test(fraction))) throw new Error('MA2 Cue 编号最多支持三位小数');
      const cue = event.action === 'off' ? '0.000' : `${whole}.${fraction.padEnd(3, '0')}`;
      // The UI uses Page.Executor; MA2 MSC's Exec.Page setting reverses it.
      const bytes = [...`${cue}\0${executor}.${page}`].map((char) => char.charCodeAt(0));
      packets.push(packet(track, atMs, [0xf0, 0x7f, ma2DeviceId, 0x02, 0x01, event.action === 'off' ? 0x0b : 0x01, ...bytes, 0xf7])); return;
    }
  }
}

export type LightingNetworkAction = { atMs: number; action: Ma2PlaybackAction };
export function compileLightingNetworkActions(document: LightingDocument): LightingNetworkAction[] {
  selectedLightingTracks(document);
  return planLightingCueRuns(document).map(({ atMs, event }) => ({ atMs,
    action: ma2PlaybackActionSchema.parse(event.executor ? { target: 'executor', executor: event.executor, action: event.action, ...(event.cue ? { cue: event.cue } : {}) } : { target: 'sequence', sequence: event.sequence, cue: event.cue, action: event.action })
  }));
}
