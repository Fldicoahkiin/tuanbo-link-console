import type { LightingClip, LightingEvent } from '@tb/schema';
import { LightingTempoMap, lightingClipSpan, lightingCurveValue } from './lighting-edit';

export type LightingEventClipboard = { timeLock: LightingClip['timeLock']; events: LightingEvent[] };

export function copyLightingEvents(clip: LightingClip, ids: ReadonlySet<string>): LightingEventClipboard | null {
  const events = clip.events.filter((event) => ids.has(event.id));
  if (!events.length) return null;
  const start = events.reduce((first, event) => Math.min(first, event.at), Infinity);
  return { timeLock: clip.timeLock, events: events.map((event) => ({ ...structuredClone(event), at: event.at - start })) };
}

export function pasteLightingEvents(clip: LightingClip, clipboard: LightingEventClipboard, startMs: number, map: LightingTempoMap): { clip: LightingClip; pastedIds: string[] } {
  const clipStartMs = lightingClipSpan(clip, map).startMs;
  if (!Number.isFinite(startMs) || startMs < clipStartMs) throw new Error('粘贴位置不能早于灯光片段起点');
  const startBeat = clip.timeLock === 'beat' && startMs === clipStartMs ? clip.start : map.msToBeat(startMs);
  const mappedStartMs = map.beatToMs(startBeat);
  const mappedStartBeat = map.msToBeat(startMs);
  const anchor = startMs === clipStartMs ? 0 : (clip.timeLock === 'time' ? startMs : startBeat) - clip.start;
  const sourceToMs = (at: number): number => clipboard.timeLock === 'time' ? startMs + at : startMs + (map.beatToMs(startBeat + at) - mappedStartMs);
  const convert = (at: number): number => clipboard.timeLock === clip.timeLock
    ? anchor + at
    : anchor + (clip.timeLock === 'time' ? map.beatToMs(startBeat + at) - mappedStartMs : map.msToBeat(startMs + at) - mappedStartBeat);
  const points = clipboard.events.filter((event) => event.kind === 'point').sort((a, b) => a.at - b.at);
  const events: LightingEvent[] = [];
  for (const event of clipboard.events) {
    if (event.kind === 'point') continue;
    const at = convert(event.at);
    events.push(event.kind === 'note'
      ? { ...structuredClone(event), id: crypto.randomUUID(), at, duration: convert(event.at + event.duration) - at }
      : { ...structuredClone(event), id: crypto.randomUUID(), at });
  }
  for (const [index, point] of points.entries()) {
    const next = points[index + 1];
    let current = structuredClone(point);
    // A tempo change makes conversion piecewise linear. Split the source
    // curve at every change before converting its coordinates, preserving
    // the cubic exactly instead of bending it with a new time axis.
    const changes = next && clipboard.timeLock !== clip.timeLock ? map.changesBetween(sourceToMs(point.at), sourceToMs(next.at)) : [];
    for (const ms of changes) {
      if (!next) break;
      const at = clipboard.timeLock === 'time' ? ms - startMs : map.msToBeat(ms - startMs + mappedStartMs) - startBeat;
      const [left, right] = splitCurve(current, next, at);
      events.push({ ...left, id: crypto.randomUUID(), at: convert(left.at) });
      current = right;
    }
    events.push({ ...current, id: crypto.randomUUID(), at: convert(current.at) });
  }
  const duration = events.reduce((end, event) => Math.max(end, event.at + (event.kind === 'note' ? event.duration : event.kind === 'point' ? 0 : 0.001)), clip.duration);
  return { clip: { ...clip, duration, events: [...clip.events, ...events] }, pastedIds: events.map((event) => event.id) };
}

type CurvePoint = Extract<LightingEvent, { kind: 'point' }>;
function splitCurve(from: CurvePoint, to: CurvePoint, at: number): [CurvePoint, CurvePoint] {
  const t = (at - from.at) / (to.at - from.at);
  const right: CurvePoint = { ...from, at, value: lightingCurveValue(from, to, t) };
  if (from.shape !== 'smooth') return [from, right];
  const lerp = (a: number, b: number): number => a + (b - a) * t;
  const [c1, c2] = from.controlValues ?? [from.value, to.value];
  const a = lerp(from.value, c1); const b = lerp(c1, c2); const c = lerp(c2, to.value);
  return [{ ...from, controlValues: [a, lerp(a, b)] }, { ...right, controlValues: [lerp(b, c), c] }];
}
