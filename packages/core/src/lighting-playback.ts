import { hasIndependentLightingCues, lightingCueTarget, planLightingCueRuns } from './lighting-cue-run';
import { ma2PlaybackActionSchema, type Ma2PlaybackAction } from '@tb/schema';
import type { LightingClip, LightingDocument, LightingEvent, LightingTrack } from '@tb/schema';
import { LightingTempoMap, lightingEventTime, lightingCurveValue } from './lighting-edit';

export type LightingPacket = { atMs: number; portProfileId: string; bytes: number[]; noteKey: string | null; phase: 'on' | 'off' | 'control'; ma2Target?: string; ma2Off?: boolean; releaseOnlyIfStarted?: boolean; releasePrevious?: boolean };
/** Inspect connection dependencies without encoding events or expanding automation curves. */
export function collectLightingOutputProfileIds(document: LightingDocument): string[] {
  return [...new Set(selectedLightingTracks(document)
    .filter(track => track.clips.some(clip => !clip.muted && clip.events.some(event => event.kind !== 'empty-cue' && (document.outputMode !== 'network' || event.kind !== 'ma2'))))
    .map(track => track.portProfileId || 'lighting-events-output'))];
}
function activeLightingTracks(document: LightingDocument): LightingTrack[] {
  if (document.outputMode !== 'timecode' && document.ma2Bindings?.some(binding => binding.nativeEvents?.length || binding.playback === 'native-timecode')) throw new Error('原生保留时间线只能由控台按时间码播放，不能用本地部分事件替代');
  return selectedLightingTracks(document);
}
/** Rendering connection requirements must not validate or execute a playback route. */
function selectedLightingTracks(document: LightingDocument): LightingTrack[] {
  if (document.outputMode === 'timecode') return [];
  const solo = document.tracks.some(track => track.solo && !track.muted);
  return document.tracks.filter(track => !track.muted && (!solo || track.solo));
}
export function compileLightingPackets(document: LightingDocument, ma2DeviceId = 127): LightingPacket[] {
  if (!Number.isInteger(ma2DeviceId) || ma2DeviceId < 0 || ma2DeviceId > 127) throw new Error('MA2 MSC 设备号应为 0–127');
  if (document.outputMode === 'timecode') {
    if (document.tracks.some(track => !track.muted && track.clips.some(clip => !clip.muted && clip.events.some(event => event.kind === 'ma2' && event.preparation)))) throw new Error('埋步需要由软件发送准备 Cue，请选择网络直控或 MIDI 执行器触发');
    if (hasIndependentLightingCues(document)) throw new Error('单独运行需要由联动台关闭前一组 Cue，请选择网络直控或 MIDI 执行器触发；控台时间码不会执行此设置');
    return [];
  }
  const map = new LightingTempoMap(document.tempos);
  const packets: LightingPacket[] = [];
  const manageRuns = hasIndependentLightingCues(document);
  for (const sourceTrack of activeLightingTracks(document)) {
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
  if (document.outputMode === 'direct') for (const entry of planLightingCueRuns(document)) {
    const track = { ...entry.track, portProfileId: entry.track.portProfileId || 'lighting-events-output' };
    const encoded: LightingPacket[] = [];
    appendEvent(encoded, track, { id: '', name: '', start: 0, duration: 1, timeLock: 'time', muted: false, events: [] }, { ...entry.event, at: entry.atMs }, map, ma2DeviceId);
    // Every Cue names its executor so the state at any position can be rebuilt;
    // only independent runs release earlier Cues.
    for (const value of encoded) packets.push({ ...value, ma2Target: lightingCueTarget(entry.event, track, document.outputMode), ma2Off: entry.event.action === 'off',
      ...(manageRuns && entry.releaseOnlyIfStarted ? { releaseOnlyIfStarted: true } : {}), ...(manageRuns && entry.releasePrevious ? { releasePrevious: true } : {}) });
  }
  const rank = { off: 0, control: 1, on: 2 };
  return packets.sort((a, b) => a.atMs - b.atMs || rank[a.phase] - rank[b.phase]);
}
/** MSC Off uses the same explicitly mapped executor and port as this song. */
export function compileLightingReleasePackets(document: LightingDocument, ma2DeviceId = 127): LightingPacket[] {
  if (document.outputMode !== 'direct') return [];
  const tracks = activeLightingTracks(document).map(track => ({ ...track, clips: track.clips.filter(clip => !clip.muted).map(clip => ({ ...clip, start: 0, timeLock: 'time' as const,
    events: clip.events.filter(event => event.kind === 'ma2' && event.executor).map(event => {
      if (event.kind !== 'ma2') throw new Error('灯光关闭目标无效');
      return { ...event, at: 0, action: 'off' as const, cue: undefined, preparation: undefined, runMode: undefined };
    }) })) }));
  const packets = compileLightingPackets({ ...document, tracks }, ma2DeviceId);
  return [...new Map(packets.map(packet => [`${packet.portProfileId}:${packet.bytes.join(',')}`, packet])).values()];
}
function packet(track: LightingTrack, atMs: number, bytes: number[]): LightingPacket { return { atMs, portProfileId: track.portProfileId, bytes, noteKey: null, phase: 'control' }; }
function appendEvent(packets: LightingPacket[], track: LightingTrack, clip: LightingClip, event: LightingEvent, map: LightingTempoMap, ma2DeviceId: number): void {
  const atMs = lightingEventTime(clip, event, map); const channel = track.channel - 1;
  switch (event.kind) {
    case 'empty-cue': return;
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
      if (!event.executor) throw new Error('序列池 Cue 不能通过执行器 MIDI 触发，请在播放设置选择网络直控');
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

/** What the console keeps after a song's notes are released: executors on their
 * Cues and the last value of each controller. */
export type LightingOnAir = { started: ReadonlyMap<string, LightingPacket>; controls: ReadonlyMap<string, LightingPacket> };
type LightingState = { started: Map<string, LightingPacket>; active: Map<string, { packet: LightingPacket; count: number }>; controls: Map<string, LightingPacket> };

/** Controller and program changes hold a value; other control bytes are one-shot. */
function lightingControlKey(packet: LightingPacket): string | null {
  if (packet.phase !== 'control' || packet.ma2Target) return null;
  const status = (packet.bytes[0] ?? 0) & 0xf0;
  if (status === 0xb0) return `${packet.portProfileId}:${packet.bytes[0]}:${packet.bytes[1]}`;
  return status === 0xc0 ? `${packet.portProfileId}:${packet.bytes[0]}` : null;
}
function sameLightingBytes(left: LightingPacket | undefined, right: LightingPacket): boolean {
  return left !== undefined && left.bytes.length === right.bytes.length && left.bytes.every((value, index) => value === right.bytes[index]);
}
function ma2OffPacket(started: LightingPacket, atMs: number): LightingPacket {
  const separator = started.bytes.indexOf(0, 6);
  if (separator < 0) throw new Error('MA2 MSC 关闭目标编码无效');
  return { ...started, atMs, releasePrevious: false, releaseOnlyIfStarted: false, ma2Off: true, bytes: [...started.bytes.slice(0, 5), 0x0b, 48, 46, 48, 48, 48, 0, ...started.bytes.slice(separator + 1)] };
}

export class LightingScheduler {
  private cursor = 0;
  private readonly ma2Started = new Map<string, LightingPacket>();
  private previousMs: number | null = null;
  private readonly active = new Map<string, { packet: LightingPacket; count: number }>();
  private readonly controls = new Map<string, LightingPacket>();
  /** `onAir` is what an earlier scheduler of the same song left on the console. */
  constructor(private readonly packets: LightingPacket[], private readonly send: (packet: LightingPacket) => void, onAir?: LightingOnAir) {
    for (const [key, packet] of onAir?.started ?? []) this.ma2Started.set(key, packet);
    for (const [key, packet] of onAir?.controls ?? []) this.controls.set(key, packet);
  }
  /** Take before stop(): stop releases the notes, not executors or controller values. */
  onAir(): LightingOnAir { return { started: new Map(this.ma2Started), controls: new Map(this.controls) }; }
  /** Internal playback after a pause, seek or clock gap: move to `positionMs` and
   * send only what differs from the state the timeline prescribes there. Events
   * between are not replayed. Returns the number of packets sent. */
  restore(positionMs: number): number {
    if (!Number.isFinite(positionMs) || positionMs < 0) throw new Error('灯光定位位置无效');
    const cursor = this.firstAtOrAfter(positionMs), target = this.stateBefore(cursor);
    let sent = 0;
    const emit = (packet: LightingPacket): void => { this.send({ ...packet, atMs: positionMs }); sent += 1; };
    for (const [key, held] of this.active) if (!target.active.has(key)) {
      emit({ ...held.packet, phase: 'off', bytes: [0x80 | ((held.packet.bytes[0] ?? 0) & 15), held.packet.bytes[1] ?? 0, 0] }); this.active.delete(key);
    }
    for (const [key, held] of target.active) {
      if (!this.active.has(key)) emit(held.packet);
      this.active.set(key, held);
    }
    for (const [key, started] of this.ma2Started) if (!target.started.has(key)) { emit(ma2OffPacket(started, positionMs)); this.ma2Started.delete(key); }
    for (const [key, packet] of target.started) if (!sameLightingBytes(this.ma2Started.get(key), packet)) { emit(packet); this.ma2Started.set(key, packet); }
    for (const [key, packet] of target.controls) if (!sameLightingBytes(this.controls.get(key), packet)) { emit(packet); this.controls.set(key, packet); }
    this.cursor = cursor; this.previousMs = positionMs;
    return sent;
  }
  locate(positionMs: number): void {
    if (!Number.isFinite(positionMs) || positionMs < 0) throw new Error('灯光定位位置无效');
    this.release(); this.ma2Started.clear();
    this.cursor = this.firstAtOrAfter(positionMs); this.previousMs = positionMs;
  }
  private firstAtOrAfter(positionMs: number): number {
    let low = 0; let high = this.packets.length;
    while (low < high) { const mid = (low + high) >>> 1; if ((this.packets[mid]?.atMs ?? Infinity) < positionMs) low = mid + 1; else high = mid; }
    return low;
  }
  /** The bookkeeping of advance(), replayed over the packets before `cursor` without sending. */
  private stateBefore(cursor: number): LightingState {
    const state: LightingState = { started: new Map(), active: new Map(), controls: new Map() };
    for (const event of this.packets.slice(0, cursor)) {
      if (event.releasePrevious) state.started.clear();
      if (event.releaseOnlyIfStarted && event.ma2Target && !state.started.has(event.ma2Target)) continue;
      if (event.noteKey && event.phase === 'off') {
        const current = state.active.get(event.noteKey);
        if (current && current.count === 1) state.active.delete(event.noteKey); else if (current) current.count -= 1;
        continue;
      }
      if (event.ma2Target) { if (event.ma2Off) state.started.delete(event.ma2Target); else state.started.set(event.ma2Target, event); }
      if (event.noteKey && event.phase === 'on') state.active.set(event.noteKey, { packet: event, count: (state.active.get(event.noteKey)?.count ?? 0) + 1 });
      const control = lightingControlKey(event);
      if (control) state.controls.set(control, event);
    }
    return state;
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
    const started = new Map(this.ma2Started);
    this.locate(startMs);
    for (const [key, packet] of started) this.ma2Started.set(key, packet);
  }
  private advance(positionMs: number, exclusive: boolean): void {
    if (!Number.isFinite(positionMs) || positionMs < 0) throw new Error('灯光播放位置无效');
    if (this.previousMs === null) this.locate(positionMs);
    if (this.previousMs !== null && positionMs < this.previousMs) this.locate(positionMs);
    this.previousMs = positionMs;
    while (this.cursor < this.packets.length) {
      const event = this.packets[this.cursor]; if (!event || event.atMs > positionMs || (exclusive && event.atMs === positionMs)) break;
      if (event.releasePrevious) for (const [key, started] of this.ma2Started) {
        this.send(ma2OffPacket(started, event.atMs));
        this.ma2Started.delete(key);
      }
      if (event.releaseOnlyIfStarted && event.ma2Target && !this.ma2Started.has(event.ma2Target)) { this.cursor += 1; continue; }
      if (event.noteKey && event.phase === 'off') {
        const current = this.active.get(event.noteKey);
        if (current && current.count === 1) { this.send(event); this.active.delete(event.noteKey); }
        else if (current) current.count -= 1;
      } else {
        this.send(event);
        if (event.ma2Target) { if (event.ma2Off) this.ma2Started.delete(event.ma2Target); else this.ma2Started.set(event.ma2Target, event); }
        if (event.noteKey && event.phase === 'on') this.active.set(event.noteKey, { packet: event, count: (this.active.get(event.noteKey)?.count ?? 0) + 1 });
        const control = lightingControlKey(event);
        if (control) this.controls.set(control, event);
      }
      this.cursor += 1;
    }
  }
  stop(): void { this.release(); this.ma2Started.clear(); this.controls.clear(); this.previousMs = null; this.cursor = 0; }
  private release(): void {
    const failures: unknown[] = [];
    for (const [key, active] of this.active) {
      try { this.send({ ...active.packet, atMs: this.previousMs ?? active.packet.atMs, phase: 'off', bytes: [0x80 | ((active.packet.bytes[0] ?? 0) & 15), active.packet.bytes[1] ?? 0, 0] }); this.active.delete(key); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, '灯光音符释放失败');
  }
}

export type LightingNetworkAction = { atMs: number; action: Ma2PlaybackAction; releaseOnlyIfStarted?: boolean; releasePrevious?: boolean };
/** Timecode carries the song clock; local pool events are not an additional MA2 command channel. */
export function lightingTimecodePlaybackNotice(document: LightingDocument): string | null {
  if (document.outputMode !== 'timecode') return null;
  const solo = document.tracks.some(track => track.solo && !track.muted);
  const hasPoolCue = document.tracks.some(track => !track.muted && (!solo || track.solo)
    && track.clips.some(clip => !clip.muted && clip.events.some(event => event.kind === 'ma2' && !event.executor)));
  return hasPoolCue ? '音乐照常播放，时间码按开关设置输出；本地序列池 Cue 不会单独发送。请确认该 Cue 已编排在控台原生时间线。' : null;
}
export function compileLightingNetworkActions(document: LightingDocument): LightingNetworkAction[] {
  if (document.outputMode !== 'network') return [];
  activeLightingTracks(document);
  return planLightingCueRuns(document).map(({ atMs, event, releaseOnlyIfStarted, releasePrevious }) => ({ atMs,
    action: ma2PlaybackActionSchema.parse(event.executor ? { target: 'executor', executor: event.executor, action: event.action, ...(event.cue ? { cue: event.cue } : {}) } : { target: 'sequence', sequence: event.sequence, cue: event.cue, action: event.action }),
    ...(releaseOnlyIfStarted ? { releaseOnlyIfStarted: true } : {}), ...(releasePrevious ? { releasePrevious: true } : {})
  }));
}
