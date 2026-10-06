import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

const ROW_HEIGHT = 78;
const OVERSCAN = 3;

/** Only mounted rows may acquire thumbnail/decoder resources. Focused editors stay mounted. */
export function VirtualResourceList({ keys, renderRow, onContextMenu }: {
  keys: string[];
  renderRow: (index: number) => ReactNode;
  onContextMenu: (x: number, y: number) => void;
}): JSX.Element {
  const viewport = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ top: 0, height: 600 });
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [requestedFocus, setRequestedFocus] = useState<number | null>(null);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(entries => {
      const entry = entries[0]; if (!entry) return;
      const top = element.scrollTop, height = entry.contentRect.height;
      setRange(current => current.top === top && current.height === height ? current : { top, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // A search can shrink a list while it is scrolled near the end.
  const start = Math.max(0, Math.min(keys.length - 1, Math.floor(range.top / ROW_HEIGHT) - OVERSCAN));
  const end = Math.min(keys.length, start + Math.ceil(range.height / ROW_HEIGHT) + OVERSCAN * 2);
  const indices = new Set(Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index));
  const focused = focusedKey === null ? -1 : keys.indexOf(focusedKey);
  if (focused >= 0) indices.add(focused);
  if (requestedFocus !== null && requestedFocus < keys.length) indices.add(requestedFocus);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const maximum = Math.max(0, keys.length * ROW_HEIGHT - range.height);
    if (range.top > maximum) {
      element.scrollTop = maximum;
      setRange(current => ({ ...current, top: maximum }));
    }
    if (requestedFocus !== null) {
      element.querySelector<HTMLElement>(`[data-resource-index="${requestedFocus}"] > [tabindex]`)?.focus({ preventScroll: true });
      setRequestedFocus(null);
    }
  }, [keys.length, requestedFocus, range.height, range.top]);
  return <div ref={viewport} className="media-resource-table media-view-list" onScroll={event => {
    const element = event.currentTarget;
    const top = element.scrollTop;
    setRange(current => current.top === top ? current : { ...current, top });
  }} onContextMenu={event => { event.preventDefault(); onContextMenu(event.clientX, event.clientY); }}
    onFocusCapture={event => {
      const index = event.target.closest<HTMLElement>('[data-resource-index]')?.dataset.resourceIndex;
      if (index !== undefined) setFocusedKey(keys[Number(index)] ?? null);
    }}
    onKeyDown={event => {
      const row = event.target instanceof HTMLElement ? event.target : null;
      if (!row?.classList.contains('media-table-row')) return;
      const index = Number(row.parentElement?.dataset.resourceIndex);
      if (!Number.isInteger(index)) return;
      const next = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1
        : event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1 : null;
      if (next === null || !keys.length) return;
      event.preventDefault();
      const target = Math.max(0, Math.min(keys.length - 1, next));
      const element = event.currentTarget;
      if (target * ROW_HEIGHT < element.scrollTop) element.scrollTop = target * ROW_HEIGHT;
      else if ((target + 1) * ROW_HEIGHT > element.scrollTop + element.clientHeight) element.scrollTop = (target + 1) * ROW_HEIGHT - element.clientHeight;
      setRange({ top: element.scrollTop, height: element.clientHeight });
      setRequestedFocus(target);
    }}>
    <div className="media-table-body media-virtual-body" style={{ height: keys.length * ROW_HEIGHT }}>
      {[...indices].sort((left, right) => left - right).map(index => <div key={keys[index]} data-resource-index={index}
        className="media-virtual-row" style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}>{renderRow(index)}</div>)}
    </div>
  </div>;
}
