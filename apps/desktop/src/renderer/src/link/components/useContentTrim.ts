import { useCallback, useEffect, useRef, type PointerEvent } from 'react';
import type { ContentRef } from '@tb/core/link';
import { DragPreview, animationFrames, snapshotTimeAt, trimTarget, type DragViewport, type FrameScheduler, type TrimBounds, type TrimSnapshot } from './drag-preview';
import { timelineSpanWidth } from './timeline-geometry';
import { useDragSession } from './useDragSession';

export { trimPreview, type TrimBounds } from './drag-preview';

/** What React draws of a trim: which part. Its edges follow the pointer in the DOM (drag-preview.ts). */
export type ContentTrimDrag = { ref: ContentRef; pointerId: number };

type Span = { startMs: number; durationMs: number };
type Held = { preview: DragPreview<number, Span>; snapshot: TrimSnapshot; latest: Span };

/** Drag either edge of a clip or camera. The edge follows the pointer from where it was grabbed, snaps, and stops
 * where the edit itself would stop; the part's left and width are written in a frame, the trim is one command. */
export function useContentTrim(input: {
  /** The timeline at the press: the viewport, the frame rate and the snap points (`before`/`after` the playhead). */
  snapshot: () => Pick<TrimSnapshot, 'viewport' | 'frameRate' | 'snap'>;
  playhead: () => number;
  focusTimeline: () => void;
  bounds: (ref: ContentRef) => TrimBounds;
  /** The small line on the part at this place and length, or null when it shows none. */
  label: (ref: ContentRef, startMs: number, durationMs: number) => string | null;
  onSelect: (ref: ContentRef) => void;
  onTrim: (ref: ContentRef, startMs: number, durationMs: number) => void;
  frames?: FrameScheduler;
}) {
  const held = useRef<Held | null>(null);
  // Escape, leaving the window and losing the trimmed part end the trim (DragSession), and stop the preview.
  const session = useDragSession<ContentTrimDrag>((value) => { if (value === null) held.current?.preview.stop(); });
  useEffect(() => () => held.current?.preview.stop(), []);
  /** `handle` takes the pointer; `part` is the clip or camera whose edges move. */
  const begin = (event: PointerEvent<HTMLElement>, ref: ContentRef, span: Span, edge: 'start' | 'end', handle: HTMLElement, part: HTMLElement): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    input.focusTimeline();
    input.onSelect(ref);
    held.current?.preview.stop();
    const timeline = input.snapshot();
    const snapshot: TrimSnapshot = { ...timeline, edge, startClientX: event.clientX, originPointerMs: snapshotTimeAt(timeline.viewport, event.clientX),
      originStartMs: span.startMs, originDurationMs: span.durationMs, bounds: input.bounds(ref) };
    const { label, playhead } = input;
    const place = (at: Span): void => {
      const pixelsPerSecond = current.snapshot.viewport.pixelsPerSecond;
      part.style.left = `${at.startMs / 1_000 * pixelsPerSecond}px`;
      part.style.width = `${timelineSpanWidth(at.durationMs, pixelsPerSecond)}px`;
      const text = label(ref, at.startMs, at.durationMs);
      const small = text === null ? null : part.querySelector(':scope > small');
      if (small && small.textContent !== text) small.textContent = text;
    };
    const current: Held = {
      snapshot, latest: span,
      preview: new DragPreview<number, Span>({
        target: (clientX) => { current.latest = trimTarget(current.snapshot, clientX, playhead(), current.latest); return current.latest; },
        alive: () => part.isConnected,
        paint: place,
        restore: () => place(span),
        // React draws nothing of a trim beyond which part it is.
        drawn: () => '',
        changed: () => undefined
      }, span, input.frames ?? animationFrames)
    };
    held.current = current;
    session.begin(event, { ref, pointerId: event.pointerId }, handle);
  };
  const move = (event: PointerEvent<HTMLElement>): void => {
    if (session.current()?.pointerId === event.pointerId) held.current?.preview.move(event.clientX);
  };
  const end = (event: PointerEvent<HTMLElement>): void => {
    const current = held.current;
    const drag = session.current();
    if (!current || drag?.pointerId !== event.pointerId) return;
    const completed = current.preview.release(event.clientX);
    session.end();
    if (completed && (completed.startMs !== current.snapshot.originStartMs || completed.durationMs !== current.snapshot.originDurationMs)) {
      input.onTrim(drag.ref, completed.startMs, completed.durationMs);
    }
  };
  const cancel = (event: PointerEvent<HTMLElement>): void => {
    if (session.current()?.pointerId === event.pointerId) session.end();
  };
  const rebase = useCallback((viewport: Pick<DragViewport, 'scrollLeft' | 'scrollTop' | 'pixelsPerSecond'>): void => {
    const current = held.current;
    if (!current || current.preview.stopped) return;
    const was = current.snapshot.viewport;
    if (was.scrollLeft === viewport.scrollLeft && was.pixelsPerSecond === viewport.pixelsPerSecond) return;
    current.snapshot = { ...current.snapshot, viewport: { ...was, ...viewport } };
    current.preview.redraw();
  }, []);
  return { begin, cancel, drag: session.drag, end, move, rebase };
}
