import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** Fixed-height compact cells; the DOM grows with the viewport, not the Show. */
export function CuePoolGrid({ keys, label, render, cellWidth = 132, rowHeight = 34 }: { rowHeight?: number; cellWidth?: number; keys: string[]; label: string; render: (index: number) => ReactNode }): JSX.Element {
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 500, height: 320, top: 0 });
  const [focused, setFocused] = useState<string | null>(null);
  const [requested, setRequested] = useState<number | null>(null);
  const columns = Math.max(1, Math.floor(size.width / cellWidth));
  const height = Math.ceil(keys.length / columns) * rowHeight;
  const start = Math.max(0, Math.min(Math.ceil(keys.length / columns) - 1, Math.floor(size.top / rowHeight) - 2)) * columns;
  const end = Math.min(keys.length, start + (Math.ceil(size.height / rowHeight) + 4) * columns);
  const indices = new Set(Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index));
  const focusIndex = focused ? keys.indexOf(focused) : -1;
  if (focusIndex >= 0) indices.add(focusIndex);
  if (requested !== null && requested < keys.length) indices.add(requested);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setSize({ width: element.clientWidth, height: element.clientHeight, top: element.scrollTop }));
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const top = Math.min(size.top, Math.max(0, height - size.height));
    if (top !== size.top) { element.scrollTop = top; setSize(current => ({ ...current, top })); }
    if (requested !== null) { element.querySelector<HTMLElement>(`[data-cue-cell="${requested}"] button`)?.focus({ preventScroll: true }); setRequested(null); }
  }, [height, size.top, size.height, requested]);
  return <div className="cue-pool-grid" ref={viewport} aria-label={label} data-total-cues={keys.length}
    onScroll={event => { const top = event.currentTarget.scrollTop; setSize(current => ({ ...current, top })); }}
    onFocusCapture={event => { const index = event.target.closest<HTMLElement>('[data-cue-cell]')?.dataset.cueCell; if (index !== undefined) setFocused(keys[Number(index)] ?? null); }}
    onKeyDown={event => {
      const value = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-cue-cell]')?.dataset.cueCell : undefined;
      if (value === undefined) return;
      const index = Number(value);
      const next = ({ ArrowRight: index + 1, ArrowLeft: index - 1, ArrowDown: index + columns, ArrowUp: index - columns, Home: 0, End: keys.length - 1 } as Record<string, number>)[event.key];
      if (next === undefined || !keys.length) return;
      event.preventDefault();
      const target = Math.max(0, Math.min(keys.length - 1, next));
      const top = Math.floor(target / columns) * rowHeight;
      const element = event.currentTarget;
      if (top < element.scrollTop) element.scrollTop = top;
      else if (top + rowHeight > element.scrollTop + element.clientHeight) element.scrollTop = top + rowHeight - element.clientHeight;
      setSize(current => ({ ...current, top: element.scrollTop })); setRequested(target);
    }}><div style={{ position: 'relative', height }}>{[...indices].sort((a, b) => a - b).map(index => <div key={keys[index]} data-cue-cell={index} style={{ position: 'absolute', top: Math.floor(index / columns) * rowHeight, left: `${index % columns * 100 / columns}%`, width: `${100 / columns}%`, height: rowHeight, padding: 3 }}>{render(index)}</div>)}</div></div>;
}
