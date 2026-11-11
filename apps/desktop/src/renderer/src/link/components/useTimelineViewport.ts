import { useCallback, useEffect, useMemo, useRef, useState, type RefObject, type WheelEvent as ReactWheelEvent } from 'react';
import { initialTimelineSize, useTimelineViewportSize } from './useTimelineViewportSize';
import { timelineMotion } from './timeline-motion';
import { nextScrollBlocks, scrollBlock, scrollWindow, TimelineScroll } from './timeline-scroll';
import {
  buildVisibleTimelineTicks,
  chooseTimelineTickInterval,
  DEFAULT_TIMELINE_PIXELS_PER_SECOND,
  fitTimelinePixelsPerSecond,
  MAX_TIMELINE_PIXELS_PER_SECOND,
  MIN_TIMELINE_PIXELS_PER_SECOND,
  timelineContentWidth,
  timelineEditTimeFromClientX,
  timelineTimeFromClientX
} from './timeline-geometry';

export type TimelineViewport = {
  viewportRef: RefObject<HTMLDivElement>;
  headingViewportRef: RefObject<HTMLDivElement>;
  onHeadingsWheel: (event: ReactWheelEvent) => void;
  pixelsPerSecond: number;
  /** Where the viewport is scrolled to, exactly, outside React (timeline-scroll.ts): for what follows the scroll in the DOM. */
  scroll: TimelineScroll;
  /** What React draws and culls by: the window of the scroll's 512 px block, which changes only when the scroll
   * crosses a block (0.5.9 E5). It always holds the visible part. */
  view: { left: number; width: number; top: number; height: number };
  viewportWidth: number;
  viewportHeight: number;
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
  /** Scrolls to `left`, held to the timeline's two ends; the only way besides the user's own scroll (0.5.9 E12, the edge scroll of a drag). */
  scrollLeftTo: (left: number) => void;
  /** How far right the timeline can scroll now. */
  maxScrollLeft: () => number;
};

function initialScrollLeft(durationMs: number, pixelsPerSecond: number, positionMs: number, fitKey?: string): number {
  if (fitKey !== undefined) return 0;
  const width = initialTimelineSize('visual').width;
  if (width <= 1) return 0;
  const x = Math.min(Math.max(0, positionMs), durationMs) / 1000 * pixelsPerSecond;
  return Math.min(Math.max(0, x - width + Math.min(96, width * 0.2)),
    Math.max(0, timelineContentWidth(durationMs, pixelsPerSecond, width) - width));
}

export function useTimelineViewport(durationMs: number, initialPixelsPerSecond = DEFAULT_TIMELINE_PIXELS_PER_SECOND, onWheelSeek?: (deltaMs: number) => number, fitKey?: string, initialPositionMs = 0): TimelineViewport {
  const viewportRef = useRef<HTMLDivElement>(null);
  const headingViewportRef = useTimelineHeadings(viewportRef);
  const [zoom, setZoom] = useState({ key: fitKey, manual: false, pixelsPerSecond: initialPixelsPerSecond });
  // The scroll position lives outside React; React hears only its block (0.5.9 E5).
  const [scroll] = useState(() => new TimelineScroll(initialScrollLeft(durationMs, initialPixelsPerSecond, initialPositionMs, fitKey), 0));
  const [block, setBlock] = useState(() => ({ x: scrollBlock(scroll.read().left), y: 0 }));
  const measuredScrollLeft = useRef(scroll.read().left);
  const measuredScrollTop = useRef(0);
  const revealFrame = useRef<number | null>(null);
  const layoutMode = fitKey === undefined ? 'visual' : 'lighting';
  const { width: viewportWidth, height: viewportHeight, observed: observedViewport } = useTimelineViewportSize(viewportRef, layoutMode, scroll.read().left);
  const scrolled = useCallback((left: number, top: number): void => {
    scroll.set(left, top);
    setBlock(previous => nextScrollBlocks(previous, left, top));
  }, [scroll]);
  const horizontal = scrollWindow(block.x, viewportWidth), vertical = scrollWindow(block.y, viewportHeight);
  const view = useMemo(() => ({ left: horizontal.start, width: horizontal.size, top: vertical.start, height: vertical.size }), [horizontal.start, horizontal.size, vertical.start, vertical.size]);
  const autoFit = fitKey !== undefined && (!zoom.manual || zoom.key !== fitKey);
  // Width and fitted scale must enter the same render. Updating the scale from
  // an effect after ResizeObserver caused another full editor layout at mount.
  const pixelsPerSecond = autoFit && viewportWidth > 1
    ? fitTimelinePixelsPerSecond(durationMs, viewportWidth) : zoom.pixelsPerSecond;
  const contentWidth = timelineContentWidth(durationMs, pixelsPerSecond, viewportWidth);
  const viewportMetrics = useRef({ contentWidth, viewportWidth });
  viewportMetrics.current = { contentWidth, viewportWidth };
  const ticks = useMemo(() => buildVisibleTimelineTicks({
    durationMs,
    pixelsPerSecond,
    scrollLeft: view.left,
    viewportWidth: view.width
  }), [durationMs, pixelsPerSecond, view.left, view.width]);
  const gridSize = chooseTimelineTickInterval(pixelsPerSecond) / 1_000 * pixelsPerSecond;

  const setViewportScrollLeft = useCallback((nextScrollLeft: number): void => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const metrics = viewportMetrics.current;
    const next = Math.min(Math.max(0, nextScrollLeft), Math.max(0, metrics.contentWidth - metrics.viewportWidth));
    if (next === measuredScrollLeft.current) return;
    viewport.scrollLeft = next;
    measuredScrollLeft.current = next;
    scrolled(next, measuredScrollTop.current);
  }, [scrolled]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const maximumScrollLeft = Math.max(0, contentWidth - viewportWidth);
    if (measuredScrollLeft.current > maximumScrollLeft) setViewportScrollLeft(maximumScrollLeft);
  }, [contentWidth, viewportWidth, setViewportScrollLeft]);

  const zoomAt = useCallback((nextPixelsPerSecond: number, clientX?: number): void => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const next = Math.min(MAX_TIMELINE_PIXELS_PER_SECOND, Math.max(MIN_TIMELINE_PIXELS_PER_SECOND, nextPixelsPerSecond));
    timelineMotion.moved();
    const bounds = viewport.getBoundingClientRect();
    const anchorX = clientX ?? bounds.left + bounds.width / 2;
    const anchorTime = timelineTimeFromClientX({
      clientX: anchorX,
      viewportLeft: bounds.left,
      scrollLeft: viewport.scrollLeft,
      pixelsPerSecond,
      durationMs
    });
    setZoom({ key: fitKey, manual: true, pixelsPerSecond: next });
    requestAnimationFrame(() => {
      setViewportScrollLeft(anchorTime / 1_000 * next - (anchorX - bounds.left));
    });
  }, [durationMs, pixelsPerSecond, setViewportScrollLeft, fitKey]);

  const fit = useCallback((): void => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    setZoom({ key: fitKey, manual: false, pixelsPerSecond: fitTimelinePixelsPerSecond(durationMs, viewportWidth) });
    requestAnimationFrame(() => setViewportScrollLeft(0));
  }, [durationMs, viewportWidth, setViewportScrollLeft, fitKey]);

  useEffect(() => {
    if (!autoFit || viewportWidth <= 1) return;
    const frame = requestAnimationFrame(() => setViewportScrollLeft(0));
    return () => cancelAnimationFrame(frame);
  }, [autoFit, fitKey, viewportWidth, setViewportScrollLeft]);

  const revealTime = useCallback((milliseconds: number): void => {
    const viewport = viewportRef.current;
    if (!viewport || viewportWidth <= 1 || !observedViewport.current) return;
    // Wait for an actual viewport width before scrolling a mounted editor.
    const timeX = Math.min(Math.max(0, milliseconds), durationMs) / 1_000 * pixelsPerSecond;
    const margin = Math.min(96, viewportWidth * 0.2);
    const visibleLeft = measuredScrollLeft.current + margin;
    const visibleRight = measuredScrollLeft.current + viewportWidth - margin;
    const next = timeX < visibleLeft ? timeX - margin
      : timeX > visibleRight ? timeX - viewportWidth + margin : null;
    if (revealFrame.current !== null) cancelAnimationFrame(revealFrame.current);
    revealFrame.current = next === null ? null : requestAnimationFrame(() => {
      revealFrame.current = null;
      setViewportScrollLeft(next);
    });
  }, [durationMs, pixelsPerSecond, viewportWidth, setViewportScrollLeft, observedViewport]);

  useEffect(() => () => { if (revealFrame.current !== null) cancelAnimationFrame(revealFrame.current); }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const wheel = (event: WheelEvent): void => {
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientWidth : 1;
      // Scrolled or zoomed by hand: the OBS live canvas draws fewer frames meanwhile. Wheel seeking moves the playhead, not the timeline.
      if (event.ctrlKey || !onWheelSeek || event.shiftKey || event.deltaY === 0) timelineMotion.moved();
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
      timelineMotion.moved();
      area.scrollTop += event.deltaY * unit;
    },
    pixelsPerSecond,
    scroll,
    view,
    viewportWidth,
    viewportHeight,
    contentWidth,
    gridSize,
    ticks,
    onScroll: () => {
      const left = viewportRef.current?.scrollLeft ?? 0, top = viewportRef.current?.scrollTop ?? 0;
      // A scroll this hook did not set itself (the scroll bar dragged) is the user's: the timeline is moving. The page
      // turning with the playhead is set here first, so it does not count; under a pixel is the browser rounding.
      if (Math.abs(left - measuredScrollLeft.current) >= 1 || Math.abs(top - measuredScrollTop.current) >= 1) timelineMotion.moved();
      measuredScrollLeft.current = left;
      measuredScrollTop.current = top;
      scrolled(left, top);
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
      return viewport ? timelineEditTimeFromClientX({ clientX, viewportLeft: viewport.getBoundingClientRect().left, scrollLeft: viewport.scrollLeft, pixelsPerSecond }) : 0;
    },
    zoomIn: () => zoomAt(pixelsPerSecond * 1.25),
    zoomOut: () => zoomAt(pixelsPerSecond / 1.25),
    fit, revealTime, scrollLeftTo: setViewportScrollLeft, maxScrollLeft: () => Math.max(0, viewportMetrics.current.contentWidth - viewportMetrics.current.viewportWidth)
  };
}

function useTimelineHeadings(viewportRef: RefObject<HTMLDivElement>): RefObject<HTMLDivElement> {
  const headingsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const area = viewportRef.current, headings = headingsRef.current;
    if (!area || !headings) return;
    // Measuring clientHeight here forced a full layout during the editor's
    // React commit. ResizeObserver already provides the laid-out viewport size;
    // vertical scrolling is mirrored by onScroll above.
    const observer = new ResizeObserver(entries => {
      const entry = entries.find(candidate => candidate.target === area);
      if (entry) headings.style.height = `${entry.contentRect.height}px`;
    });
    observer.observe(area);
    return () => observer.disconnect();
  }, [viewportRef]);
  return headingsRef;
}
