import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

type Mode = 'visual' | 'lighting';
const measured = new Map<Mode, { windowWidth: number; windowHeight: number; width: number; height: number }>();

export function initialTimelineSize(mode: Mode): { width: number; height: number } {
  const value = measured.get(mode);
  return value?.windowWidth === window.innerWidth && value.windowHeight === window.innerHeight
    ? value : { width: 1, height: 1 };
}

/** Cache only the two layout modes; geometry always follows real observations.
 * Scroll restoration waits for layout, so mounting cannot force a second one. */
export function useTimelineViewportSize(viewportRef: RefObject<HTMLDivElement>, mode: Mode, initialScrollLeft: number) {
  const [size, setSize] = useState(() => initialTimelineSize(mode));
  const observed = useRef(false), initialScroll = useRef(initialScrollLeft);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(entries => {
      const entry = entries[0]; if (!entry) return;
      if (!observed.current && initialScroll.current > 0) viewport.scrollLeft = initialScroll.current;
      observed.current = true;
      const width = Math.max(1, entry.contentRect.width), height = Math.max(1, entry.contentRect.height);
      measured.set(mode, { windowWidth: window.innerWidth, windowHeight: window.innerHeight, width, height });
      setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [mode, viewportRef]);
  return { ...size, observed };
}
