import { describe, expect, it, vi } from 'vitest';
import { DragEdgeScroll, type FrameClock } from './drag-edge-scroll';
import { EDGE_SCROLL_MAX_SPEED } from './program-grid-geometry';

function clock(): FrameClock & { run: (time: number) => void; pending: () => number } {
  const frames = new Map<number, (time: number) => void>(); let next = 1;
  return {
    request: callback => { frames.set(next, callback); return next++; },
    cancel: frame => { frames.delete(frame); },
    run: time => { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(time); },
    pending: () => frames.size
  };
}
const list = (maximum = 10_000) => {
  let top = 100;
  return {
    get scrollTop(): number { return top; },
    set scrollTop(value: number) { top = Math.max(0, Math.min(maximum, value)); },
    getBoundingClientRect: () => ({ left: 0, top: 200, width: 400, height: 400 })
  };
};

describe('拖动排序时靠边自动滚动', () => {
  it('停在下边缘不动也一直往下滚，插入标记跟着刷新', () => {
    const frames = clock(), scrolled = vi.fn(), scroller = list();
    const edge = new DragEdgeScroll(frames, scrolled);
    edge.follow(scroller, { x: 50, y: 600 });
    frames.run(0); frames.run(20); frames.run(40);
    expect(scroller.scrollTop).toBe(100 + Math.trunc(EDGE_SCROLL_MAX_SPEED / 60) + 24 + 24);
    expect(scrolled).toHaveBeenCalledTimes(3); expect(scrolled).toHaveBeenLastCalledWith({ x: 50, y: 600 });
    expect(frames.pending()).toBe(1);
  });
  it('上边缘往上滚；鼠标离开边缘带就停，再回来接着滚', () => {
    const frames = clock(), scroller = list(), edge = new DragEdgeScroll(frames, vi.fn());
    edge.follow(scroller, { x: 50, y: 200 }); frames.run(0);
    expect(scroller.scrollTop).toBeLessThan(100);
    const stopped = scroller.scrollTop;
    edge.follow(scroller, { x: 50, y: 400 }); frames.run(16);
    expect(scroller.scrollTop).toBe(stopped); expect(frames.pending()).toBe(0);
    edge.follow(scroller, { x: 50, y: 210 }); expect(frames.pending()).toBe(1);
    frames.run(1000); expect(scroller.scrollTop).toBeLessThan(stopped);
  });
  it('放下、Esc 取消或离开页面时 stop：不再滚', () => {
    const frames = clock(), scrolled = vi.fn(), scroller = list(), edge = new DragEdgeScroll(frames, scrolled);
    edge.follow(scroller, { x: 50, y: 600 }); edge.stop();
    expect(frames.pending()).toBe(0); frames.run(0);
    expect(scroller.scrollTop).toBe(100); expect(scrolled).not.toHaveBeenCalled();
    // The next drag starts afresh.
    edge.follow(scroller, { x: 50, y: 600 }); expect(frames.pending()).toBe(1);
    frames.run(5000); expect(scroller.scrollTop).toBe(100 + EDGE_SCROLL_MAX_SPEED / 60);
  });
  it('滚到底就停，不空转；慢速时零碎的距离攒够 1 px 再滚', () => {
    const frames = clock(), scrolled = vi.fn(), scroller = list(130), edge = new DragEdgeScroll(frames, scrolled);
    edge.follow(scroller, { x: 50, y: 600 });
    for (let time = 0; time < 200; time += 16) frames.run(time);
    expect(scroller.scrollTop).toBe(130); expect(frames.pending()).toBe(0);
    const slow = list(), slowEdge = new DragEdgeScroll(frames, vi.fn());
    // Just inside the band: 142.5 px/s, 2.28 px per 16 ms frame. Dropping the fraction would give 122 px in 61 frames.
    slowEdge.follow(slow, { x: 50, y: 553 });
    for (let time = 0; time <= 16 * 60; time += 16) frames.run(time);
    expect(slow.scrollTop - 100).toBeGreaterThanOrEqual(138); expect(slow.scrollTop - 100).toBeLessThanOrEqual(140);
  });
  it('列表左右以外不滚', () => {
    const frames = clock(), scroller = list(), edge = new DragEdgeScroll(frames, vi.fn());
    edge.follow(scroller, { x: 500, y: 600 });
    expect(frames.pending()).toBe(0);
  });
});
