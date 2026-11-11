import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import type { ResolvedTimelineState, TimelineStateIndex } from '@tb/core/link';

type FrameListener = (positionMs: number) => void;

/** Where the editor's playhead is, outside React (0.5.9 E2). While a song plays the
 * playhead moves every frame; the line, the time readouts, the auto scroll and the
 * preview media follow it straight from here (`usePlayheadPaint`, `usePlayheadEffect`),
 * and React only hears what changes at a boundary, such as which clips are on at the
 * playhead (`usePlayheadValue`, `usePlayheadSegment`). Anything that acts at the
 * playhead (paste, split, stamp, add a clip) reads `read()` when it acts.
 *
 * One owner writes it: `useEditorTransport`, from the player's clock (once a frame,
 * PlayerViewStore) or from the editor's own cursor (seek, scrub, local preview). */
export class EditorPlayhead {
  private positionMs: number;
  private toldMs: number;
  private readonly listeners = new Set<FrameListener>();

  constructor(positionMs = 0) {
    this.positionMs = positionMs;
    this.toldMs = positionMs;
  }

  /** The newest position. */
  read = (): number => this.positionMs;

  /** Moves the playhead and tells every subscriber, once per new value. */
  set = (positionMs: number): void => {
    this.positionMs = positionMs;
    this.tell();
  };

  /** Moves the playhead without telling anyone: for a render, which reads it as it draws
   * (a server render has no effects). The owner's effect calls `set` after the commit. */
  place(positionMs: number): void {
    this.positionMs = positionMs;
  }

  subscribeFrame = (listener: FrameListener): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Calls `onChange` only when `select` of the position gives another value (Object.is). */
  watch<T>(select: (positionMs: number) => T, onChange: (value: T) => void): () => void {
    let last = select(this.positionMs);
    return this.subscribeFrame(positionMs => {
      const next = select(positionMs);
      if (Object.is(next, last)) return;
      last = next;
      onChange(next);
    });
  }

  private tell(): void {
    if (Object.is(this.toldMs, this.positionMs)) return;
    this.toldMs = this.positionMs;
    for (const listener of [...this.listeners]) listener(this.positionMs);
  }
}

/** The sorted, distinct times where something starts or ends. */
export function playheadBoundaries(points: Iterable<number>): number[] {
  return [...new Set(points)].filter(Number.isFinite).sort((left, right) => left - right);
}

/** Which stretch between the boundaries `positionMs` is in: 0 before the first
 * boundary, k from `boundaries[k - 1]` (inclusive) to the next one. */
export function segmentAt(boundaries: readonly number[], positionMs: number): number {
  let low = 0, high = boundaries.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (boundaries[middle]! <= positionMs) low = middle + 1; else high = middle;
  }
  return low;
}

/** A time inside the stretch `segment`: its start, or 0 before the first boundary. */
export function segmentStartMs(boundaries: readonly number[], segment: number): number {
  if (segment > 0) return boundaries[segment - 1]!;
  const first = boundaries[0];
  return first === undefined || first > 0 ? 0 : first - 1;
}

/** Where the timeline state can change: every clip's and camera's start and end
 * (`isTimelineSpanActive` holds from start, inclusive, to end, exclusive). */
type Span = { startMs: number; endMs: number };
export function timelineStateBoundaries(state: { clips: readonly Span[]; visualObsCues: readonly Span[] }): number[] {
  return playheadBoundaries([...state.clips, ...state.visualObsCues].flatMap(entry => [entry.startMs, entry.endMs]));
}

/** A value worked out from the playhead; the component draws again only when it changes
 * (Object.is), so `select` must give a primitive or a reference it already had. */
export function usePlayheadValue<T>(playhead: EditorPlayhead, select: (positionMs: number) => T): T {
  const read = (): T => select(playhead.read());
  return useSyncExternalStore(playhead.subscribeFrame, read, read);
}

/** The position in milliseconds, every frame: only for a small part that shows it as a number
 * while it is open (a context menu). */
export function usePlayheadMs(playhead: EditorPlayhead): number {
  return usePlayheadValue(playhead, positionMs => positionMs);
}

/** Which stretch between `boundaries` (sorted) the playhead is in. */
export function usePlayheadSegment(playhead: EditorPlayhead, boundaries: readonly number[]): number {
  return usePlayheadValue(playhead, positionMs => segmentAt(boundaries, positionMs));
}

/** The timeline state at the playhead, worked out again only when the playhead crosses a
 * clip's or camera's start or end. Its `playheadMs` is the start of that stretch. */
export function useTimelineSegment(playhead: EditorPlayhead, index: TimelineStateIndex | null): ResolvedTimelineState | null {
  const boundaries = useMemo(() => index ? timelineStateBoundaries(index.at(0)) : [], [index]);
  const segment = usePlayheadSegment(playhead, boundaries);
  return useMemo(() => index?.at(segmentStartMs(boundaries, segment)) ?? null, [boundaries, index, segment]);
}

/** Writes the playhead into the DOM before the frame paints: on every move, and again
 * whenever `paint` changes (wrap it in useCallback with what it draws by). */
export function usePlayheadPaint(playhead: EditorPlayhead, paint: FrameListener): void {
  useLayoutEffect(() => {
    paint(playhead.read());
    return playhead.subscribeFrame(paint);
  }, [paint, playhead]);
}

/** An effect run with the position on every move and whenever `effect` changes, as an
 * effect on `[playheadMs, …]` ran on every render before (media kept in step with it). */
export function usePlayheadEffect(playhead: EditorPlayhead, effect: FrameListener): void {
  useEffect(() => {
    effect(playhead.read());
    return playhead.subscribeFrame(effect);
  }, [effect, playhead]);
}
