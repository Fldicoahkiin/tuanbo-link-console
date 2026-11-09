import type { PointerEvent } from 'react';
import { useDragSession } from './useDragSession';

type LayerReorderDrag = { layerId: string; pointerId: number; originIndex: number; targetIndex: number };

export function useLayerReorder(layerCount: number, onMoveLayer: (layerId: string, targetIndex: number) => void): {
  drag: LayerReorderDrag | null;
  begin: (event: PointerEvent<HTMLElement>, layerId: string, index: number) => void;
  move: (event: PointerEvent<HTMLElement>) => void;
  end: (event: PointerEvent<HTMLElement>) => void;
  cancel: (event: PointerEvent<HTMLElement>) => void;
} {
  // Escape only cancels the move, the same as for the other drags; leaving the window and losing the track end it too (DragSession).
  const session = useDragSession<LayerReorderDrag>();
  const indexAtPoint = (clientX: number, clientY: number): number | null => {
    const value = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('[data-visual-layer-index]')?.dataset.visualLayerIndex;
    if (value === undefined) return null;
    const index = Number(value);
    return Number.isInteger(index) && index >= 0 && index < layerCount ? index : null;
  };
  const begin = (event: PointerEvent<HTMLElement>, layerId: string, index: number): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    session.begin(event, { layerId, pointerId: event.pointerId, originIndex: index, targetIndex: index });
  };
  const move = (event: PointerEvent<HTMLElement>): void => {
    const current = session.current();
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault();
    const targetIndex = indexAtPoint(event.clientX, event.clientY);
    if (targetIndex === null || targetIndex === current.targetIndex) return;
    session.update({ ...current, targetIndex });
  };
  const end = (event: PointerEvent<HTMLElement>): void => {
    const current = session.current();
    if (!current || current.pointerId !== event.pointerId) return;
    const targetIndex = indexAtPoint(event.clientX, event.clientY) ?? current.targetIndex;
    session.end();
    if (targetIndex !== current.originIndex) onMoveLayer(current.layerId, targetIndex);
  };
  const cancel = (event: PointerEvent<HTMLElement>): void => {
    if (session.current()?.pointerId === event.pointerId) session.end();
  };
  return { begin, cancel, drag: session.drag, end, move };
}
