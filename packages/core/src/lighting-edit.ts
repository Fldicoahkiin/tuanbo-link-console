import { lightingDocumentSchema, parseLinkProject, type LightingClip, type LightingDocument, type LightingEvent, type LightingTempo } from '@tb/schema';
import type { LinkCommand } from './link-command';

export function setLightingCommand(itemId: string, lighting: LightingDocument, label = '编辑灯光'): LinkCommand {
  const validated = lightingDocumentSchema.parse(lighting);
  return { id: crypto.randomUUID(), label, execute(project) {
    const next = structuredClone(project);
    const item = next.rundown.find((entry) => entry.id === itemId);
    if (!item) throw new Error('灯光节目不存在');
    item.lighting = structuredClone(validated);
    // Old releases reject schema 2 rather than silently dropping lighting data.
    next.schemaVersion = 2;
    next.updatedAt = new Date().toISOString();
    return parseLinkProject(next);
  }, undo: (before) => parseLinkProject(before) };
}

export class LightingTempoMap {
  private readonly segments: Array<LightingTempo & { ms: number; slope: number }>;
  constructor(tempos: LightingTempo[]) {
    if (!tempos.length || tempos[0]?.beat !== 0) throw new Error('节拍图必须从零开始');
    let ms = 0;
    this.segments = tempos.map((tempo, index) => {
      if (!Number.isFinite(tempo.beat) || !Number.isFinite(tempo.bpm) || tempo.bpm <= 0 || tempo.beat < 0) throw new Error('节拍图数值无效');
      const previous = tempos[index - 1];
      if (previous) {
        if (tempo.beat <= previous.beat) throw new Error('变速点顺序无效');
        ms += (tempo.beat - previous.beat) * (previous.transition === 'linear' ? 120000 / (previous.bpm + tempo.bpm) : 60000 / previous.bpm);
      }
      return { ...tempo, ms, slope: 0 };
    });
    for (let index = 0; index + 1 < this.segments.length; index += 1) {
      const segment = this.segments[index]!; const next = this.segments[index + 1]!;
      if (segment.transition === 'linear') segment.slope = (next.bpm - segment.bpm) / (next.ms - segment.ms);
    }
  }
  beatToMs(beat: number): number {
    this.valid(beat);
    const segment = this.find(beat, 'beat');
    const delta = beat - segment.beat;
    if (segment.slope === 0) return segment.ms + delta * 60000 / segment.bpm;
    // Integral of BPM linear in time. The rationalized positive root avoids
    // cancellation for almost-flat ramps and tiny distances from a tempo point.
    const bpm = Math.sqrt(Math.max(0, segment.bpm ** 2 + 120000 * segment.slope * delta));
    return segment.ms + 120000 * delta / (segment.bpm + bpm);
  }
  msToBeat(ms: number): number {
    this.valid(ms);
    const segment = this.find(ms, 'ms');
    const delta = ms - segment.ms;
    return segment.beat + delta * (segment.bpm + segment.slope * delta / 2) / 60000;
  }
  hasRampBetween(startMs: number, endMs: number): boolean {
    this.valid(startMs); this.valid(endMs);
    return this.segments.some((segment, index) => segment.slope !== 0 && segment.ms < endMs && (this.segments[index + 1]?.ms ?? Infinity) > startMs);
  }
  rateAt(ms: number): { bpm: number; bpmPerMs: number } {
    this.valid(ms);
    const segment = this.find(ms, 'ms');
    return { bpm: segment.bpm + segment.slope * (ms - segment.ms), bpmPerMs: segment.slope };
  }
  changesBetween(startMs: number, endMs: number): number[] {
    this.valid(startMs); this.valid(endMs);
    return this.segments.filter((segment) => segment.ms > startMs && segment.ms < endMs).map((segment) => segment.ms);
  }
  private valid(value: number): void { if (!Number.isFinite(value) || value < 0) throw new Error('时间无效'); }
  private find(value: number, key: 'beat' | 'ms') {
    let left = 0; let right = this.segments.length;
    while (left + 1 < right) { const mid = Math.floor((left + right) / 2); const entry = this.segments[mid]; if (entry && entry[key] <= value) left = mid; else right = mid; }
    const result = this.segments[left];
    if (!result) throw new Error('节拍图为空');
    return result;
  }
}

export function lightingClipSpan(clip: LightingClip, map: LightingTempoMap): { startMs: number; endMs: number } {
  return clip.timeLock === 'time' ? { startMs: clip.start, endMs: clip.start + clip.duration }
    : { startMs: map.beatToMs(clip.start), endMs: map.beatToMs(clip.start + clip.duration) };
}
export function lightingEventTime(clip: LightingClip, event: LightingEvent, map: LightingTempoMap): number {
  return clip.timeLock === 'time' ? clip.start + event.at : map.beatToMs(clip.start + event.at);
}
export function offsetLightingEvents(clip: LightingClip, ids: ReadonlySet<string>, offsetMs: number, map: LightingTempoMap): LightingClip {
  if (!Number.isFinite(offsetMs)) throw new Error('时间偏移必须是有效数字');
  const startMs = lightingClipSpan(clip, map).startMs;
  const events = clip.events.map((event) => {
    if (!ids.has(event.id)) return event;
    const ms = lightingEventTime(clip, event, map) + offsetMs;
    if (ms < startMs) throw new Error('偏移后有灯光点早于片段起点');
    const at = (clip.timeLock === 'time' ? ms : map.msToBeat(ms)) - clip.start;
    return { ...event, at };
  });
  const duration = events.reduce((end, event) => Math.max(end, event.at + (event.kind === 'note' ? event.duration : event.kind === 'point' ? 0 : 0.001)), clip.duration);
  return { ...clip, events, duration };
}
export function copyLightingEventsAt(clip: LightingClip, ids: ReadonlySet<string>, at: number): { clip: LightingClip; copiedIds: string[] } {
  if (!Number.isFinite(at) || at < 0) throw new Error('复制位置必须位于片段起点之后');
  const selected = clip.events.filter((event) => ids.has(event.id));
  if (!selected.length) return { clip, copiedIds: [] };
  const first = selected.reduce((earliest, event) => Math.min(earliest, event.at), Infinity);
  // Copy within the clip's time domain: time-locked spacing stays in seconds,
  // beat-locked spacing and note lengths stay in beats across tempo changes.
  const copied = selected.map((event) => ({ ...structuredClone(event), id: crypto.randomUUID(), at: at + event.at - first }));
  const duration = copied.reduce((end, event) => Math.max(end, event.at + (event.kind === 'note' ? event.duration : event.kind === 'point' ? 0 : 0.001)), clip.duration);
  return { clip: { ...clip, duration, events: [...clip.events, ...copied] }, copiedIds: copied.map((event) => event.id) };
}

type CurvePoint = Extract<LightingEvent, { kind: 'point' }>;
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export function lightingCurveValue(from: CurvePoint, to: CurvePoint, t: number): number {
  if (t <= 0) return from.value;
  if (t >= 1) return to.value;
  if (from.shape === 'hold') return from.value;
  if (from.shape === 'linear') return lerp(from.value, to.value, t);
  const [c1, c2] = from.controlValues ?? [from.value, to.value];
  const a = lerp(from.value, c1, t); const b = lerp(c1, c2, t); const c = lerp(c2, to.value, t);
  return lerp(lerp(a, b, t), lerp(b, c, t), t);
}
export function quantizeLightingClip(clip: LightingClip, map: LightingTempoMap, gridBeats: number, swing = 0): LightingClip {
  if (!Number.isFinite(gridBeats) || gridBeats <= 0 || swing < 0 || swing > 0.75) throw new Error('量化网格无效');
  const events = clip.events.map((event) => {
    const beat = map.msToBeat(lightingEventTime(clip, event, map));
    const baseIndex = Math.floor(beat / (gridBeats * 2)) * 2;
    const candidates = [baseIndex - 1, baseIndex, baseIndex + 1, baseIndex + 2].map((i) => Math.max(0, (i + (Math.abs(i % 2) === 1 ? swing : 0)) * gridBeats));
    const snapped = candidates.reduce((best, candidate) => Math.abs(candidate - beat) < Math.abs(best - beat) ? candidate : best, beat + gridBeats * 4);
    const maximum = clip.duration - (event.kind === 'note' ? event.duration : 0.000001);
    const at = Math.max(0, Math.min(maximum, (clip.timeLock === 'time' ? map.beatToMs(snapped) : snapped) - clip.start));
    return { ...event, at };
  });
  return { ...clip, events };
}
export function splitLightingClip(clip: LightingClip, at: number): [LightingClip, LightingClip] {
  if (!Number.isFinite(at) || at <= 0 || at >= clip.duration) throw new Error('拆分点必须在片段内部');
  const left: LightingEvent[] = []; const right: LightingEvent[] = [];
  const points = clip.events.filter((event) => event.kind === 'point').sort((a, b) => a.at - b.at);
  const before = points.filter((event) => event.at < at).at(-1); const after = points.find((event) => event.at >= at);
  for (const event of clip.events) {
    if (event.at >= at) right.push({ ...event, id: crypto.randomUUID(), at: event.at - at });
    else if (event.kind === 'note' && event.at + event.duration > at) {
      left.push({ ...event, duration: at - event.at });
      right.push({ ...event, id: crypto.randomUUID(), at: 0, duration: event.at + event.duration - at });
    } else left.push(structuredClone(event));
  }
  if (after?.at === at) {
    // The right clip owns the editable point, but the left still needs its
    // endpoint to preserve interpolation all the way to the cut.
    left.push({ ...after, id: crypto.randomUUID(), shape: 'hold' });
  } else if (before) {
    const t = after ? (at - before.at) / (after.at - before.at) : 0;
    const value = after ? lightingCurveValue(before, after, t) : before.value;
    left.push({ id: crypto.randomUUID(), kind: 'point', at, value, shape: 'hold' });
    const rightPoint: CurvePoint = { id: crypto.randomUUID(), kind: 'point', at: 0, value, shape: before.shape };
    if (after && before.shape === 'smooth') {
      // De Casteljau subdivision keeps both pieces of the original cubic,
      // including their boundary slopes, through repeated cuts and saves.
      const [c1, c2] = before.controlValues ?? [before.value, after.value];
      const a = lerp(before.value, c1, t); const b = lerp(c1, c2, t); const c = lerp(c2, after.value, t);
      const leftPoint = left.find((event) => event.id === before.id);
      if (leftPoint?.kind === 'point') leftPoint.controlValues = [a, lerp(a, b, t)];
      rightPoint.controlValues = [lerp(b, c, t), c];
    }
    right.push(rightPoint);
  }
  return [{ ...clip, duration: at, events: left }, { ...clip, id: crypto.randomUUID(), start: clip.start + at, duration: clip.duration - at, events: right }];
}

export function trimLightingClip(clip: LightingClip, duration: number): LightingClip {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('片段长度无效');
  if (duration >= clip.duration) return { ...clip, duration };
  return splitLightingClip(clip, duration)[0];
}

export function mergeLightingClips(clips: LightingClip[], map: LightingTempoMap): LightingClip {
  if (clips.length < 2) throw new Error('至少选择两个片段才能合并');
  if (clips.some((clip) => clip.muted !== clips[0]?.muted)) throw new Error('不同静音状态的片段不能合并');
  if (clips.some((clip) => clip.events.some((event) => event.kind === 'point'))) {
    const ordered = clips.map((clip) => lightingClipSpan(clip, map)).sort((a, b) => a.startMs - b.startMs);
    if (ordered.some((span, index) => index > 0 && span.startMs < (ordered[index - 1]?.endMs ?? 0))) throw new Error('重叠曲线片段不能合并，请先修剪重叠区域');
  }
  const start = Math.min(...clips.map((clip) => lightingClipSpan(clip, map).startMs));
  const end = Math.max(...clips.map((clip) => lightingClipSpan(clip, map).endMs));
  const events = clips.flatMap((clip) => {
    const converted = lightingClipInTime(clip, map);
    return converted.events.map((event) => ({ ...event, at: event.at + converted.start - start }));
  }).sort((a, b) => a.at - b.at);
  return { id: crypto.randomUUID(), name: clips[0]?.name ?? '合并片段', timeLock: 'time', start, duration: end - start, muted: clips[0]?.muted ?? false, events };
}
/** Preserve actual playback timing when moving a clip to a different tempo map. */
export function lightingClipInTime(clip: LightingClip, map: LightingTempoMap, createId: (sourceId: string) => string = () => crypto.randomUUID()): LightingClip {
  const { startMs: start, endMs: end } = lightingClipSpan(clip, map);
  const discrete = clip.events.filter((event) => event.kind !== 'point').map((event) => {
    const at = lightingEventTime(clip, event, map) - start;
    return event.kind === 'note'
      ? { ...structuredClone(event), id: createId(event.id), at, duration: lightingEventTime(clip, { ...event, at: event.at + event.duration }, map) - start - at }
      : { ...structuredClone(event), id: createId(event.id), at };
  });
  const points = curveEventsInTime(clip, map, createId).map((event) => ({ ...event, at: event.at - start }));
  return { ...clip, id: createId(clip.id), start, duration: end - start, timeLock: 'time', events: [...discrete, ...points].sort((a, b) => a.at - b.at) };
}
// Split only the curves: splitting whole clips would retrigger sustained notes.
function curveEventsInTime(clip: LightingClip, map: LightingTempoMap, createId: (sourceId: string) => string): CurvePoint[] {
  const points = clip.events.filter((event) => event.kind === 'point');
  if (!points.length) return [];
  const span = lightingClipSpan(clip, map);
  if (clip.timeLock === 'beat' && map.hasRampBetween(span.startMs, span.endMs)) return rampCurveEventsInTime(clip, points, map, createId);
  const pieces: LightingClip[] = [];
  let remaining: LightingClip = { ...clip, events: points };
  for (const ms of clip.timeLock === 'beat' ? map.changesBetween(span.startMs, span.endMs) : []) {
    const [left, right] = splitLightingClip(remaining, map.msToBeat(ms) - remaining.start);
    pieces.push(left); remaining = right;
  }
  pieces.push(remaining);
  const result: CurvePoint[] = [];
  for (const piece of pieces) {
    for (const event of piece.events.filter((entry) => entry.kind === 'point').sort((a, b) => a.at - b.at)) {
      const at = lightingEventTime(piece, event, map);
      const previous = result.at(-1);
      // The right subdivision owns the shape at a shared, continuous boundary.
      if (previous?.at === at && previous.value === event.value) result.pop();
      result.push({ ...structuredClone(event), id: createId(event.id), at });
    }
  }
  const last = result.at(-1);
  if (last) { last.shape = 'hold'; delete last.controlValues; }
  return result;
}
function rampCurveEventsInTime(clip: LightingClip, points: CurvePoint[], map: LightingTempoMap, createId: (sourceId: string) => string): CurvePoint[] {
  const ordered = [...points].sort((a, b) => a.at - b.at);
  const result: CurvePoint[] = [];
  for (const [index, from] of ordered.entries()) {
    const to = ordered[index + 1];
    const start = lightingEventTime(clip, from, map);
    result.push({ id: createId(from.id), kind: 'point', at: start, value: from.value, shape: to && from.shape !== 'hold' ? 'linear' : 'hold' });
    if (!to || from.shape === 'hold' || to.at <= from.at) continue;
    const end = lightingEventTime(clip, to, map);
    const boundaries = [start, ...map.changesBetween(start, end), end];
    const [c1, c2] = from.controlValues ?? [from.value, to.value];
    const firstDerivative = from.shape === 'linear' ? Math.abs(to.value - from.value) : 3 * Math.max(Math.abs(c1 - from.value), Math.abs(c2 - c1), Math.abs(to.value - c2));
    const secondDerivative = from.shape === 'linear' ? 0 : 6 * Math.max(Math.abs(c2 - 2 * c1 + from.value), Math.abs(to.value - 2 * c2 + c1));
    const beatSpan = to.at - from.at;
    for (let interval = 0; interval + 1 < boundaries.length; interval += 1) {
      const left = boundaries[interval]!; const right = boundaries[interval + 1]!;
      const rate = map.rateAt(left);
      const maxBpm = Math.max(rate.bpm, rate.bpm + rate.bpmPerMs * (right - left));
      // For f(u(t)), bound |f''| by |f_uu|*u'^2 + |f_u|*|u''|.
      // A chord's value error is then <= bound * dt^2 / 8. Split at tempo
      // changes first, since a step in BPM makes u' discontinuous there.
      const bound = secondDerivative * (maxBpm / (60000 * beatSpan)) ** 2 + firstDerivative * Math.abs(rate.bpmPerMs) / (60000 * beatSpan);
      const count = Math.max(1, Math.ceil((right - left) * Math.sqrt(bound / (8 * 0.001))));
      if (count + result.length > 200000) throw new Error('变速曲线转换超过 20 万控制点，请缩短片段后重试');
      for (let part = 0; part < count; part += 1) {
        const at = left + (right - left) * part / count;
        if (at === start) continue;
        const t = (map.msToBeat(at) - clip.start - from.at) / beatSpan;
        result.push({ id: createId(crypto.randomUUID()), kind: 'point', at, value: lightingCurveValue(from, to, t), shape: 'linear' });
      }
    }
  }
  return result;
}
export function duplicateLightingClip(clip: LightingClip): LightingClip {
  return { ...structuredClone(clip), id: crypto.randomUUID(), start: clip.start + clip.duration, events: clip.events.map((event) => ({ ...event, id: crypto.randomUUID() })) };
}
