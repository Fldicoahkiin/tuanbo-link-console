import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Ma2LayoutSnapshot } from '@tb/schema';

export function Ma2LayoutCanvas({ snapshot, items, zoom, editing, onMove }: { snapshot: Ma2LayoutSnapshot; items: Array<{ item: Ma2LayoutSnapshot['items'][number]; content: ReactNode }>; zoom: number; editing: boolean; onMove: (id: string, x: number, y: number) => void }): JSX.Element {
  const viewport = useRef<HTMLDivElement>(null); const [size, setSize] = useState({ width: 800, height: 300 });
  const [drag, setDrag] = useState<{ id: string; x: number; y: number; startX: number; startY: number; dx: number; dy: number } | null>(null);
  useLayoutEffect(() => { const node = viewport.current; if (!node) return; setSize({ width: node.clientWidth, height: node.clientHeight }); const observer = new ResizeObserver(([entry]) => { if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height }); }); observer.observe(node); return () => observer.disconnect(); }, []);
  // A readback must not recenter the canvas under the user's pointer. Fit is explicit.
  const [{ left, right, top, bottom }] = useState(() => ({ left: Math.min(...snapshot.items.map(item => item.x - item.width / 2)), right: Math.max(...snapshot.items.map(item => item.x + item.width / 2)), top: Math.max(...snapshot.items.map(item => item.y + item.height / 2)), bottom: Math.min(...snapshot.items.map(item => item.y - item.height / 2)) }));
  const unit = Math.max(.01, Math.min(48, (size.width - 24) / (right - left), (size.height - 24) / (top - bottom))) * zoom;
  return <div className="ma2-layout-viewport" ref={viewport} aria-label={`Layout ${snapshot.layout} 原位置`} data-editing={editing}>
    <div className="ma2-layout-surface" style={{ width: Math.max(size.width, (right - left) * unit + 24), height: Math.max(size.height, (top - bottom) * unit + 24) }}>
      {items.map(({ item, content }) => <div className="ma2-layout-object" key={item.id} data-layout-object={item.id} title={`X ${item.x} · Y ${item.y}`} style={{ left: 12 + (item.x - item.width / 2 - left) * unit + (drag?.id === item.id ? drag.dx : 0), top: 12 + (top - item.y - item.height / 2) * unit + (drag?.id === item.id ? drag.dy : 0), width: item.width * unit, height: item.height * unit }}
        onClickCapture={event => { if (editing) { event.preventDefault(); event.stopPropagation(); } }}
        onPointerDown={event => { if (!editing || event.button !== 0) return; event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); setDrag({ id: item.id, x: item.x, y: item.y, startX: event.clientX, startY: event.clientY, dx: 0, dy: 0 }); }}
        onPointerMove={event => { if (drag?.id === item.id) setDrag({ ...drag, dx: event.clientX - drag.startX, dy: event.clientY - drag.startY }); }}
        onPointerCancel={() => setDrag(null)} onPointerUp={event => { if (!drag || drag.id !== item.id) return; event.currentTarget.releasePointerCapture(event.pointerId); setDrag(null); if (Math.abs(drag.dx) + Math.abs(drag.dy) > 2) onMove(item.id, Math.round((drag.x + drag.dx / unit) * 1000) / 1000, Math.round((drag.y - drag.dy / unit) * 1000) / 1000); }}>
        {content}
      </div>)}
    </div>
  </div>;
}
