import { createLightingMusic, lightingDocumentSchema, type LightingClip, type LightingDocument, type LightingEvent, type LightingMusic, type LightingTempo } from '@tb/schema';
import { firstTimecodeTrack, isWorkbenchCue } from './ma2-track-routing';
import { MA2_FRAME_MS } from './ma2-time-origin';
import { lightingTrackEnabled } from './lighting-track-state';
import { LightingTempoMap, lightingEventTime } from './lighting-edit';

export const MUSIC_GRID_CHOICES = [0.25, 0.5, 1, 2, 4, 8, 16, 32];
export type CuePositionChange = { id: string; name: string; fromMs: number; toMs: number };
export function musicBeatToMs(document: LightingDocument, beat: number): number { return (document.music?.firstBeatMs ?? 0) + new LightingTempoMap(document.tempos).beatToMs(beat); }
export function musicMsToBeat(document: LightingDocument, ms: number): number {
  const origin = document.music?.firstBeatMs ?? 0;
  if (ms < origin) throw new Error('此位置在第一拍之前，请使用固定时间');
  return new LightingTempoMap(document.tempos).msToBeat(ms - origin);
}
export function snapMusicTime(document: LightingDocument, ms: number): number {
  const music = document.music ?? createLightingMusic();
  if (ms < music.firstBeatMs) return ms;
  const grid = music.gridBeats * (music.triplet ? 1 / 3 : 1);
  const index = musicMsToBeat(document, ms) / grid;
  const beat = (music.align === 'previous' ? Math.floor(index + 1e-9) : music.align === 'next' ? Math.ceil(index - 1e-9) : Math.round(index)) * grid;
  return musicBeatToMs(document, beat);
}

/** Only the visible interval is generated. Coarse zoom decimates display, never the snap grid. */
export function musicGrid(document: LightingDocument, startMs: number, endMs: number, minimumSpacingMs = 0): { ms: number; bar: boolean; label: string }[] {
  const music = document.music ?? createLightingMusic(); const map = new LightingTempoMap(document.tempos);
  const result: { ms: number; bar: boolean; label: string }[] = [];
  if (endMs < music.firstBeatMs || !music.showGrid) return result;
  const startBeat = map.msToBeat(Math.max(0, startMs - music.firstBeatMs)); const endBeat = map.msToBeat(Math.max(0, endMs - music.firstBeatMs));
  let step = music.gridBeats * (music.triplet ? 1 / 3 : 1);
  const rate = Math.max(...document.tempos.map(tempo => tempo.bpm));
  step *= Math.max(1, Math.ceil(minimumSpacingMs / (60000 / rate * step)), Math.ceil((endBeat - startBeat) / step / 2000));
  for (let index = Math.ceil(startBeat / step); index * step <= endBeat; index++) {
    const beat = index * step; const value = musicBarPosition(document.tempos, beat);
    result.push({ ms: music.firstBeatMs + map.beatToMs(beat), bar: value.first, label: `${value.bar}:${Number(value.beat.toFixed(2))}` });
  }
  if (music.accentBars) {
    const meters = document.tempos.filter((tempo, index) => index === 0 || tempo.numerator !== document.tempos[index - 1]!.numerator || tempo.denominator !== document.tempos[index - 1]!.denominator);
    for (let index = 0; index < meters.length; index++) {
      const meter = meters[index]!; const length = meter.numerator * 4 / meter.denominator;
      const stop = Math.min(endBeat, meters[index + 1]?.beat ?? endBeat);
      const stride = Math.max(1, Math.ceil(minimumSpacingMs / (60000 / rate * length)), Math.ceil((endBeat - startBeat) / length / 2000));
      for (let number = Math.max(0, Math.ceil((startBeat - meter.beat) / (length * stride))); meter.beat + number * length * stride <= stop; number++) {
        const beat = meter.beat + number * length * stride; const ms = music.firstBeatMs + map.beatToMs(beat);
        if (result.some(value => Math.abs(value.ms - ms) < .00001)) continue;
        result.push({ ms, bar:true, label:`${musicBarPosition(document.tempos, beat).bar}:1` });
      }
    }
  }
  result.sort((a,b) => a.ms - b.ms);
  return result;
}
export function musicBarPosition(tempos: LightingTempo[], beat: number): { bar: number; beat: number; first: boolean } {
  let bar = 1; let origin = 0; let meter = tempos[0]!;
  for (const tempo of tempos.slice(1)) {
    if (tempo.beat > beat) break;
    if (tempo.numerator !== meter.numerator || tempo.denominator !== meter.denominator) { bar += Math.ceil((tempo.beat - origin) / (meter.numerator * 4 / meter.denominator)); origin = tempo.beat; meter = tempo; }
  }
  const length = meter.numerator * 4 / meter.denominator; const local = (beat - origin) / length;
  const within = beat - origin - Math.floor(local + 1e-9) * length;
  return { bar: bar + Math.floor(local + 1e-9), beat: within / (4 / meter.denominator) + 1, first: Math.abs(within) < 1e-7 };
}
export function lightingPositions(document: LightingDocument): CuePositionChange[] {
  const map = new LightingTempoMap(document.tempos);
  return document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events.map(event => ({ id: event.id, name: 'label' in event ? event.label : track.name, fromMs: lightingEventTime(clip, event, map), toMs: lightingEventTime(clip, event, map) }))));
}
/** Convert a legacy beat clip once, retaining independent beat anchors for its siblings. */
export function setMusicCueLock(document: LightingDocument, ids: ReadonlySet<string>, beatLocked: boolean): LightingDocument {
  if (!ids.size) throw new Error('请先选择 Cue');
  const map = new LightingTempoMap(document.tempos);
  return lightingDocumentSchema.parse({ ...document, version: 2, tracks: document.tracks.map(track => ({ ...track, clips: track.clips.map(clip => {
    if (!clip.events.some(event => ids.has(event.id))) return clip;
    if (track.locked) throw new Error('轨道已锁定');
    return musicClipInTime(document, clip, map, event => ids.has(event.id) ? beatLocked : clip.timeLock === 'beat' || event.beatAnchor !== undefined);
  }) })) });
}
/** One clip in absolute time, every event where it plays now; `anchored` events keep following the beats through a
 * `beatAnchor` (their beat on the music grid), the others lose it. The one conversion a beat clip goes through, whether
 * the operator locks its cues to time (setMusicCueLock) or the whole song moves (lighting-shift). */
export function musicClipInTime(document: LightingDocument, clip: LightingClip, map: LightingTempoMap, anchored: (event: LightingEvent, ms: number) => boolean): LightingClip {
  const start = clip.timeLock === 'time' ? clip.start : map.beatToMs(clip.start);
  const duration = clip.timeLock === 'time' ? clip.duration : map.beatToMs(clip.start + clip.duration) - start;
  return { ...clip, timeLock: 'time', start, duration, events: clip.events.map(event => {
    const ms = lightingEventTime(clip, event, map); const next = { ...event, at: ms - start };
    if (next.kind === 'note' && event.kind === 'note' && clip.timeLock === 'beat') next.duration = map.beatToMs(clip.start + event.at + event.duration) - ms;
    if (anchored(event, ms)) next.beatAnchor = musicMsToBeat(document, ms);
    else delete next.beatAnchor;
    return next;
  }) };
}
export function moveMusicCues(document: LightingDocument, changes: CuePositionChange[], durationMs: number): LightingDocument {
  const updates = new Map(changes.map(change => [change.id, change.toMs])); const map = new LightingTempoMap(document.tempos);
  if (changes.some(change => !Number.isFinite(change.toMs) || change.toMs < 0 || change.toMs >= durationMs)) throw new Error('有 Cue 超出歌曲范围，未应用移动');
  const next = { ...document, version: 2 as const, tracks: document.tracks.map(track => {
    if (track.locked && track.clips.some(clip => clip.events.some(event => updates.has(event.id)))) throw new Error(`轨道“${track.name}”已锁定`);
    return { ...track, clips: track.clips.map(clip => {
      if (!clip.events.some(event => updates.has(event.id))) return clip;
      const startMs = clip.timeLock === 'time' ? clip.start : map.beatToMs(clip.start);
      const earliest = Math.min(startMs, ...clip.events.map(event => updates.get(event.id) ?? lightingEventTime(clip, event, map)));
      const endMs = clip.timeLock === 'time' ? clip.start + clip.duration : map.beatToMs(clip.start + clip.duration);
      const events = clip.events.map(event => {
        const ms = updates.get(event.id) ?? lightingEventTime(clip, event, map);
        const nextEvent: LightingEvent = { ...event, at: ms - earliest };
        if (event.kind === 'note' && nextEvent.kind === 'note' && clip.timeLock === 'beat') nextEvent.duration = map.beatToMs(clip.start + event.at + event.duration) - lightingEventTime(clip, event, map);
        if (clip.timeLock === 'beat' || event.beatAnchor !== undefined && updates.has(event.id)) nextEvent.beatAnchor = musicMsToBeat(document, ms);
        return nextEvent;
      });
      return { ...clip, start: earliest, timeLock: 'time' as const, events, duration: Math.max(endMs - earliest, ...events.map(event => event.at + (event.kind === 'note' ? event.duration : 0.001))) };
    }) };
  }) };
  assertMusicCueConflicts(next, new Set(updates.keys()));
  return lightingDocumentSchema.parse(next);
}
export function assertMusicCueConflicts(document: LightingDocument, changedIds?: ReadonlySet<string>): void {
  type Cue = Extract<LightingEvent, { kind: 'ma2' }>;
  const targets = new Map<string, Cue[]>();
  const map = new LightingTempoMap(document.tempos);
  const binding = document.ma2Bindings?.length === 1 ? document.ma2Bindings[0] : undefined;
  const first = binding && firstTimecodeTrack(binding);
  const song = document.timelineDestination ?? document.consoleSong;
  const combines = Boolean(song || first);
  for (const track of document.tracks) {
    if (!lightingTrackEnabled(document, track)) continue;
    for (const clip of track.clips) for (const event of clip.events) {
      if (clip.muted || event.kind !== 'ma2') continue;
      const executor = first && binding && isWorkbenchCue(binding, track, event) ? first.executor : song?.executor || event.executor;
      const target = executor ? `执行器 ${executor}` : `序列 ${song?.sequence ?? event.sequence}`;
      const time = lightingEventTime(clip, event, map);
      const key = target + '/' + (combines ? Math.round((time + (binding?.timeOriginMs ?? 0)) / MA2_FRAME_MS) : time.toFixed(3));
      const others = targets.get(key) ?? [];
      for (const other of others) {
        if (changedIds && !changedIds.has(event.id) && !changedIds.has(other.id)) continue;
        if (combines && event.effectGroupId && event.effectGroupId === other.effectGroupId && event.action === 'goto' && other.action === 'goto') continue;
        const action = (value: Cue): string => value.action === 'goto' ? `Cue ${value.cue}` : value.action === 'off' ? '停止' : '下一步';
        const next = other.action === 'goto' && event.action === 'goto' ? '要同时亮，请把两份素材放进同一个组合 Cue。要先后播放，请移开其中一个点。' : '请把两个动作放在不同的时间。';
        throw new Error(`${(time / 1000).toFixed(3)} 秒的${target} 同时收到「${action(other)}」和「${action(event)}」。${next}`);
      }
      others.push(event);
      targets.set(key, others);
    }
  }
}
export function changeMusicTempo(document: LightingDocument, tempos: LightingTempo[], music: LightingMusic, durationMs: number): { document: LightingDocument; changes: CuePositionChange[] } {
  let next = lightingDocumentSchema.parse({ ...document, version: 2, music, tempos });
  const before = new Map(lightingPositions(document).map(value => [value.id, value]));
  const anchored = document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events.filter(event => event.beatAnchor !== undefined).map(event => ({ ...before.get(event.id)!, toMs: musicBeatToMs(next, event.beatAnchor!) }))));
  if (anchored.length) next = moveMusicCues(next, anchored, durationMs);
  const changes = lightingPositions(next).map(value => ({ ...value, fromMs: before.get(value.id)?.fromMs ?? value.fromMs })).filter(value => Math.abs(value.toMs - value.fromMs) > 0.0001);
  if (changes.some(value => value.toMs >= durationMs)) throw new Error('节拍修改会将 Cue 移出歌曲范围');
  return { document: next, changes };
}

export function estimateMusicBpm(points: number[]): number | null {
  const intervals = points.slice(1).map((point, index) => point - points[index]!).filter(interval => interval > 0);
  if (intervals.length < 2) return null;
  intervals.sort((a, b) => a - b);
  const bpm = 60000 / intervals[Math.floor(intervals.length / 2)]!;
  return Number.isFinite(bpm) && bpm >= 10 && bpm <= 999 ? Math.round(bpm * 100) / 100 : null;
}
