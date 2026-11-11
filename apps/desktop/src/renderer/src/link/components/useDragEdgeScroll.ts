import { useCallback, useEffect, useRef, useState } from 'react';
import { DragEdgeScroll } from './drag-edge-scroll';
import type { Point } from './program-grid-geometry';

/** Edge scrolling (`DragEdgeScroll`) for a list that drags its items; it stops when the component leaves. */
export function useDragEdgeScroll(onScrolled: (pointer: Point) => void): { follow: (scroller: HTMLElement, pointer: Point) => void; stop: () => void } {
  const scrolled = useRef(onScrolled);
  useEffect(() => { scrolled.current = onScrolled; });
  const [edge] = useState(() => new DragEdgeScroll({
    request: callback => requestAnimationFrame(callback),
    cancel: frame => cancelAnimationFrame(frame)
  }, pointer => scrolled.current(pointer)));
  useEffect(() => () => edge.stop(), [edge]);
  const follow = useCallback((scroller: HTMLElement, pointer: Point) => edge.follow(scroller, pointer), [edge]);
  const stop = useCallback(() => edge.stop(), [edge]);
  return { follow, stop };
}

/** The element that scrolls `element` vertically: itself or the nearest ancestor with room to scroll. */
export function verticalScrollerOf(element: HTMLElement): HTMLElement {
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    const overflow = getComputedStyle(current).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && current.scrollHeight > current.clientHeight) return current;
  }
  return element;
}
