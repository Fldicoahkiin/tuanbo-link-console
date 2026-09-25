import { useCallback, useEffect, useMemo, useRef, useState, type RefObject, type WheelEvent as ReactWheelEvent } from 'react';
import {
  buildVisibleTimelineTicks,
  chooseTimelineTickInterval,
  DEFAULT_TIMELINE_PIXELS_PER_SECOND,
  fitTimelinePixelsPerSecond,
  MAX_TIMELINE_PIXELS_PER_SECOND,
  MIN_TIMELINE_PIXELS_PER_SECOND,
  timelineContentWidth,
  timelineTimeFromClientX
} from './timeline-geometry';

type TimelineViewport = {
  viewportRef: RefObject<HTMLDivElement>;
  headingViewportRef: RefObject<HTMLDivElement>;
  onHeadingsWheel: (event: ReactWheelEvent) => void;
  pixelsPerSecond: number;
  scrollLeft: number;
  viewportWidth: number;
  contentWidth: number;
  gridSize: number;
  ticks: ReturnType<typeof buildVisibleTimelineTicks>;
  onScroll: () => void;
  timeAtClientX: (clientX: number) => number;
  editTimeAtClientX: (clientX: number) => number;
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  revealTime: (milliseconds: number) => void;
};

export function useTimelineViewport(durationMs: number, initialPixelsPerSecond = DEFAULT_TIMELINE_PIXELS_PER_SECOND, onWheelSeek?: (deltaMs: number) => number): TimelineViewport {
  const viewportRef = useRef<HTMLDivElement>(null);
  const headingViewportRef = useTimelineHeadings(viewportRef);
  const [pixelsPerSecond, setPixelsPerSecond] = useState(initialPixelsPerSecond);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(1);
  const contentWidth = timelineContentWidth(durationMs, pixelsPerSecond, viewportWidth);
  const ticks = useMemo(() => buildVisibleTimelineTicks({
    durationMs,
    pixelsPerSecond,
    scrollLeft,
    viewportWidth
  }), [durationMs, pixelsPerSecond, scrollLeft, viewportWidth]);
  const gridSize = chooseTimelineTickInterval(pixelsPerSecond) / 1_000 * pixelsPerSecond;

  const setViewportScrollLeft = useCallback((nextScrollLeft: number): void => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollLeft = Math.max(0, nextScrollLeft);
    setScrollLeft(viewport.scrollLeft);
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = (): void => setViewportWidth(Math.max(1, viewport.clientWidth));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const maximumScrollLeft = Math.max(0, contentWidth - viewport.clientWidth);
    if (viewport.scrollLeft > maximumScrollLeft) setViewportScrollLeft(maximumScrollLeft);
  }, [contentWidth, setViewportScrollLeft]);

  const zoomAt = useCallback((nextPixelsPerSecond: number, clientX?: number): void => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const next = Math.min(MAX_TIMELINE_PIXELS_PER_SECOND, Math.max(MIN_TIMELINE_PIXELS_PER_SECOND, nextPixelsPerSecond));
    const bounds = viewport.getBoundingClientRect();
    const anchorX = clientX ?? bounds.left + bounds.width / 2;
    const anchorTime = timelineTimeFromClientX({
      clientX: anchorX,
      viewportLeft: bounds.left,
      scrollLeft: viewport.scrollLeft,
      pixelsPerSecond,
      durationMs
    });
    setPixelsPerSecond(next);
    requestAnimationFrame(() => {
      setViewportScrollLeft(anchorTime / 1_000 * next - (anchorX - bounds.left));
    });
  }, [durationMs, pixelsPerSecond, setViewportScrollLeft]);

  const fit = useCallback((): void => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    setPixelsPerSecond(fitTimelinePixelsPerSecond(durationMs, viewport.clientWidth));
    requestAnimationFrame(() => setViewportScrollLeft(0));
  }, [durationMs, setViewportScrollLeft]);

  const revealTime = useCallback((milliseconds: number): void => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const timeX = Math.min(Math.max(0, milliseconds), durationMs) / 1_000 * pixelsPerSecond;
    const margin = Math.min(96, viewport.clientWidth * 0.2);
    const visibleLeft = viewport.scrollLeft + margin;
    const visibleRight = viewport.scrollLeft + viewport.clientWidth - margin;
    if (timeX < visibleLeft) setViewportScrollLeft(timeX - margin);
    else if (timeX > visibleRight) setViewportScrollLeft(timeX - viewport.clientWidth + margin);
  }, [durationMs, pixelsPerSecond, setViewportScrollLeft]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const wheel = (event: WheelEvent): void => {
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientWidth : 1;
      if (event.ctrlKey) {
        if (event.deltaY !== 0) zoomAt(pixelsPerSecond * (event.deltaY < 0 ? 1.18 : 1 / 1.18), event.clientX);
      } else if (onWheelSeek && !event.shiftKey && event.deltaY !== 0) {
        revealTime(onWheelSeek(event.deltaY * unit / pixelsPerSecond * 1_000));
      } else if (!event.shiftKey && event.deltaY !== 0 && viewport.scrollHeight > viewport.clientHeight) {
        viewport.scrollTop += event.deltaY * unit;
        if (event.deltaX !== 0) setViewportScrollLeft(viewport.scrollLeft + event.deltaX * unit);
      } else {
        setViewportScrollLeft(viewport.scrollLeft + (event.deltaX || event.deltaY) * unit);
      }
    };
    viewport.addEventListener('wheel', wheel, { passive: false });
    return () => viewport.removeEventListener('wheel', wheel);
  }, [pixelsPerSecond, setViewportScrollLeft, zoomAt, onWheelSeek, revealTime]);

  return {
    viewportRef,
    headingViewportRef,
    onHeadingsWheel: event => {
      const area = viewportRef.current;
      if (!area || event.ctrlKey || event.shiftKey) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? area.clientHeight : 1;
      area.scrollTop += event.deltaY * unit;
    },
    pixelsPerSecond,
    scrollLeft,
    viewportWidth,
    contentWidth,
    gridSize,
    ticks,
    onScroll: () => {
      setScrollLeft(viewportRef.current?.scrollLeft ?? 0);
      if (headingViewportRef.current && viewportRef.current) headingViewportRef.current.scrollTop = viewportRef.current.scrollTop;
    },
    timeAtClientX: (clientX) => {
      const viewport = viewportRef.current;
      if (!viewport) return 0;
      return timelineTimeFromClientX({
        clientX,
        viewportLeft: viewport.getBoundingClientRect().left,
        scrollLeft: viewport.scrollLeft,
        pixelsPerSecond,
        durationMs
      });
    },
    editTimeAtClientX: (clientX) => {
      const viewport = viewportRef.current;
      return viewport ? Math.min(86_399_000, Math.max(0, (clientX - viewport.getBoundingClientRect().left + viewport.scrollLeft) / pixelsPerSecond * 1000)) : 0;
    },
    zoomIn: () => zoomAt(pixelsPerSecond * 1.25),
    zoomOut: () => zoomAt(pixelsPerSecond / 1.25),
    fit,
    revealTime
  };
}

function useTimelineHeadings(viewportRef: RefObject<HTMLDivElement>): RefObject<HTMLDivElement> {
  const headingsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const area = viewportRef.current, headings = headingsRef.current;
    if (!area || !headings) return;
    const sync = (): void => { headings.style.height = `${area.clientHeight}px`; headings.scrollTop = area.scrollTop; };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(area);
    if (area.firstElementChild) observer.observe(area.firstElementChild);
    return () => observer.disconnect();
  }, [viewportRef]);
  return headingsRef;
}
