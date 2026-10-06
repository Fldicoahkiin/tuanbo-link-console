import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Columns2, Maximize, Minus, Plus } from 'lucide-react';
import type { BeautyTarget } from '@tb/schema';
import { ObsLiveCanvas } from './ObsLiveCanvas';
import { BeautyCompareCanvas } from './BeautyCompareCanvas';

type View = { zoom: number; x: number; y: number };
const fit: View = { zoom: 1, x: 0, y: 0 };
function bounded(view: View): View {
  const limit = (view.zoom - 1) / 2;
  return { ...view, x: Math.max(-limit, Math.min(limit, view.x)), y: Math.max(-limit, Math.min(limit, view.y)) };
}

/** Changes only the displayed preview; never sends source transforms or filter changes to OBS. */
export function BeautyPreview({ onAspectChange, target, onComparingChange }: { onAspectChange: (ratio: number) => void; target: BeautyTarget | null; onComparingChange: (active: boolean) => void }): JSX.Element {
  const [view, setView] = useState<View>(fit);
  const [comparing, setComparing] = useState(false);
  const comparisonActive = comparing && target !== null;
  useEffect(() => { onComparingChange(comparisonActive); return () => onComparingChange(false); }, [comparisonActive, onComparingChange]);
  useEffect(() => { setComparing(false); setView(fit); }, [target?.sourceName, target?.filterName]);
  const drag = useRef<{ id: number; x: number; y: number; view: View; width: number; height: number } | null>(null);
  const changeZoom = (amount: number): void => {
    drag.current = null;
    setView(current => {
      const zoom = Math.max(1, Math.min(4, current.zoom + amount));
      return bounded({ zoom, x: current.x * zoom / current.zoom, y: current.y * zoom / current.zoom });
    });
  };
  return <div className="beauty-preview-viewer" style={{ '--beauty-zoom': view.zoom, '--beauty-pan-x': `${view.x * 100}%`, '--beauty-pan-y': `${view.y * 100}%` } as CSSProperties}
    data-zoomed={view.zoom > 1} role="group" aria-label="预览查看区域" tabIndex={0}
    onKeyDown={event => {
      if (event.target !== event.currentTarget) return;
      if (event.key === '+' || event.key === '=') changeZoom(1);
      else if (event.key === '-') changeZoom(-1);
      else if (event.key === '0' || event.key === 'Escape') { drag.current = null; setView(fit); }
      else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        setView(current => bounded({ ...current,
          x: current.x + (event.key === 'ArrowLeft' ? .1 : event.key === 'ArrowRight' ? -.1 : 0),
          y: current.y + (event.key === 'ArrowUp' ? .1 : event.key === 'ArrowDown' ? -.1 : 0) }));
      } else return;
      event.preventDefault();
    }}
    onPointerDown={event => {
      if (view.zoom === 1 || event.button !== 0 || !(event.target instanceof HTMLCanvasElement)) return;
      const frame = event.target;
      if (!frame.clientWidth || !frame.clientHeight) return;
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, view, width: frame.clientWidth, height: frame.clientHeight };
      event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.focus(); event.preventDefault();
    }}
    onPointerMove={event => {
      const start = drag.current;
      if (!start || start.id !== event.pointerId) return;
      setView(bounded({ ...start.view, x: start.view.x + (event.clientX - start.x) / start.width,
        y: start.view.y + (event.clientY - start.y) / start.height }));
    }}
    onPointerUp={event => { if (drag.current?.id === event.pointerId) { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); } }}
    onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
    onDoubleClick={event => { if (event.target instanceof HTMLCanvasElement) { drag.current = null; setView(view.zoom === 1 ? { zoom: 2, x: 0, y: 0 } : fit); } }}>
    {comparing && target ? <BeautyCompareCanvas target={target} onAspectChange={onAspectChange} /> : <ObsLiveCanvas editable={false} onAspectChange={onAspectChange} />}
    <div className="beauty-preview-tools" aria-label="预览缩放">
      <button aria-label="缩小预览" disabled={view.zoom === 1} onClick={() => changeZoom(-1)}><Minus size={15} /></button>
      <span aria-live="polite">{view.zoom}×</span>
      <button aria-label="放大预览" disabled={view.zoom === 4} onClick={() => changeZoom(1)}><Plus size={15} /></button>
      <button aria-label="适应画面" title="适应画面（0）" onClick={() => { drag.current = null; setView(fit); }}><Maximize size={14} /></button>
      <button aria-label="前后对比" aria-pressed={comparing && !!target} disabled={!target} title="对比选中来源的美颜前后画面" onClick={() => { setComparing(value => !value); drag.current = null; setView(fit); }}><Columns2 size={15} /></button>
    </div>
    {view.zoom > 1 ? <span className="beauty-preview-pan-hint">拖动画面查看 · 仅放大预览</span> : null}
  </div>;
}
