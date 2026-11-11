import { useLayoutEffect, useRef } from 'react';
import { timeToX } from './timeline-geometry';
import type { TimelineScroll } from './timeline-scroll';
import './timeline-canvas.css';

/*
 * A canvas for what the timeline shows densely and nobody presses directly: the waveform overview and the beat
 * marks (0.5.9 E5, 05 设计 4.7). It sits over the visible part of the content and follows the scroll and the zoom
 * without React: a scroll redraws it at once, at the place the DOM parts would be (`canvasX`, by the same `timeToX`).
 * Its size is observed once, when it is put on the page. Colours come from the page's CSS at each drawing.
 */

/** What one drawing covers: the content from `scrollLeft`, `width` × `height` CSS px, at this zoom. */
export type CanvasView = { scrollLeft: number; width: number; height: number; pixelsPerSecond: number };

/** Where a time is on the canvas: its place on the content less the scroll, so it lands on the DOM part's `left`. */
export function canvasX(milliseconds: number, view: Pick<CanvasView, 'scrollLeft' | 'pixelsPerSecond'>): number {
  return timeToX(milliseconds, view.pixelsPerSecond) - view.scrollLeft;
}

/** The canvas sized for the view at the screen's pixel ratio, cleared, its context in CSS px. */
export function canvasContext(canvas: HTMLCanvasElement, view: CanvasView): CanvasRenderingContext2D {
  const ratio = globalThis.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(view.width * ratio)), height = Math.max(1, Math.floor(view.height * ratio));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法绘制时间线');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, view.width, view.height);
  return context;
}

export type CanvasPaint = (canvas: HTMLCanvasElement, view: CanvasView) => void;

export function TimelineCanvasLayer({ scroll, pixelsPerSecond, viewportWidth, className, paint }: {
  scroll: TimelineScroll; pixelsPerSecond: number; viewportWidth: number; className: string;
  /** Draws the view; a new `paint` (what is drawn changed) draws again. */
  paint: CanvasPaint;
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const height = useRef(0);
  const draw = useRef<() => void>(() => undefined);
  draw.current = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { left } = scroll.read();
    canvas.style.left = `${left}px`;
    canvas.style.width = `${viewportWidth}px`;
    if (height.current <= 0 || viewportWidth <= 1) return;
    paint(canvas, { scrollLeft: left, width: viewportWidth, height: height.current, pixelsPerSecond });
    canvas.dataset.ready = 'true';
  };
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // ResizeObserver gives the laid-out height without reading the layout during the commit.
    const observer = new ResizeObserver(entries => {
      const next = entries[0]?.contentRect.height ?? 0;
      if (next === height.current) return;
      height.current = next;
      draw.current();
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => scroll.subscribe(() => draw.current()), [scroll]);
  // What is drawn, the zoom or the width changed.
  useLayoutEffect(() => { draw.current(); }, [paint, pixelsPerSecond, viewportWidth, scroll]);
  return <canvas ref={canvasRef} className={`timeline-canvas-layer ${className}`} aria-hidden="true" />;
}
