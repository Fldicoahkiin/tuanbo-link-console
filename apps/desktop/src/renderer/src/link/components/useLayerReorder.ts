import { useRef, useState, type PointerEvent } from 'react';

type LayerReorderDrag = { layerId: string; pointerId: number; originIndex: number; targetIndex: number };

export function useLayerReorder(layerCount: number, onMoveLayer: (layerId: string, targetIndex: number) => void): {
  drag: LayerReorderDrag | null;
  begin: (event: PointerEvent<HTMLElement>, layerId: string, index: number) => void;
  move: (event: PointerEvent<HTMLElement>) => void;
  end: (event: PointerEvent<HTMLElement>) => void;
  cancel: (event: PointerEvent<HTMLElement>) => void;
} {
  const [drag, setDrag] = useState<LayerReorderDrag | null>(null);
  const dragRef = useRef<LayerReorderDrag | null>(null);
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
    event.currentTarget.setPointerCapture(event.pointerId);
    const next = { layerId, pointerId: event.pointerId, originIndex: index, targetIndex: index };
    dragRef.current = next;
    setDrag(next);
  };
  const move = (event: PointerEvent<HTMLElement>): void => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault();
    const targetIndex = indexAtPoint(event.clientX, event.clientY);
    if (targetIndex === null || targetIndex === current.targetIndex) return;
    const next = { ...current, targetIndex };
    dragRef.current = next;
    setDrag(next);
  };
  const end = (event: PointerEvent<HTMLElement>): void => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const targetIndex = indexAtPoint(event.clientX, event.clientY) ?? current.targetIndex;
    dragRef.current = null;
    setDrag(null);
    if (targetIndex !== current.originIndex) onMoveLayer(current.layerId, targetIndex);
  };
  const cancel = (event: PointerEvent<HTMLElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDrag(null);
  };
  return { begin, cancel, drag, end, move };
}
