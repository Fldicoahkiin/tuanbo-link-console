import type { FrameRange, TimelineSpan } from '@tb/core/link';

/** The frames each clip (`media:<id>`) and camera (`cue:<id>`) is on air, from
 * SceneOutputTimeline.airtime(): the same rule the output plays by. */
export type Airtime = ReadonlyMap<string, readonly FrameRange[]>;

/** A part of a clip or camera that does not play, as fractions of its length. */
export type OffAirPart = { from: number; to: number };

/** The parts of `span` outside `onAir`. A part with no entry is not in the
 * picture at all (hidden track, a clip the song audio already plays), so there
 * is nothing covered to mark; an empty entry means covered from end to end. */
export function offAirParts(span: Pick<TimelineSpan, 'startFrame' | 'endFrame'>, onAir: readonly FrameRange[] | undefined): OffAirPart[] {
  const length = span.endFrame - span.startFrame;
  if (!onAir || length <= 0) return [];
  const parts: FrameRange[] = [];
  let cursor = span.startFrame;
  for (const range of onAir) {
    const start = Math.max(range.start, span.startFrame), end = Math.min(range.end, span.endFrame);
    if (end <= start) continue;
    if (start > cursor) parts.push({ start: cursor, end: start });
    cursor = Math.max(cursor, end);
  }
  if (cursor < span.endFrame) parts.push({ start: cursor, end: span.endFrame });
  return parts.map(part => ({ from: (part.start - span.startFrame) / length, to: (part.end - span.startFrame) / length }));
}

/** The keys on air at `frame`. */
export function onAirAt(airtime: Airtime, frame: number): Set<string> {
  const keys = new Set<string>();
  for (const [key, ranges] of airtime) if (ranges.some(range => range.start <= frame && frame < range.end)) keys.add(key);
  return keys;
}

/** Hover text for a part with covered stretches. */
export function offAirTitle(parts: readonly OffAirPart[]): string | null {
  if (!parts.length) return null;
  return parts.length === 1 && parts[0]!.from === 0 && parts[0]!.to === 1
    ? '整段被上面的机位挡住，不会播出'
    : '变暗的部分被上面的机位挡住，不会播出';
}
