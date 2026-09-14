import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { LinkCue, ReferenceMediaClip, VisualLayer } from '@tb/schema';
import type { TimelineDrag } from './TimelineItems';

type Options = {
  clips: ReferenceMediaClip[];
  cues: LinkCue[];
  layers: VisualLayer[];
  focusTimeline: () => void;
  timeAtClientX: (clientX: number) => number;
  snapTime: (milliseconds: number, item: Pick<TimelineDrag, 'kind' | 'id'>) => number;
  onSelectClip: (clipId: string) => void;
  onSelectCue: (cueId: string) => void;
  onMoveClip: (clipId: string, startMs: number, layerId?: string | null) => void;
  onMoveCue: (cueId: string, startMs: number, layerId?: string | null) => void;
  onMoveLayer: (layerId: string, targetIndex: number) => void;
};

export function useTimelineItemDrag(options: Options): {
  drag: TimelineDrag | null;
  begin: (event: PointerEvent<HTMLButtonElement>, kind: TimelineDrag['kind'], id: string, originMs: number) => void;
  move: (event: PointerEvent<HTMLButtonElement>) => void;
  end: (event: PointerEvent<HTMLButtonElement>) => void;
  cancel: (event: PointerEvent<HTMLButtonElement>) => void;
} {
  const [drag, setDrag] = useState<TimelineDrag | null>(null);
  const dragRef = useRef<TimelineDrag | null>(null);
  useEffect(() => {
    const clear = (): void => { dragRef.current = null; setDrag(null); };
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') clear(); };
    window.addEventListener('keydown', escape);
    window.addEventListener('blur', clear);
    return () => { window.removeEventListener('keydown', escape); window.removeEventListener('blur', clear); };
  }, []);
  const resolve = (current: TimelineDrag, clientX: number, clientY: number, draggedElement: HTMLElement): TimelineDrag => {
    const moved = current.moved || Math.hypot(clientX - current.startClientX, clientY - current.startClientY) >= 4;
    const target = current.layerMovable && moved
      ? visualLayerBelowDraggedItem(draggedElement, clientX, clientY)
      : null;
    return {
      ...current,
      moved,
      previewMs: moved ? options.snapTime(options.timeAtClientX(clientX) - current.grabOffsetMs, current) : current.originMs,
      previewOffsetY: current.layerMovable && moved ? clientY - current.startClientY : 0,
      targetLayerId: target?.hasAttribute('data-new-visual-layer') ? null : target?.dataset.visualLayerId ?? current.originLayerId
    };
  };
  const begin = (event: PointerEvent<HTMLButtonElement>, kind: TimelineDrag['kind'], id: string, originMs: number): void => {
    if (event.button !== 0) return;
    event.stopPropagation();
    options.focusTimeline();
    event.currentTarget.setPointerCapture(event.pointerId);
    if (kind === 'clip') options.onSelectClip(id);
    else options.onSelectCue(id);
    const originLayerId = kind === 'clip'
      ? options.clips.find((clip) => clip.id === id)?.layerId
      : options.cues.find((cue) => cue.id === id)?.layerId;
    const next: TimelineDrag = {
      kind,
      id,
      pointerId: event.pointerId,
      originMs,
      previewMs: originMs,
      grabOffsetMs: options.timeAtClientX(event.clientX) - originMs,
      startClientX: event.clientX,
      startClientY: event.clientY,
      previewOffsetY: 0,
      originLayerId,
      targetLayerId: originLayerId,
      layerMovable: originLayerId !== undefined && event.currentTarget.closest('[data-visual-layer-id]') !== null,
      moved: false
    };
    dragRef.current = next;
    setDrag(next);
  };
  const move = (event: PointerEvent<HTMLButtonElement>): void => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const next = resolve(current, event.clientX, event.clientY, event.currentTarget);
    dragRef.current = next;
    setDrag(next);
  };
  const end = (event: PointerEvent<HTMLButtonElement>): void => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const completed = resolve(current, event.clientX, event.clientY, event.currentTarget);
    dragRef.current = null;
    setDrag(null);
    if (!completed.moved) return;
    const targetLayerId = completed.targetLayerId;
    if (options.layers.find((layer) => layer.id === targetLayerId)?.locked) return;
    if (completed.kind === 'clip') options.onMoveClip(completed.id, completed.previewMs, targetLayerId);
    else options.onMoveCue(completed.id, completed.previewMs, targetLayerId);
  };
  const cancel = (event: PointerEvent<HTMLButtonElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDrag(null);
  };
  return { begin, cancel, drag, end, move };
}

function visualLayerBelowDraggedItem(draggedElement: HTMLElement, clientX: number, clientY: number): HTMLElement | null {
  const previousPointerEvents = draggedElement.style.pointerEvents;
  try {
    draggedElement.style.pointerEvents = 'none';
    return document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('[data-visual-layer-id], [data-new-visual-layer]') ?? null;
  } finally {
    draggedElement.style.pointerEvents = previousPointerEvents;
  }
}
