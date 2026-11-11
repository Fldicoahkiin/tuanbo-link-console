import { useCallback, useEffect, useRef, type PointerEvent } from 'react';
import type { ContentRef } from '@tb/core/link';
import { DragPreview, animationFrames, snapshotTimeAt, trimFrame, type DragViewport, type EdgeScroll, type FrameScheduler, type SnapGuide, type TrimBounds, type TrimFrame, type TrimSnapshot } from './drag-preview';
import { timelineSpanWidth } from './timeline-geometry';
import { useDragSession } from './useDragSession';

export { trimPreview, type TrimBounds } from './drag-preview';

/** What React draws of a trim: which part. Its edges follow the pointer in the DOM (drag-preview.ts). */
export type ContentTrimDrag = { ref: ContentRef; pointerId: number };

type Span = { startMs: number; durationMs: number };
type TrimPointer = { clientX: number; free: boolean };
type Held = { preview: DragPreview<TrimPointer, TrimFrame>; snapshot: TrimSnapshot; latest: TrimFrame };

/** The new length shown by the trimmed edge while it moves. */
export function trimDurationText(durationMs: number): string {
  return `${(durationMs / 1_000).toFixed(2)} 秒`;
}

/** Drag either edge of a clip or camera. The edge follows the pointer from where it was grabbed, snaps, and stops
 * where the edit itself would stop; the part's left and width are written in a frame, the trim is one command. */
export function useContentTrim(input: {
  /** The timeline at the press: the viewport, the frame rate and the snap points for this part (`before`/`after` the playhead; its own edges left out). */
  snapshot: (ref: ContentRef) => Pick<TrimSnapshot, 'viewport' | 'frameRate' | 'snap'>;
  /** The playhead now; null while the song plays, when the edge does not snap to it. */
  playhead: () => number | null;
  /** Draws the snap guide in the frame (none: hidden). */
  paintGuide: (guide: SnapGuide | undefined) => void;
  /** The note by the trimmed edge with the new length; null when the page has none. */
  durationNote: () => HTMLElement | null;
  /** Scrolls the timeline while the edge is held near the viewport's left or right edge. */
  edgeScroll: Pick<EdgeScroll, 'follow' | 'stop'>;
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
    const timeline = input.snapshot(ref);
    const snapshot: TrimSnapshot = { ...timeline, edge, startClientX: event.clientX, originPointerMs: snapshotTimeAt(timeline.viewport, event.clientX),
      originStartMs: span.startMs, originDurationMs: span.durationMs, bounds: input.bounds(ref) };
    const { label, playhead, paintGuide, durationNote, edgeScroll } = input;
    // Where the part's row is in the timeline's content, read once at the press, for the length note above the edge.
    const partTop = part.getBoundingClientRect().top - timeline.viewport.top + timeline.viewport.scrollTop;
    const place = (at: Span, frame: TrimFrame | null): void => {
      const pixelsPerSecond = current.snapshot.viewport.pixelsPerSecond;
      part.style.left = `${at.startMs / 1_000 * pixelsPerSecond}px`;
      part.style.width = `${timelineSpanWidth(at.durationMs, pixelsPerSecond)}px`;
      const text = label(ref, at.startMs, at.durationMs);
      const small = text === null ? null : part.querySelector(':scope > small');
      if (small && small.textContent !== text) small.textContent = text;
      // The edge stopped at a neighbour or the source's end: it changes colour (CSS on data-trim-stopped).
      if (frame?.stopped) part.dataset.trimStopped = edge; else delete part.dataset.trimStopped;
      paintGuide(frame?.guide);
      const note = durationNote();
      if (!note) return;
      note.hidden = frame === null;
      if (frame === null) return;
      const edgeMs = edge === 'start' ? at.startMs : at.startMs + at.durationMs;
      note.textContent = trimDurationText(at.durationMs);
      note.dataset.edge = edge;
      note.dataset.stopped = String(frame.stopped);
      note.style.left = `${edgeMs / 1_000 * pixelsPerSecond}px`;
      note.style.top = `${partTop}px`;
    };
    const initial: TrimFrame = { ...span, guide: undefined, stopped: false };
    const current: Held = {
      snapshot, latest: initial,
      preview: new DragPreview<TrimPointer, TrimFrame>({
        target: (pointer) => { current.latest = trimFrame(current.snapshot, pointer, playhead()) ?? { ...current.latest, guide: undefined, stopped: false }; return current.latest; },
        alive: () => part.isConnected,
        paint: (frame) => place(frame, frame),
        restore: () => { place(span, null); edgeScroll.stop(); },
        // React draws nothing of a trim beyond which part it is.
        drawn: () => '',
        changed: () => undefined
      }, initial, input.frames ?? animationFrames)
    };
    held.current = current;
    session.begin(event, { ref, pointerId: event.pointerId }, handle);
  };
  // Alt held: no snapping for this move; let go of Alt, the next move snaps again.
  const pointer = (event: PointerEvent<HTMLElement>): TrimPointer => ({ clientX: event.clientX, free: event.altKey });
  const move = (event: PointerEvent<HTMLElement>): void => {
    if (session.current()?.pointerId !== event.pointerId) return;
    const current = held.current;
    if (!current) return;
    current.preview.move(pointer(event));
    input.edgeScroll.follow(event.clientX, current.snapshot.viewport);
  };
  const end = (event: PointerEvent<HTMLElement>): void => {
    const current = held.current;
    const drag = session.current();
    if (!current || drag?.pointerId !== event.pointerId) return;
    const completed = current.preview.release(pointer(event));
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
