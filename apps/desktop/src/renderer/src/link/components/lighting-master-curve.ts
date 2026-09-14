import { lightingEventTime, type LightingTempoMap } from '@tb/core/link';
import type { LightingClip, LightingEvent } from '@tb/schema';

export const masterCurveY = (level: number): number => 48 - level * 32;

/** Clip each segment to the viewport, retaining neighbours outside it. No extrapolated output. */
export function lightingMasterSegments(clip: LightingClip, events: readonly LightingEvent[], map: LightingTempoMap,
  pixelsPerSecond: number, left: number, right: number): { executor: string; x1: number; y1: number; x2: number; y2: number }[] {
  const groups = new Map<string, { x: number; level: number }[]>();
  for (const event of events) {
    if (event.kind !== 'ma2-fader') continue;
    const points = groups.get(event.executor) ?? [];
    points.push({ x: lightingEventTime(clip, event, map) / 1000 * pixelsPerSecond, level: event.level });
    groups.set(event.executor, points);
  }
  const segments: { executor: string; x1: number; y1: number; x2: number; y2: number }[] = [];
  for (const [executor, points] of groups) {
    points.sort((a, b) => a.x - b.x);
    for (let index = 1; index < points.length; index += 1) {
      const a = points[index - 1]!; const b = points[index]!;
      // Equal-time values have no verified precedence: leave the adjacent curve unclaimed.
      if (b.x <= a.x || points[index - 2]?.x === a.x || points[index + 1]?.x === b.x || b.x < left || a.x > right) continue;
      const start = Math.max(left, a.x); const end = Math.min(right, b.x);
      if (end <= start) continue;
      const levelAt = (x: number): number => a.level + (b.level - a.level) * (x - a.x) / (b.x - a.x);
      segments.push({ executor, x1: start - left, y1: masterCurveY(levelAt(start)), x2: end - left, y2: masterCurveY(levelAt(end)) });
    }
  }
  return segments;
}
