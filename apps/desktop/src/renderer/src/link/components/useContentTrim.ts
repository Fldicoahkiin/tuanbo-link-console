import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { playbackFramesPerSecond, type ContentRef } from '@tb/core/link';
import type { MtcFrameRate } from '@tb/schema';
import { timelineInteractionTime } from './timeline-geometry';
import { cancelDragOnEscape } from '../playback-keys';

/** Trimming never reaches past a day; the bounds stop it well before. */
const TIMELINE_LIMIT_MS = 86_399_000;

/** How far a part can be trimmed: its neighbours on the track and, for video
 * and sound, the ends of the source (core contentTrimBounds). */
export type TrimBounds = { minStartMs: number; maxEndMs: number };

export type ContentTrimDrag = {
  ref: ContentRef;
  edge: 'start' | 'end';
  pointerId: number;
  startClientX: number;
  originPointerMs: number;
  originStartMs: number;
  originDurationMs: number;
  bounds: TrimBounds;
  previewStartMs: number;
  previewDurationMs: number;
};

/** Where a trim lands with the dragged edge at `edgeMs`: inside the bounds and
 * at least `minimumMs` long, the other edge staying put. */
export function trimPreview(drag: Pick<ContentTrimDrag, 'edge' | 'originStartMs' | 'originDurationMs' | 'bounds'>, edgeMs: number, minimumMs: number): { startMs: number; durationMs: number } {
  const endMs = drag.originStartMs + drag.originDurationMs;
  if (drag.edge === 'start') {
    const startMs = Math.min(endMs - minimumMs, Math.max(drag.bounds.minStartMs, edgeMs));
    return { startMs, durationMs: endMs - startMs };
  }
  const end = Math.max(drag.originStartMs + minimumMs, Math.min(drag.bounds.maxEndMs, edgeMs));
  return { startMs: drag.originStartMs, durationMs: end - drag.originStartMs };
}

/** Drag either edge of a clip or camera. The edge follows the pointer from
 * where it was grabbed, snaps, and stops where the edit itself would stop. */
export function useContentTrim(input: {
  frameRate: MtcFrameRate;
  timeAtClientX: (clientX: number) => number;
  focusTimeline: () => void;
  snapEnabled: boolean;
  snapThresholdMs: number;
  snapPoints: (ref: ContentRef) => readonly number[];
  bounds: (ref: ContentRef) => TrimBounds;
  onSelect: (ref: ContentRef) => void;
  onTrim: (ref: ContentRef, startMs: number, durationMs: number) => void;
}) {
  const [drag, setDrag] = useState<ContentTrimDrag | null>(null);
  const dragRef = useRef<ContentTrimDrag | null>(null);
  const update = (next: ContentTrimDrag | null): void => { dragRef.current = next; setDrag(next); };
  useEffect(() => {
    const clear = (): void => { dragRef.current = null; setDrag(null); };
    const escape = (event: KeyboardEvent): void => cancelDragOnEscape(event, dragRef.current !== null, clear);
    window.addEventListener('keydown', escape, true);
    window.addEventListener('blur', clear);
    return () => { window.removeEventListener('keydown', escape, true); window.removeEventListener('blur', clear); };
  }, []);
  const resolve = (current: ContentTrimDrag, clientX: number): ContentTrimDrag => {
    if (Math.abs(clientX - current.startClientX) < 3) return current;
    const originEdgeMs = current.edge === 'start' ? current.originStartMs : current.originStartMs + current.originDurationMs;
    const edgeMs = timelineInteractionTime(originEdgeMs + input.timeAtClientX(clientX) - current.originPointerMs, TIMELINE_LIMIT_MS,
      input.frameRate, input.snapEnabled, input.snapPoints(current.ref), input.snapThresholdMs);
    const preview = trimPreview(current, edgeMs, 1_000 / playbackFramesPerSecond(input.frameRate));
    return { ...current, previewStartMs: preview.startMs, previewDurationMs: preview.durationMs };
  };
  const begin = (event: PointerEvent<HTMLElement>, ref: ContentRef, span: { startMs: number; durationMs: number }, edge: 'start' | 'end'): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    input.focusTimeline();
    event.currentTarget.setPointerCapture(event.pointerId);
    input.onSelect(ref);
    update({ ref, edge, pointerId: event.pointerId, startClientX: event.clientX, originPointerMs: input.timeAtClientX(event.clientX),
      originStartMs: span.startMs, originDurationMs: span.durationMs, bounds: input.bounds(ref),
      previewStartMs: span.startMs, previewDurationMs: span.durationMs });
  };
  const move = (event: PointerEvent<HTMLElement>): void => {
    const current = dragRef.current;
    if (current?.pointerId === event.pointerId) update(resolve(current, event.clientX));
  };
  const end = (event: PointerEvent<HTMLElement>): void => {
    const current = dragRef.current;
    if (current?.pointerId !== event.pointerId) return;
    const completed = resolve(current, event.clientX);
    update(null);
    if (completed.previewStartMs !== completed.originStartMs || completed.previewDurationMs !== completed.originDurationMs) {
      input.onTrim(completed.ref, completed.previewStartMs, completed.previewDurationMs);
    }
  };
  const cancel = (event: PointerEvent<HTMLElement>): void => {
    if (dragRef.current?.pointerId === event.pointerId) update(null);
  };
  return { begin, cancel, drag, end, move };
}
