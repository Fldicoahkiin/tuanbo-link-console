import { useCallback, useEffect, useRef, type PointerEvent } from 'react';
import type { ContentRef } from '@tb/core/link';
import type { VisualLayer } from '@tb/schema';
import { DragPreview, animationFrames, dragTarget, pointerMoved, type DragViewport, type FrameScheduler, type ItemDragSnapshot, type ItemDragTarget } from './drag-preview';
import { useDragSession } from './useDragSession';

/**
 * What React draws of a clip or camera being moved: which part, and where it lands as far as the tracks show it (the
 * target track, a new track above, the snap guide). The part itself follows the pointer in the DOM (drag-preview.ts).
 */
export type TimelineDrag = ContentRef & { pointerId: number; originLayerId: string | undefined; target: ItemDragTarget };

/** A press on a part: everything the snapshot needs that only the press knows. */
export type ItemPress = { ref: ContentRef; originMs: number; clientX: number; clientY: number; originLayerId: string | undefined; layerMovable: boolean };

type Options = {
  layers: readonly VisualLayer[];
  /** The snapshot of the timeline at the press (viewport, tracks, snap points, rules). */
  snapshot: (press: ItemPress) => ItemDragSnapshot;
  /** The playhead now, read in the frame: the drag snaps to it. */
  playhead: () => number;
  /** The small line on the part at `startMs` (its time), or null when it shows none. */
  label: (ref: ContentRef, startMs: number) => string | null;
  /** The note “松开放到上方新轨道” on the target track, while drawn; it follows the part's end. */
  dropNote: () => HTMLElement | null;
  focusTimeline: () => void;
  onSelectClip: (clipId: string) => void;
  onSelectCue: (cueId: string) => void;
  onMoveClip: (clipId: string, startMs: number, layerId?: string | null) => void;
  onMoveCue: (cueId: string, startMs: number, layerId?: string | null) => void;
  frames?: FrameScheduler;
};

type Held = { preview: DragPreview<Omit<Parameters<typeof dragTarget>[1], 'playheadMs'>, ItemDragTarget>; snapshot: ItemDragSnapshot; moved: boolean };

/**
 * Moving a clip or camera along and across tracks. Escape, leaving the window and losing the dragged part end the
 * drag (DragSession); the part moves in the DOM, a frame at a time, and the release is one command, as before E3.
 */
export function useTimelineItemDrag(options: Options): {
  drag: TimelineDrag | null;
  begin: (event: PointerEvent<HTMLElement>, press: Omit<ItemPress, 'clientX' | 'clientY' | 'layerMovable'>, element: HTMLElement) => void;
  move: (event: PointerEvent<HTMLElement>) => void;
  end: (event: PointerEvent<HTMLElement>) => void;
  cancel: (event: PointerEvent<HTMLElement>) => void;
  /** The timeline scrolled or zoomed while the drag goes on: worked out again from there. */
  rebase: (viewport: Pick<DragViewport, 'scrollLeft' | 'scrollTop' | 'pixelsPerSecond'>) => void;
} {
  const held = useRef<Held | null>(null);
  // Escape, leaving the window and the part going away stop the preview with the drag.
  const session = useDragSession<TimelineDrag>((value) => { if (value === null) held.current?.preview.stop(); });
  useEffect(() => () => held.current?.preview.stop(), []);
  const pointer = (current: Held, event: PointerEvent<HTMLElement>) => {
    current.moved ||= pointerMoved(current.snapshot, event.clientX, event.clientY);
    return { clientX: event.clientX, clientY: event.clientY, moved: current.moved };
  };
  const begin = (event: PointerEvent<HTMLElement>, press: Omit<ItemPress, 'clientX' | 'clientY' | 'layerMovable'>, element: HTMLElement): void => {
    if (event.button !== 0) return;
    event.stopPropagation();
    options.focusTimeline();
    if (press.ref.kind === 'clip') options.onSelectClip(press.ref.id);
    else options.onSelectCue(press.ref.id);
    held.current?.preview.stop();
    const snapshot = options.snapshot({ ...press, clientX: event.clientX, clientY: event.clientY,
      layerMovable: press.originLayerId !== undefined && element.closest('[data-visual-layer-id]') !== null });
    const initial = dragTarget(snapshot, { clientX: event.clientX, clientY: event.clientY, moved: false, playheadMs: options.playhead() });
    const drag = (target: ItemDragTarget): TimelineDrag => ({ ...press.ref, pointerId: event.pointerId, originLayerId: press.originLayerId, target });
    const { label, dropNote, playhead } = options;
    const current: Held = {
      snapshot, moved: false,
      preview: new DragPreview({
        target: (at) => dragTarget(current.snapshot, { ...at, playheadMs: playhead() }),
        alive: () => element.isConnected,
        paint: (target) => {
          const scale = current.snapshot.viewport.pixelsPerSecond / 1_000;
          element.style.translate = `${(target.startMs - snapshot.originMs) * scale}px ${target.offsetY}px`;
          writeLabel(element, label(press.ref, target.startMs));
          const note = target.taken ? dropNote() : null;
          if (note) note.style.left = `${(target.startMs + snapshot.itemDurationMs) * scale + 8}px`;
        },
        restore: () => { element.style.translate = ''; writeLabel(element, label(press.ref, snapshot.originMs)); },
        drawn: (target) => `${target.moved}|${String(target.layerId)}|${target.taken}|${String(target.snapMs)}`,
        changed: (target) => session.update(drag(target))
      }, initial, options.frames ?? animationFrames)
    };
    held.current = current;
    session.begin(event, drag(initial), element);
  };
  const move = (event: PointerEvent<HTMLElement>): void => {
    const current = held.current;
    if (!current || session.current()?.pointerId !== event.pointerId) return;
    current.preview.move(pointer(current, event));
  };
  const end = (event: PointerEvent<HTMLElement>): void => {
    const current = held.current;
    const drag = session.current();
    if (!current || drag?.pointerId !== event.pointerId) return;
    const completed = current.preview.release(pointer(current, event));
    session.end();
    if (!completed?.moved) return;
    const layerId = completed.layerId;
    if (options.layers.find((layer) => layer.id === layerId)?.locked) return;
    if (drag.kind === 'clip') options.onMoveClip(drag.id, completed.startMs, layerId);
    else options.onMoveCue(drag.id, completed.startMs, layerId);
  };
  const cancel = (event: PointerEvent<HTMLElement>): void => {
    if (session.current()?.pointerId === event.pointerId) session.end();
  };
  const rebase = useCallback((viewport: Pick<DragViewport, 'scrollLeft' | 'scrollTop' | 'pixelsPerSecond'>): void => {
    const current = held.current;
    if (!current || current.preview.stopped) return;
    const was = current.snapshot.viewport;
    if (was.scrollLeft === viewport.scrollLeft && was.scrollTop === viewport.scrollTop && was.pixelsPerSecond === viewport.pixelsPerSecond) return;
    current.snapshot = { ...current.snapshot, viewport: { ...was, ...viewport } };
    current.preview.redraw();
  }, []);
  return { begin, cancel, drag: session.drag, end, move, rebase };
}

/** Writes the part's small line while it moves; React draws it as one piece of text, so it keeps what is written until its own value changes. */
export function writeLabel(element: HTMLElement, text: string | null): void {
  if (text === null) return;
  const small = element.querySelector(':scope > small');
  if (small && small.textContent !== text) small.textContent = text;
}
