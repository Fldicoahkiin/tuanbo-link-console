import { useRef } from 'react';

export function AudioRowResizeHandle({ height, rulerHeight, onChange }: { height: number; rulerHeight: number; onChange: (height: number | null) => void }): JSX.Element {
  const drag = useRef<{ y: number; height: number } | null>(null);
  const resize = (value: number): void => onChange(Math.max(100, Math.min(600, Math.round(value))));
  return <button className="audio-row-resize" role="separator" aria-label="调整音频轨道高度" aria-orientation="horizontal" aria-valuemin={100} aria-valuemax={600} aria-valuenow={height} title="上下拖动调整波形高度；双击填满" style={{ top: rulerHeight + height - 4 }}
    onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.stopPropagation(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { y: event.clientY, height }; }}
    onPointerMove={event => { if (drag.current) { event.stopPropagation(); resize(drag.current.height + event.clientY - drag.current.y); } }}
    onPointerUp={event => { event.stopPropagation(); drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
    onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
    onKeyDown={event => { event.stopPropagation(); if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); resize(height + (event.key === 'ArrowUp' ? -10 : 10)); } if (event.key === 'Home') onChange(null); }}
    onDoubleClick={event => { event.stopPropagation(); onChange(null); }} />;
}
