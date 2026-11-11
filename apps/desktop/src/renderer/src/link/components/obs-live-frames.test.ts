import { describe, expect, it } from 'vitest';
import type { FrameScheduler } from './drag-preview';
import { LIVE_FRAME_MS, LiveFrameLoop, LiveFramePainter, MOVING_FRAME_MS, liveFrameInterval, livePreviewRun, livePreviewWanted, type LiveFrame, type LiveFrameClock } from './obs-live-frames';
import { TIMELINE_REST_MS, TimelineMotion } from './timeline-motion';

/** A display at `hz` frames a second, a clock and a timeline that the test moves by hand. */
function testDisplay(hz = 144) {
  let time = 0, queue = new Map<number, () => void>(), next = 1;
  const frames: FrameScheduler = {
    request: (draw) => { queue.set(next, draw); return next++; },
    cancel: (frame) => { queue.delete(frame); }
  };
  const motion = new TimelineMotion(() => time);
  const clock: LiveFrameClock = { frames, now: () => time, timelineMoving: () => motion.moving() };
  const flush = async (): Promise<void> => { for (let index = 0; index < 6; index += 1) await Promise.resolve(); };
  /** Runs the display for `ms`; `during` happens before each display frame (a drag reporting, say). */
  const run = async (ms: number, during?: () => void): Promise<void> => {
    const end = time + ms;
    while (time + 1_000 / hz <= end + 1e-6) {
      time += 1_000 / hz;
      during?.();
      const due = queue; queue = new Map();
      for (const draw of due.values()) draw();
      await flush();
    }
  };
  return { clock, motion, run, waiting: () => queue.size, now: () => time };
}

const frame = (width = 2, height = 2): LiveFrame => ({ width, height, rgba: new Uint8Array(width * height * 4) });

function testLoop(display: ReturnType<typeof testDisplay>, editing = { value: false }) {
  const fetched: number[] = [], drawn: LiveFrame[] = [], failures: unknown[] = [];
  const loop = new LiveFrameLoop<LiveFrame>({
    fetch: () => { fetched.push(display.now()); return Promise.resolve(frame()); },
    draw: (next) => { drawn.push(next); },
    editingCanvas: () => editing.value,
    failed: (reason) => { failures.push(reason); }
  }, display.clock);
  return { loop, fetched, drawn, failures };
}

describe('OBS 实时画布的帧数上限', () => {
  it('平时每秒约 30 帧，请求本身就按上限发，不是全速取再丢', async () => {
    const display = testDisplay(144);
    const { loop, fetched, drawn } = testLoop(display);
    loop.start();
    await display.run(1_000);
    expect(fetched.length).toBeGreaterThanOrEqual(29);
    expect(fetched.length).toBeLessThanOrEqual(31);
    expect(drawn.length).toBe(fetched.length);
  });

  it('时间线在动时每秒最多 10 帧', async () => {
    const display = testDisplay(144);
    const { loop, fetched } = testLoop(display);
    loop.start();
    await display.run(1_000, () => display.motion.moved());
    expect(fetched.length).toBeLessThanOrEqual(10);
    expect(fetched.length).toBeGreaterThanOrEqual(9);
    // Kept on a 100 ms beat: a frame may land a display frame late, the next one is not pushed back for it.
    for (let index = 1; index < fetched.length; index += 1) expect((fetched[index] ?? 0) - (fetched[index - 1] ?? 0)).toBeGreaterThan(MOVING_FRAME_MS - 1_000 / 144);
  });

  it('停下 300 ms 后回到每秒 30 帧，没到 300 ms 还是 10 帧', async () => {
    const display = testDisplay(144);
    const { loop, fetched } = testLoop(display);
    loop.start();
    await display.run(500, () => display.motion.moved());
    const stoppedAt = display.now();
    await display.run(TIMELINE_REST_MS - 20);
    expect(fetched.filter(time => time > stoppedAt).length).toBeLessThanOrEqual(3);
    await display.run(20);
    const restedAt = display.now();
    await display.run(1_000);
    const after = fetched.filter(time => time > restedAt).length;
    expect(after).toBeGreaterThanOrEqual(29);
    expect(after).toBeLessThanOrEqual(31);
  });

  it('在实时画布上拖来源时不设上限，跟着屏幕刷新走，时间线在动也一样', async () => {
    const display = testDisplay(60);
    const { loop, fetched } = testLoop(display, { value: true });
    loop.start();
    await display.run(1_000, () => display.motion.moved());
    expect(fetched.length).toBeGreaterThanOrEqual(59);
    expect(liveFrameInterval({ editingCanvas: true, timelineMoving: true })).toBe(0);
    expect(liveFrameInterval({ editingCanvas: false, timelineMoving: false })).toBe(LIVE_FRAME_MS);
  });

  it('一次只有一个请求在路上：上一帧没回来不发下一个', async () => {
    const display = testDisplay(144);
    let answer: ((value: LiveFrame) => void) | null = null;
    let fetches = 0;
    const drawn: LiveFrame[] = [];
    const loop = new LiveFrameLoop<LiveFrame>({
      fetch: () => { fetches += 1; return new Promise((resolve) => { answer = resolve; }); },
      draw: (next) => { drawn.push(next); },
      editingCanvas: () => false,
      failed: () => undefined
    }, display.clock);
    loop.start();
    await display.run(500);
    expect(fetches).toBe(1);
    expect(display.waiting()).toBe(0);
    const resolve: (value: LiveFrame) => void = answer ?? (() => undefined);
    resolve(frame());
    await display.run(100);
    expect(drawn.length).toBe(1);
    expect(fetches).toBe(2);
  });

  it('停下后不再请求，也不画还在路上的那一帧', async () => {
    const display = testDisplay(144);
    let answer: ((value: LiveFrame) => void) | null = null;
    let fetches = 0, draws = 0;
    const loop = new LiveFrameLoop<LiveFrame>({
      fetch: () => { fetches += 1; return new Promise((resolve) => { answer = resolve; }); },
      draw: () => { draws += 1; },
      editingCanvas: () => false,
      failed: () => undefined
    }, display.clock);
    loop.start();
    await display.run(50);
    loop.stop();
    const resolve: (value: LiveFrame) => void = answer ?? (() => undefined);
    resolve(frame());
    await display.run(1_000);
    expect(fetches).toBe(1);
    expect(draws).toBe(0);
    expect(display.waiting()).toBe(0);
  });

  it('还没请求就停下（等着的那一帧被取消）', async () => {
    const display = testDisplay(144);
    const { loop, fetched } = testLoop(display);
    loop.start();
    expect(display.waiting()).toBe(1);
    loop.stop();
    expect(display.waiting()).toBe(0);
    await display.run(1_000);
    expect(fetched).toEqual([]);
  });

  it('取画面失败就停下，只报一次，不重试', async () => {
    const display = testDisplay(144);
    let fetches = 0;
    const failures: unknown[] = [];
    const loop = new LiveFrameLoop<LiveFrame>({
      fetch: () => { fetches += 1; return Promise.reject(new Error('断开')); },
      draw: () => undefined,
      editingCanvas: () => false,
      failed: (reason) => { failures.push(reason); }
    }, display.clock);
    loop.start();
    await display.run(1_000);
    expect(fetches).toBe(1);
    expect(failures).toHaveLength(1);
    expect(loop.stopped).toBe(true);
  });
});

describe('画面会话', () => {
  it('窗口隐藏、修复中或失败过就不请求画面', () => {
    expect(livePreviewWanted({ visible: true, suspended: false, failed: false })).toBe(true);
    expect(livePreviewWanted({ visible: false, suspended: false, failed: false })).toBe(false);
    expect(livePreviewWanted({ visible: true, suspended: true, failed: false })).toBe(false);
    expect(livePreviewWanted({ visible: true, suspended: false, failed: true })).toBe(false);
  });

  it('隐藏或卸载（stop）后不再请求，会话关掉，run 结束', async () => {
    const display = testDisplay(144);
    let fetches = 0, closes = 0;
    const session = livePreviewRun<LiveFrame>({
      next: () => { fetches += 1; return Promise.resolve(frame()); },
      close: () => { closes += 1; return Promise.resolve(); }
    }, { draw: () => undefined, editingCanvas: () => false, failed: () => undefined }, display.clock);
    const running = session.run();
    await display.run(200);
    const before = fetches;
    expect(before).toBeGreaterThan(0);
    session.stop();
    await running;
    await display.run(1_000);
    expect(fetches).toBe(before);
    expect(closes).toBe(1);
    expect(display.waiting()).toBe(0);
  });

  it('还没轮到就被停下：一帧也不请求', async () => {
    const display = testDisplay(144);
    let fetches = 0;
    const session = livePreviewRun<LiveFrame>({
      next: () => { fetches += 1; return Promise.resolve(frame()); },
      close: () => Promise.resolve()
    }, { draw: () => undefined, editingCanvas: () => false, failed: () => undefined }, display.clock);
    session.stop();
    await session.run();
    await display.run(1_000);
    expect(fetches).toBe(0);
    expect(display.waiting()).toBe(0);
  });

  it('失败时报出原因，run 结束并关掉会话', async () => {
    const display = testDisplay(144);
    let closes = 0;
    const failures: unknown[] = [];
    const session = livePreviewRun<LiveFrame>({
      next: () => Promise.reject(new Error('断开')),
      close: () => { closes += 1; return Promise.resolve(); }
    }, { draw: () => undefined, editingCanvas: () => false, failed: (reason) => { failures.push(reason); } }, display.clock);
    const running = session.run();
    await display.run(100);
    await running;
    expect(failures).toHaveLength(1);
    expect(closes).toBe(1);
  });
});

describe('画到画布上', () => {
  function testSurface() {
    const put: ImageData[] = [];
    let contexts = 0;
    const surface = {
      width: 0,
      height: 0,
      getContext: () => { contexts += 1; return { putImageData: (image: ImageData) => { put.push(image); } }; }
    };
    const created: ImageData[] = [];
    const createImage = (width: number, height: number): ImageData => {
      const image: ImageData = { width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: 'srgb' };
      created.push(image);
      return image;
    };
    return { surface, put, created, createImage, contexts: () => contexts };
  }

  it('同样大小的帧用同一个 ImageData，画布的 context 只取一次', () => {
    const test = testSurface();
    const painter = new LiveFramePainter(() => test.surface, test.createImage);
    for (let index = 0; index < 5; index += 1) {
      const next = frame(2, 1);
      next.rgba[0] = index;
      painter.draw(next);
      expect(test.created[0]?.data[0]).toBe(index);
    }
    expect(test.created).toHaveLength(1);
    expect(test.put).toHaveLength(5);
    expect(new Set(test.put).size).toBe(1);
    expect(test.contexts()).toBe(1);
    expect([test.surface.width, test.surface.height]).toEqual([2, 1]);
  });

  it('画面大小变了才重新建 ImageData 和画布尺寸', () => {
    const test = testSurface();
    const painter = new LiveFramePainter(() => test.surface, test.createImage);
    painter.draw(frame(2, 2));
    painter.draw(frame(4, 2));
    painter.draw(frame(4, 2));
    expect(test.created.map(image => [image.width, image.height])).toEqual([[2, 2], [4, 2]]);
    expect([test.surface.width, test.surface.height]).toEqual([4, 2]);
  });

  it('数据不完整或没有画布就报错，不画', () => {
    const test = testSurface();
    const painter = new LiveFramePainter(() => test.surface, test.createImage);
    expect(() => painter.draw({ width: 2, height: 2, rgba: new Uint8Array(8) })).toThrow('OBS 预览画面数据不完整');
    expect(test.put).toHaveLength(0);
    expect(() => new LiveFramePainter(() => null, test.createImage).draw(frame())).toThrow('无法创建 OBS 实时画布');
  });
});
