import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObsRequestNotSent, ObsRequestScheduler, ObsRequestUnanswered, type ObsRequestPriority } from './obs-request-scheduler';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());

describe('OBS 有界请求调度', () => {
  it('取消保护不吞掉请求优先级，嵌套停止优先，预览内部普通请求不升级', async () => {
    const scheduler = new ObsRequestScheduler(2000, () => undefined); scheduler.connect();
    const gate = deferred<void>(), calls: string[] = [];
    const busy = Array.from({ length: 4 }, () => scheduler.request(() => gate.promise, '占用'));
    const request = (name: string) => scheduler.request(() => { calls.push(name); return Promise.resolve(); }, name);
    const work = [scheduler.guarded(() => true, () => scheduler.run('control', () => request('control'))),
      scheduler.guarded(() => true, () => scheduler.run('preview', () => scheduler.run('control', () => request('preview')))),
      scheduler.guarded(() => true, () => scheduler.run('background', () => request('background'))),
      scheduler.run('control', () => scheduler.guarded(() => true, () => scheduler.run('urgent', () => request('stop'))))];
    await Promise.resolve(); gate.resolve(); await Promise.all([...busy, ...work]);
    expect(calls).toEqual(['stop', 'control', 'background', 'preview']);
  });
  it('动作在网络队列等待时被取消，不发送迟到指令，也不把它计为网络请求', async () => {
    const scheduler = new ObsRequestScheduler(2000, () => undefined); scheduler.connect();
    const gate = deferred<void>(), sent = vi.fn(() => Promise.resolve());
    // Only `program` (or `urgent`) can hold all four slots (OBS 请求谁先发).
    const busy = Array.from({ length: 4 }, () => scheduler.run('program', () => scheduler.request(() => gate.promise, '占用通道')));
    let current = true;
    const pending = scheduler.guarded(() => current, () => scheduler.run('urgent', () => scheduler.request(sent, '节目动作')));
    const rejected = expect(pending).rejects.toThrow('没有发送');
    await Promise.resolve(); current = false; gate.resolve(); await Promise.all(busy); await rejected;
    expect(sent).not.toHaveBeenCalled();
    expect(scheduler.getStats()).toMatchObject({ requests: 4, queued: 0, active: 0 });
    await scheduler.request(sent, '其他有效动作'); expect(sent).toHaveBeenCalledTimes(1);
  });

  it('没发出去的请求和发出去没回应的请求各有自己的类型，文案不变（2026-11-11 R3b）', async () => {
    const scheduler = new ObsRequestScheduler(50, () => undefined); scheduler.connect();
    const gate = deferred<void>();
    const busy = Array.from({ length: 4 }, () => scheduler.run('program', () => scheduler.request(() => gate.promise, '占用通道')).catch((error: unknown) => error));
    // Queued behind the four, then out of date when its turn comes.
    let current = true;
    const cancelled = scheduler.guarded(() => current, () => scheduler.run('urgent', () => scheduler.request(() => Promise.resolve(), '节目动作'))).catch((error: unknown) => error);
    // Still queued when the four time out and end the connection (its own queue limit ends later).
    await new Promise(resolve => setTimeout(resolve, 25));
    const queued = scheduler.run('program', () => scheduler.request(() => Promise.resolve(), '排着的动作')).catch((error: unknown) => error);
    await Promise.resolve(); current = false;
    const [first] = await Promise.all(busy), late = await queued;
    expect(first).toBeInstanceOf(ObsRequestUnanswered);
    expect(String((first as Error).message)).toBe('OBS 占用通道 请求超时（50 ms）；不确定是否已执行，请检查 OBS 后重新连接');
    expect(late).toBeInstanceOf(ObsRequestNotSent); expect(late).not.toBeInstanceOf(ObsRequestUnanswered);
    expect((late as Error).message).toBe((first as Error).message); expect((late as Error).cause).toBe(first);
    gate.resolve();
    const refused = await cancelled;
    expect(refused).toBeInstanceOf(ObsRequestNotSent);
  });

  it('排队时被取消的请求轮到它时按没发出去报（2026-11-11 R3b）', async () => {
    const scheduler = new ObsRequestScheduler(2000, () => undefined); scheduler.connect();
    const gate = deferred<void>();
    const busy = Array.from({ length: 4 }, () => scheduler.run('program', () => scheduler.request(() => gate.promise, '占用通道')));
    let current = true;
    const pending = scheduler.guarded(() => current, () => scheduler.run('urgent', () => scheduler.request(() => Promise.resolve(), '节目动作'))).catch((error: unknown) => error);
    await Promise.resolve(); current = false; gate.resolve(); await Promise.all(busy);
    const error = await pending;
    expect(error).toBeInstanceOf(ObsRequestNotSent);
    expect((error as Error).message).toBe('OBS 动作已取消或已过时，没有发送：节目动作');
  });

  it('多请求动作的后续请求继续校验原保护窗口，嵌套操作不能移除取消条件', async () => {
    const scheduler = new ObsRequestScheduler(2000, () => undefined); scheduler.connect();
    const gate = deferred<void>(), sent = vi.fn(() => Promise.resolve()); let current = true;
    const pending = scheduler.guarded(() => current, async () => {
      await scheduler.request(sent, '第一步'); await gate.promise;
      await scheduler.guarded(() => true, () => scheduler.request(sent, '第二步'));
    });
    const rejected = expect(pending).rejects.toThrow('没有发送');
    await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1)); current = false; gate.resolve(); await rejected;
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('请求真正发出时才通知保护方；排队中被取消的请求不算发出', async () => {
    const scheduler = new ObsRequestScheduler(2000, () => undefined); scheduler.connect();
    const gate = deferred<void>(), sent = vi.fn(() => Promise.resolve()), dispatched = vi.fn(), outer = vi.fn();
    const busy = Array.from({ length: 4 }, () => scheduler.request(() => gate.promise, '占用通道'));
    let current = true;
    const cancelled = scheduler.guarded(() => current, () => scheduler.request(sent, '迟到动作'), dispatched);
    const rejected = expect(cancelled).rejects.toThrow('没有发送');
    await Promise.resolve(); current = false; gate.resolve(); await Promise.all(busy); await rejected;
    expect(dispatched).not.toHaveBeenCalled();
    await scheduler.guarded(() => true, () => scheduler.guarded(() => true, async () => {
      await scheduler.request(sent, '第一步'); await scheduler.request(sent, '第二步');
    }, dispatched), outer);
    expect(dispatched).toHaveBeenCalledTimes(2); expect(outer).toHaveBeenCalledTimes(2);
  });

  it('预览最多一个在途，控制、后台和预览合计最多两个，停止不等它们', async () => {
    const scheduler = new ObsRequestScheduler(2000, () => undefined); scheduler.connect();
    const calls: string[] = [];
    const first = deferred<void>(), second = deferred<void>(), third = deferred<void>(), control = deferred<void>();
    const add = (name: string, wait: Promise<void>): Promise<void> => scheduler.request(() => { calls.push(name); return wait; }, name);
    const work = [scheduler.run('preview', () => add('preview', first.promise)),
      scheduler.run('preview', () => add('next-preview', Promise.resolve())),
      scheduler.run('background', () => add('directory-1', second.promise)),
      scheduler.run('background', () => add('directory-2', third.promise)),
      scheduler.run('control', () => add('cue', control.promise)),
      scheduler.run('control', () => add('next-cue', Promise.resolve())),
      scheduler.run('urgent', () => add('stop', Promise.resolve()))];
    await vi.waitFor(() => expect(calls).toEqual(['preview', 'directory-1', 'stop']));
    second.resolve(); await vi.waitFor(() => expect(calls.slice(3)).toEqual(['cue']));
    control.resolve(); await vi.waitFor(() => expect(calls.slice(4)).toEqual(['next-cue', 'directory-2']));
    third.resolve(); await work[3]; expect(calls).toHaveLength(6);
    first.resolve(); await Promise.all(work);
    expect(calls.at(-1)).toBe('next-preview');
    expect(scheduler.getStats()).toMatchObject({ queued: 0, active: 0, maximumActive: 3 });
  });

  it('失去响应后停止该连接，不发送已排队任务，迟到结果不能复活旧会话', async () => {
    vi.useFakeTimers();
    const timedOut = vi.fn(); const scheduler = new ObsRequestScheduler(2000, timedOut); scheduler.connect();
    const slow = deferred<string>(), sent = vi.fn(() => slow.promise);
    const work = Array.from({ length: 7 }, () => scheduler.run('program', () => scheduler.request(sent, '测试')).catch((error: unknown) => error));
    await Promise.resolve(); expect(sent).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(2000);
    const results = await Promise.all(work);
    expect(results.map(value => value instanceof Error && (value.message.includes('不确定是否已执行') ? 'sent' : value.message.includes('还没发送') ? 'queued' : value.message)))
      .toEqual(['sent', 'sent', 'sent', 'sent', 'queued', 'queued', 'queued']);
    expect(timedOut).toHaveBeenCalledTimes(1);
    const timings = scheduler.getTimings();
    expect(timings).toHaveLength(7);
    expect(timings.every(timing => timing.failed)).toBe(true);
    expect(timings.filter(timing => timing.startedAt !== null)).toHaveLength(4);
    expect(timings.filter(timing => timing.startedAt === null)).toHaveLength(3);
    await expect(scheduler.request(sent, '不能自动重发')).rejects.toThrow('不确定是否已执行');
    slow.resolve('迟到'); await Promise.resolve(); expect(sent).toHaveBeenCalledTimes(4);
    expect(scheduler.getTimings()).toEqual(timings);
    scheduler.connect(); expect(await scheduler.request(() => Promise.resolve('新会话'), '明确重连')).toBe('新会话');
  });

  it('OBS 忙时排队等待不算失去响应：从发出算起 2 秒内回应的请求照常完成，连接不作废（2026-11-09）', async () => {
    vi.useFakeTimers();
    const timedOut = vi.fn(); const scheduler = new ObsRequestScheduler(2000, timedOut); scheduler.connect();
    const answer = (ms: number) => () => new Promise<string>(resolve => setTimeout(() => resolve(`${ms}`), ms));
    const busy = Array.from({ length: 4 }, () => scheduler.run('program', () => scheduler.request(answer(1500), '占用')));
    const queued = scheduler.run('program', () => scheduler.request(answer(1500), '切场景'));
    await vi.advanceTimersByTimeAsync(3000);
    await expect(Promise.all([...busy, queued])).resolves.toEqual(['1500', '1500', '1500', '1500', '1500']);
    expect(timedOut).not.toHaveBeenCalled();
    expect(await scheduler.request(() => Promise.resolve('照常'), '之后')).toBe('照常');
    const timing = scheduler.getTimings().find(entry => entry.label === '切场景');
    expect(timing?.failed).toBe(false); expect(timing?.startedAt).not.toBeNull();
  });

  it('断线后即使重新连接，旧操作在本地等待之后也不能继续发送', async () => {
    const scheduler = new ObsRequestScheduler(2000, () => undefined); scheduler.connect();
    const gate = deferred<void>(); const sent = vi.fn(() => Promise.resolve());
    const operation = scheduler.run('control', async () => {
      await scheduler.request(sent, '第一步'); await gate.promise;
      await scheduler.run('control', () => scheduler.request(sent, '旧第二步'));
    });
    const outcome = operation.catch((error: unknown) => error);
    await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
    scheduler.invalidate(new Error('断开')); scheduler.connect(); gate.resolve();
    expect(await outcome).toMatchObject({ message: 'OBS 旧连接的请求已取消' });
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('诊断区分排队与请求耗时，并限制保留数量', async () => {
    let time = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => time);
    try {
      const scheduler = new ObsRequestScheduler(2000, () => undefined); scheduler.connect();
      const gate = deferred<void>();
      const busy = Array.from({ length: 4 }, () => scheduler.request(() => gate.promise, '占用'));
      await Promise.resolve(); time = 5;
      const pending = scheduler.request(() => { time = 35; return Promise.resolve(); }, '播放');
      time = 25; gate.resolve(); await Promise.all([...busy, pending]);
      expect(scheduler.getTimings().at(-1)).toMatchObject({ label: '播放', queueMs: 20, executionMs: 10, failed: false });
      for (let index = 0; index < 150; index++) await scheduler.request(() => Promise.resolve(), String(index));
      expect(scheduler.getTimings()).toHaveLength(128);
      expect(scheduler.getTimings()[0]?.label).toBe('22');
    } finally { clock.mockRestore(); }
  });

  it('取消发生在真正派发之前时不触碰网络，队列容量有界', async () => {
    const scheduler = new ObsRequestScheduler(2000, () => undefined); scheduler.connect();
    const sent = vi.fn(() => new Promise<void>(() => undefined));
    const work = Array.from({ length: 132 }, () => scheduler.request(sent, '未派发').catch((error: unknown) => error));
    await expect(scheduler.request(sent, '超容量')).rejects.toThrow('排队已满');
    // The first four may have started by this await; the other 128 must not be sent.
    expect(sent.mock.calls.length).toBeLessThanOrEqual(4);
    scheduler.invalidate(new Error('取消')); await Promise.all(work);
    const isolated = new ObsRequestScheduler(2000, () => undefined); isolated.connect();
    const never = vi.fn(() => Promise.resolve());
    const pending = isolated.request(never, '立即取消').catch((error: unknown) => error);
    isolated.invalidate(new Error('关闭')); await pending; await Promise.resolve();
    expect(never).not.toHaveBeenCalled();
  });
});

describe('OBS 请求谁先发（2026-11-10）：播放画面的请求单独一档，不排在截图和实时画布后面', () => {
  const setup = () => {
    const scheduler = new ObsRequestScheduler(2000, () => undefined); scheduler.connect();
    const calls: string[] = [];
    const add = (priority: ObsRequestPriority, name: string, wait: Promise<unknown> = Promise.resolve()): Promise<unknown> =>
      scheduler.run(priority, () => scheduler.request(() => { calls.push(name); return wait; }, name));
    return { scheduler, calls, add };
  };

  it('控制、后台和预览再多，紧急和播放画面的请求始终有 2 个并发位', async () => {
    const { scheduler, calls, add } = setup();
    const gate = deferred<void>();
    const shared = [add('control', 'canvas-1', gate.promise), add('control', 'canvas-2', gate.promise), add('control', 'canvas-3', gate.promise),
      add('background', 'directory', gate.promise), add('preview', 'screenshot', gate.promise)];
    await vi.waitFor(() => expect(calls).toEqual(['canvas-1', 'canvas-2']));
    expect(scheduler.getStats()).toMatchObject({ active: 2, queued: 3 });
    const cut = add('program', 'cut', gate.promise), stop = add('urgent', 'stop');
    await vi.waitFor(() => expect(calls.slice(2)).toEqual(['cut', 'stop']));
    await stop; expect(scheduler.getStats()).toMatchObject({ active: 3 });
    gate.resolve(); await Promise.all([...shared, cut]);
    expect(scheduler.getStats()).toMatchObject({ queued: 0, active: 0, maximumActive: 4 });
  });

  it('有播放画面的请求在排队或在跑时，不开新的截图；已经发出的照常等回应，不撤回', async () => {
    const { calls, add } = setup();
    const screenshot = deferred<string>(), cut = deferred<void>(), canvas = deferred<void>();
    const sent = add('preview', 'screenshot', screenshot.promise);
    const cuts = [add('program', 'cut-1', cut.promise), add('program', 'cut-2', cut.promise)];
    await vi.waitFor(() => expect(calls).toEqual(['screenshot', 'cut-1', 'cut-2']));
    const next = add('preview', 'next-screenshot');
    const live = add('control', 'canvas', canvas.promise);
    // Four in flight now; a third cut waits for a slot.
    const queuedCut = add('program', 'cut-3');
    await vi.waitFor(() => expect(calls).toEqual(['screenshot', 'cut-1', 'cut-2', 'canvas']));
    screenshot.resolve('answered'); await expect(sent).resolves.toBe('answered');
    await vi.waitFor(() => expect(calls.at(-1)).toBe('cut-3')); await queuedCut;
    // A shared slot is free, but cuts are still in flight: no new screenshot.
    await new Promise(resolve => setImmediate(resolve));
    expect(calls).toEqual(['screenshot', 'cut-1', 'cut-2', 'canvas', 'cut-3']);
    cut.resolve(); await Promise.all(cuts);
    await vi.waitFor(() => expect(calls.slice(5)).toEqual(['next-screenshot']));
    canvas.resolve(); await Promise.all([next, live]);
  });

  it('后台请求不被播放画面的请求挡住：正在放的歌要靠它提前准备后面的素材', async () => {
    const { calls, add } = setup();
    const cut = deferred<void>();
    const cuts = [add('program', 'cut-1', cut.promise), add('program', 'cut-2', cut.promise)];
    await vi.waitFor(() => expect(calls).toEqual(['cut-1', 'cut-2']));
    const prepared = add('background', 'prepare-next-clip');
    await prepared;
    expect(calls).toEqual(['cut-1', 'cut-2', 'prepare-next-clip']);
    cut.resolve(); await Promise.all(cuts);
  });

  it('截图排着等播放画面的请求发完，等多久都不算失败，轮到了照常发', async () => {
    vi.useFakeTimers();
    const timedOut = vi.fn(); const scheduler = new ObsRequestScheduler(2000, timedOut); scheduler.connect();
    const answer = (ms: number) => () => new Promise<string>(resolve => setTimeout(() => resolve(`${ms}`), ms));
    // Two cuts one after the other keep the picture going on air for 3 s: longer than the queue limit.
    const first = scheduler.run('program', () => scheduler.request(answer(1500), '切场景'));
    const second = first.then(() => scheduler.run('program', () => scheduler.request(answer(1500), '下一个机位')));
    const screenshot = scheduler.run('preview', () => scheduler.request(answer(10), '截图'));
    let settled = false; void screenshot.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(3050);
    // Not in the gap between the two cuts, and not right after the second: only once the picture has been quiet.
    expect(settled).toBe(false);
    expect(scheduler.getTimings().map(timing => timing.label)).toEqual(['切场景', '下一个机位']);
    await vi.advanceTimersByTimeAsync(100);
    await expect(screenshot).resolves.toBe('10'); await second;
    expect(timedOut).not.toHaveBeenCalled();
    expect(scheduler.getTimings().find(timing => timing.label === '截图')).toMatchObject({ priority: 'preview', failed: false });
  });

  it('排队太久只让这一条失败，其他请求照常完成，连接不作废', async () => {
    vi.useFakeTimers();
    const timedOut = vi.fn(); const scheduler = new ObsRequestScheduler(2000, timedOut); scheduler.connect();
    const answer = (ms: number) => () => new Promise<string>(resolve => setTimeout(() => resolve(`${ms}`), ms));
    // Control goes before background: four slow live-canvas requests, two at a time, keep the directory read waiting past its limit.
    const canvas = Array.from({ length: 4 }, () => scheduler.run('control', () => scheduler.request(answer(1500), '实时画布')));
    const directory = scheduler.run('background', () => scheduler.request(answer(10), '读取场景清单')).catch((error: unknown) => error);
    const cut = scheduler.run('program', () => scheduler.request(answer(10), '切场景'));
    await vi.advanceTimersByTimeAsync(20); await expect(cut).resolves.toBe('10');
    await vi.advanceTimersByTimeAsync(2000);
    expect(String(await directory)).toContain('还没发送');
    await vi.advanceTimersByTimeAsync(1500);
    await expect(Promise.all(canvas)).resolves.toEqual(['1500', '1500', '1500', '1500']);
    expect(timedOut).not.toHaveBeenCalled();
    expect(await scheduler.run('preview', () => scheduler.request(() => Promise.resolve('照常'), '截图'))).toBe('照常');
    expect(scheduler.getTimings().find(timing => timing.label === '读取场景清单')).toMatchObject({ priority: 'background', startedAt: null, failed: true });
  });

  it('播放画面的操作里嵌套的后台或预览请求按播放画面这一档发，不会自己等自己；预览里嵌套的不升级', async () => {
    const { scheduler, calls, add } = setup();
    const gate = deferred<void>();
    const busy = add('program', 'cut', gate.promise);
    const prepared = scheduler.run('program', async () => {
      await scheduler.request(() => { calls.push('compose'); return Promise.resolve(); }, '机位');
      await scheduler.run('preview', () => scheduler.run('background', () => scheduler.request(() => { calls.push('inner'); return Promise.resolve(); }, '嵌套')));
    });
    const screenshot = scheduler.run('preview', () => scheduler.run('program', () => scheduler.request(() => { calls.push('screenshot'); return Promise.resolve(); }, '截图')));
    await prepared;
    expect(calls).toEqual(['cut', 'compose', 'inner']);
    gate.resolve(); await Promise.all([busy, screenshot]);
    const tiers = Object.fromEntries(scheduler.getTimings().map(timing => [timing.label, timing.priority]));
    expect(tiers).toMatchObject({ cut: 'program', 机位: 'program', 嵌套: 'program', 截图: 'preview' });
  });
});
