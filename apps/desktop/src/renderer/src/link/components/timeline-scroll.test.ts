import { describe, expect, it } from 'vitest';
import { nextScrollBlocks, pinnedSpan, SCROLL_BLOCK_PX, scrollBlock, scrollWindow, segmentNameLeft, TimelineScroll } from './timeline-scroll';
import { beatMarksInView, BEAT_MARK_GAP_PX, timeToX } from './timeline-geometry';

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

describe('时间线上的部件都按同一个 timeToX 放，缩放和滚动时位置一样', () => {
  it('timeToX 就是以前 DOM 部件算 left 的方法', () => {
    for (const pixelsPerSecond of [0.5, 32, 220, 480]) {
      for (const ms of [0, 1, 999, 30_000, 241_337]) expect(timeToX(ms, pixelsPerSecond)).toBe(ms / 1000 * pixelsPerSecond); // how the DOM parts placed it before 0.5.9
    }
  });

  it('几百个节拍：只画这一格窗口里的，相邻的至少隔 8 px，放大后又都画出来（0.5.9 E11）', () => {
    const beats = Array.from({ length: 600 }, (_, index) => index * 400); // 150 BPM, 4 minutes
    const view = { left: 1_024, width: 2_048 };
    for (const pixelsPerSecond of [2, 8, 32, 220]) {
      const shown = beatMarksInView(beats, ms => ms, pixelsPerSecond, view);
      const xs = shown.map(ms => timeToX(ms, pixelsPerSecond));
      expect(xs.every(x => x >= view.left - 8 && x <= view.left + view.width + 8)).toBe(true);
      expect(xs.slice(1).every((x, index) => x - xs[index]! >= BEAT_MARK_GAP_PX)).toBe(true);
      expect(shown.length).toBeLessThanOrEqual(Math.ceil((view.width + 16) / BEAT_MARK_GAP_PX) + 1);
    }
    // Zoomed in far enough, every beat in the window is drawn.
    const near = beatMarksInView(beats, ms => ms, 220, view);
    expect(near).toEqual(beats.filter(ms => timeToX(ms, 220) >= view.left - 8 && timeToX(ms, 220) <= view.left + view.width + 8));
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
