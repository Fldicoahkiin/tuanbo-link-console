import type { LightingClip, LightingDocument, LightingEvent, LightingTrack } from '@tb/schema';
import { LightingTempoMap, lightingEventTime, lightingCurveValue } from './lighting-edit';

export type LightingPacket = { atMs: number; portProfileId: string; bytes: number[]; noteKey: string | null; phase: 'on' | 'off' | 'control' };
export function compileLightingPackets(document: LightingDocument, ma2DeviceId = 127): LightingPacket[] {
  if (!Number.isInteger(ma2DeviceId) || ma2DeviceId < 0 || ma2DeviceId > 127) throw new Error('MA2 MSC 设备号应为 0–127');
  if (document.outputMode === 'timecode') return [];
  const map = new LightingTempoMap(document.tempos);
  const solo = document.tracks.some((track) => track.solo && !track.muted);
  const packets: LightingPacket[] = [];
  for (const sourceTrack of document.tracks) {
    // An empty per-track selection explicitly means the configured default lighting output.
    const track = sourceTrack.portProfileId ? sourceTrack : { ...sourceTrack, portProfileId: 'lighting-events-output' };
    if (track.muted || (solo && !track.solo)) continue;
    for (const clip of track.clips) {
      if (clip.muted || !clip.events.length) continue;
      for (const event of clip.events) appendEvent(packets, track, clip, event, map, ma2DeviceId);
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
  const rank = { off: 0, control: 1, on: 2 };
  return packets.sort((a, b) => a.atMs - b.atMs || rank[a.phase] - rank[b.phase]);
}
function packet(track: LightingTrack, atMs: number, bytes: number[]): LightingPacket { return { atMs, portProfileId: track.portProfileId, bytes, noteKey: null, phase: 'control' }; }
function appendEvent(packets: LightingPacket[], track: LightingTrack, clip: LightingClip, event: LightingEvent, map: LightingTempoMap, ma2DeviceId: number): void {
  const atMs = lightingEventTime(clip, event, map); const channel = track.channel - 1;
  switch (event.kind) {
    case 'ma2-fader': throw new Error('MA2 原生推杆请同步到控台 Timecode 播放，不能通过 MIDI CC 代发');
    case 'raw': packets.push(packet(track, atMs, event.bytes)); return;
    case 'note': {
      const noteKey = `${track.portProfileId}:${channel}:${event.note}`;
      packets.push({ ...packet(track, atMs, [0x90 + channel, event.note, event.velocity]), noteKey, phase: 'on' });
      const endMs = lightingEventTime(clip, { ...event, at: event.at + event.duration }, map);
      packets.push({ ...packet(track, endMs, [0x80 + channel, event.note, event.releaseVelocity ?? 0]), noteKey, phase: 'off' }); return;
    }
    case 'cc': packets.push(packet(track, atMs, [0xb0 + channel, event.controller, event.value])); return;
    case 'program': packets.push(packet(track, atMs, [0xc0 + channel, event.program])); return;
    case 'point': packets.push(packet(track, atMs, [0xb0 + channel, track.controller, Math.round(event.value)])); return;
    case 'ma2': {
      // MA2 interprets MSC GO as Goto, not the console's next-cue action.
      if (event.action === 'go') throw new Error('MA2 MIDI 直控不支持“播放控台下一步”；请使用指定 Cue，或通过控台 Timecode 执行下一步');
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

export class LightingScheduler {
  private cursor = 0;
  private previousMs: number | null = null;
  private readonly active = new Map<string, { packet: LightingPacket; count: number }>();
  constructor(private readonly packets: LightingPacket[], private readonly send: (packet: LightingPacket) => void) {}
  locate(positionMs: number): void {
    if (!Number.isFinite(positionMs) || positionMs < 0) throw new Error('灯光定位位置无效');
    this.release();
    let low = 0; let high = this.packets.length;
    while (low < high) { const mid = (low + high) >>> 1; if ((this.packets[mid]?.atMs ?? Infinity) < positionMs) low = mid + 1; else high = mid; }
    this.cursor = low; this.previousMs = positionMs;
  }
  tick(positionMs: number): void { this.advance(positionMs, false); }
  finish(positionMs: number): void {
    if (!Number.isFinite(positionMs) || positionMs < 0) throw new Error('灯光结束位置无效');
    // Playback ranges are [start, end); flush the tail before releasing held notes.
    if (this.previousMs !== null) this.advance(positionMs, true);
    this.stop();
  }
  loop(startMs: number, endMs: number): void {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs) throw new Error('灯光循环范围无效');
    // Flush the last polling interval, keeping the loop range [start, end).
    this.advance(endMs, true);
    this.locate(startMs);
  }
  private advance(positionMs: number, exclusive: boolean): void {
    if (!Number.isFinite(positionMs) || positionMs < 0) throw new Error('灯光播放位置无效');
    if (this.previousMs === null) this.locate(positionMs);
    if (this.previousMs !== null && positionMs < this.previousMs) this.locate(positionMs);
    this.previousMs = positionMs;
    while (this.cursor < this.packets.length) {
      const event = this.packets[this.cursor]; if (!event || event.atMs > positionMs || (exclusive && event.atMs === positionMs)) break;
      if (event.noteKey && event.phase === 'off') {
        const current = this.active.get(event.noteKey);
        if (current && current.count === 1) { this.send(event); this.active.delete(event.noteKey); }
        else if (current) current.count -= 1;
      } else {
        this.send(event);
        if (event.noteKey && event.phase === 'on') this.active.set(event.noteKey, { packet: event, count: (this.active.get(event.noteKey)?.count ?? 0) + 1 });
      }
      this.cursor += 1;
    }
  }
  stop(): void { this.release(); this.previousMs = null; this.cursor = 0; }
  private release(): void {
    const failures: unknown[] = [];
    for (const [key, active] of this.active) {
      try { this.send({ ...active.packet, phase: 'off', bytes: [0x80 | ((active.packet.bytes[0] ?? 0) & 15), active.packet.bytes[1] ?? 0, 0] }); this.active.delete(key); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, '灯光音符释放失败');
  }
}
