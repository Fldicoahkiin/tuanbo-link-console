import { useLayoutEffect } from 'react';

/*
 * Where the timeline is scrolled to, outside React (0.5.9 E5, 05 设计 4.7). A scroll event writes the position here
 * and tells the few things that follow it exactly (the canvas layer, the playhead's time, labels kept at the left
 * edge, a held part); React hears only the block, which changes when the scroll crosses 512 px. What React draws is
 * culled to the block's window, which holds the visible part for any scroll inside the block.
 */

export const SCROLL_BLOCK_PX = 512;

export type ScrollPosition = { readonly left: number; readonly top: number };

/** The block a scroll offset is in: 0 for 0–511 px, 1 for 512–1023 px, … */
export function scrollBlock(offset: number): number {
  return Math.floor(Math.max(0, offset) / SCROLL_BLOCK_PX);
}

export type ScrollBlocks = { readonly x: number; readonly y: number };

/** The blocks after a scroll to (`left`, `top`): the same object while neither changes, so React does not hear it. */
export function nextScrollBlocks(previous: ScrollBlocks, left: number, top: number): ScrollBlocks {
  const x = scrollBlock(left), y = scrollBlock(top);
  return previous.x === x && previous.y === y ? previous : { x, y };
}

/**
 * The part of the content React draws while the scroll is in `block`: from the block's start, the viewport's size
 * and one block more, so whatever the scroll inside the block, all that is visible is inside it.
 */
export function scrollWindow(block: number, size: number): { start: number; size: number } {
  return { start: block * SCROLL_BLOCK_PX, size: size + SCROLL_BLOCK_PX };
}

/* Things kept at the visible edge, which follow the exact scroll (useScrollPaint). */

/** A section's button, kept inside the visible part so its name stays readable at the left edge. */
export function pinnedSpan(x: number, end: number, scrollLeft: number, viewportWidth: number): { left: number; width: number; visible: boolean } {
  const left = Math.max(x, scrollLeft);
  return { left, width: Math.max(4, Math.min(end, scrollLeft + viewportWidth) - left), visible: end >= scrollLeft && x <= scrollLeft + viewportWidth };
}

/** Where a segment's name sits inside it: 8 px in from the visible left edge, so it stays readable while scrolled. */
export function segmentNameLeft(segmentLeft: number, scrollLeft: number): number {
  return Math.max(8, scrollLeft - segmentLeft + 8);
}

type Listener = (at: ScrollPosition) => void;

/** One timeline's scroll position. Written by its viewport only (useTimelineViewport). */
export class TimelineScroll {
  private at: ScrollPosition;
  private readonly listeners = new Set<Listener>();

  constructor(left = 0, top = 0) { this.at = { left, top }; }

  read = (): ScrollPosition => this.at;

  /** The viewport scrolled: tells every listener when it moved. */
  set(left: number, top: number): void {
    if (left === this.at.left && top === this.at.top) return;
    this.at = { left, top };
    for (const listener of [...this.listeners]) listener(this.at);
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
}

/** Writes something that follows the exact scroll into the DOM: now, on every scroll, and whenever `paint` changes. */
export function useScrollPaint(scroll: TimelineScroll, paint: Listener): void {
  useLayoutEffect(() => {
    paint(scroll.read());
    return scroll.subscribe(paint);
  }, [paint, scroll]);
}
