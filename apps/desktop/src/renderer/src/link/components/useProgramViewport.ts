import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

/** Program cards: three lines (index and title, duration and contents, MTC start) at least this wide. */
const CARD_MIN_WIDTH = 232, CARD_HEIGHT = 92, CARD_GAP = 8;

export function useProgramViewport(ids: string[], view: 'list' | 'cards', compact: boolean) {
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0, top: 0 });
  const [focused, setFocused] = useState<string | null>(null);
  const [requested, setRequested] = useState<number | null>(null);
  useEffect(() => {
    const element = viewport.current; if (!element) return;
    const observer = new ResizeObserver(entries => {
      const entry = entries[0]; if (!entry) return;
      const width = entry.contentRect.width, height = entry.contentRect.height;
      setSize(previous => previous.width === width && previous.height === height ? previous : { ...previous, width, height });
    });
    observer.observe(element); return () => observer.disconnect();
  }, []);
  const columns = view === 'list' ? 1 : Math.max(1, Math.floor((size.width + CARD_GAP) / (CARD_MIN_WIDTH + CARD_GAP)));
  // Cards share the row's width, so they grow with the window instead of leaving a gap on the right.
  const cardWidth = size.width ? (size.width - (columns - 1) * CARD_GAP) / columns : CARD_MIN_WIDTH;
  const height = view === 'cards' ? CARD_HEIGHT : compact || size.width < 600 ? 96 : 56;
  const gap = view === 'cards' ? CARD_GAP : 3, step = height + gap;
  const rows = Math.ceil(ids.length / columns), totalHeight = Math.max(0, rows * step - gap);
  const start = Math.max(0, Math.floor(size.top / step) - 1) * columns;
  const end = Math.min(ids.length, (Math.ceil((size.top + size.height) / step) + 1) * columns);
  const indices = new Set(Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index));
  const focusedIndex = focused ? ids.indexOf(focused) : -1;
  if (focusedIndex >= 0) indices.add(focusedIndex);
  if (requested !== null && requested < ids.length) indices.add(requested);
  useLayoutEffect(() => {
    const element = viewport.current; if (!element) return;
    const maximum = Math.max(0, totalHeight - size.height);
    if (size.top > maximum) {
      element.scrollTop = maximum;
      setSize(previous => ({ ...previous, top: maximum }));
    }
    if (requested !== null) {
      element.querySelector<HTMLElement>(`[data-program-index="${requested}"] > article`)?.focus({ preventScroll: true });
      setRequested(null);
    }
  }, [requested, totalHeight, size.height, size.top]);
  const keyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || !(event.target instanceof HTMLElement) || !event.target.matches('article[data-program-id]')) return;
    const index = ids.indexOf(event.target.dataset.programId ?? '');
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1
      : event.key === 'ArrowDown' ? index + columns : event.key === 'ArrowUp' ? index - columns
      : event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : null;
    if (next === null || !ids.length) return;
    event.preventDefault(); event.stopPropagation();
    const target = Math.max(0, Math.min(ids.length - 1, next)), top = Math.floor(target / columns) * step, element = event.currentTarget;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + height > element.scrollTop + size.height) element.scrollTop = top + height - size.height;
    setSize(previous => ({ ...previous, top: element.scrollTop })); setRequested(target);
  };
  return { viewport, indices: [...indices].sort((a, b) => a - b), totalHeight, setFocused, keyDown,
    scroll: (top: number) => setSize(previous => previous.top === top ? previous : { ...previous, top }),
    style: (index: number) => ({ top: Math.floor(index / columns) * step, left: view === 'list' ? 0 : Math.round(index % columns * (cardWidth + CARD_GAP)),
      height, width: view === 'list' ? '100%' : Math.floor(cardWidth) }),
    /** The insertion marker of a drag: a bar in the gap before or after the card at `index`, 2 px across. */
    insertion: (index: number, placement: 'before' | 'after') => {
      const top = Math.floor(index / columns) * step, left = Math.round(index % columns * (cardWidth + CARD_GAP));
      return view === 'list'
        ? { top: Math.round(placement === 'before' ? top - gap / 2 : top + height + gap / 2) - 1, left: 0, width: '100%', height: 2 }
        : { top, left: Math.round(placement === 'before' ? left - CARD_GAP / 2 : left + cardWidth + CARD_GAP / 2) - 1, width: 2, height };
    } };
}
