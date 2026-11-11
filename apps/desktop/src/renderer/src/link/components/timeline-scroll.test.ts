import { describe, expect, it } from 'vitest';
import { nextScrollBlocks, pinnedSpan, SCROLL_BLOCK_PX, scrollBlock, scrollWindow, segmentNameLeft, TimelineScroll } from './timeline-scroll';
import { canvasX } from './TimelineCanvasLayer';
import { timeToX } from './timeline-geometry';

describe('滚动只在跨过 512 px 时让 React 知道（0.5.9 E5）', () => {
  it('块号只在跨 512 px 时变', () => {
    expect([0, 1, 511].map(scrollBlock)).toEqual([0, 0, 0]);
    expect([512, 1_023].map(scrollBlock)).toEqual([1, 1]);
    expect(scrollBlock(1_024)).toBe(2);
    expect(scrollBlock(-3)).toBe(0);
    // A scroll px by px across 0–2 048 px tells React 4 times, once at each 512 px crossed, not 2 048 times.
    let blocks = { x: 0, y: 0 }, told = 0;
    for (let left = 0; left <= 2_048; left += 1) {
      const next = nextScrollBlocks(blocks, left, 0);
      if (next !== blocks) told += 1;
      blocks = next;
    }
    expect(told).toBe(4);
    // Inside a block the same object comes back, so the React state does not change.
    const inside = { x: 1, y: 0 };
    expect(nextScrollBlocks(inside, 700, 100)).toBe(inside);
    expect(nextScrollBlocks(inside, 700, 600)).toEqual({ x: 1, y: 1 });
  });

  it('块的窗口总是盖住看得见的部分，块里怎么滚都一样', () => {
    for (const width of [1, 640, 1_280, 3_000]) {
      for (let scroll = 0; scroll < 4 * SCROLL_BLOCK_PX; scroll += 37) {
        const window = scrollWindow(scrollBlock(scroll), width);
        expect(window.start).toBeLessThanOrEqual(scroll);
        expect(window.start + window.size).toBeGreaterThanOrEqual(scroll + width);
      }
    }
  });

  it('滚动位置变了才通知', () => {
    const scroll = new TimelineScroll(10, 0), heard: number[] = [];
    const stop = scroll.subscribe(at => heard.push(at.left));
    scroll.set(10, 0); scroll.set(20, 0); scroll.set(20, 0); scroll.set(30, 5);
    stop(); scroll.set(40, 5);
    expect(heard).toEqual([20, 30]);
    expect(scroll.read()).toEqual({ left: 40, top: 5 });
  });
});

describe('画布层和 DOM 用同一个 timeToX，缩放和滚动时位置一样', () => {
  it('画布上的 x 加上画布的位置（滚动位置）就是 DOM 部件的 left', () => {
    for (const pixelsPerSecond of [0.5, 32, 220, 480]) {
      for (const scrollLeft of [0, 137, 4_096.5, 60_000]) {
        for (const ms of [0, 1, 999, 30_000, 241_337]) {
          const domLeft = ms / 1000 * pixelsPerSecond; // how the DOM parts placed it before 0.5.9
          expect(timeToX(ms, pixelsPerSecond)).toBe(domLeft);
          expect(canvasX(ms, { scrollLeft, pixelsPerSecond }) + scrollLeft).toBeCloseTo(domLeft, 9);
        }
      }
    }
  });

  it('按住滚动位置贴边的字：和以前按 React 里的滚动位置算的一样', () => {
    for (const scrollLeft of [0, 300, 900]) {
      // An audio segment's name, 8 px in from the visible left edge.
      expect(segmentNameLeft(400, scrollLeft)).toBe(Math.max(8, scrollLeft - 400 + 8));
      // A recognised section on the lighting ruler, cut to the visible part.
      const place = pinnedSpan(400, 1_000, scrollLeft, 500);
      expect(place.left).toBe(Math.max(400, scrollLeft));
      expect(place.width).toBe(Math.max(4, Math.min(1_000, scrollLeft + 500) - Math.max(400, scrollLeft)));
    }
    // Inside the drawn window but scrolled past: hidden, not a 4 px sliver at the edge.
    expect(pinnedSpan(0, 200, 300, 500).visible).toBe(false);
    expect(pinnedSpan(0, 400, 300, 500).visible).toBe(true);
  });
});
