import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObsRequestScheduler } from './obs-request-scheduler';

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
    const busy = Array.from({ length: 4 }, () => scheduler.request(() => gate.promise, '占用通道'));
    let current = true;
    const pending = scheduler.guarded(() => current, () => scheduler.run('urgent', () => scheduler.request(sent, '节目动作')));
    const rejected = expect(pending).rejects.toThrow('尚未发送');
    await Promise.resolve(); current = false; gate.resolve(); await Promise.all(busy); await rejected;
    expect(sent).not.toHaveBeenCalled();
    expect(scheduler.getStats()).toMatchObject({ requests: 4, queued: 0, active: 0 });
    await scheduler.request(sent, '其他有效动作'); expect(sent).toHaveBeenCalledTimes(1);
  });

  it('多请求动作的后续请求继续校验原保护窗口，嵌套操作不能移除取消条件', async () => {
    const scheduler = new ObsRequestScheduler(2000, () => undefined); scheduler.connect();
    const gate = deferred<void>(), sent = vi.fn(() => Promise.resolve()); let current = true;
    const pending = scheduler.guarded(() => current, async () => {
      await scheduler.request(sent, '第一步'); await gate.promise;
      await scheduler.guarded(() => true, () => scheduler.request(sent, '第二步'));
    });
    const rejected = expect(pending).rejects.toThrow('尚未发送');
    await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1)); current = false; gate.resolve(); await rejected;
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('请求真正发出时才通知保护方；排队中被取消的请求不算发出', async () => {
    const scheduler = new ObsRequestScheduler(2000, () => undefined); scheduler.connect();
    const gate = deferred<void>(), sent = vi.fn(() => Promise.resolve()), dispatched = vi.fn(), outer = vi.fn();
    const busy = Array.from({ length: 4 }, () => scheduler.request(() => gate.promise, '占用通道'));
    let current = true;
    const cancelled = scheduler.guarded(() => current, () => scheduler.request(sent, '迟到动作'), dispatched);
    const rejected = expect(cancelled).rejects.toThrow('尚未发送');
    await Promise.resolve(); current = false; gate.resolve(); await Promise.all(busy); await rejected;
    expect(dispatched).not.toHaveBeenCalled();
    await scheduler.guarded(() => true, () => scheduler.guarded(() => true, async () => {
      await scheduler.request(sent, '第一步'); await scheduler.request(sent, '第二步');
    }, dispatched), outer);
    expect(dispatched).toHaveBeenCalledTimes(2); expect(outer).toHaveBeenCalledTimes(2);
  });

  it('预览最多一个在途，目录保留控制通路，停止优先于普通待发动作', async () => {
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
    await Promise.resolve();
    expect(calls).toEqual(['preview', 'directory-1', 'directory-2', 'cue']);
    control.resolve(); await work[4];
    await vi.waitFor(() => expect(calls.slice(4)).toEqual(['stop', 'next-cue']));
    first.resolve(); second.resolve(); third.resolve(); await Promise.all(work);
    expect(calls.at(-1)).toBe('next-preview');
    expect(scheduler.getStats()).toMatchObject({ queued: 0, active: 0, maximumActive: 4 });
  });

  it('失去响应后停止该连接，不发送已排队任务，迟到结果不能复活旧会话', async () => {
    vi.useFakeTimers();
    const timedOut = vi.fn(); const scheduler = new ObsRequestScheduler(2000, timedOut); scheduler.connect();
    const slow = deferred<string>(), sent = vi.fn(() => slow.promise);
    const work = Array.from({ length: 7 }, () => scheduler.request(sent, '测试').catch((error: unknown) => error));
    await Promise.resolve(); expect(sent).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(2000);
    const results = await Promise.all(work);
    expect(results.every(value => value instanceof Error && value.message.includes('执行结果不明'))).toBe(true);
    expect(timedOut).toHaveBeenCalledTimes(1);
    const timings = scheduler.getTimings();
    expect(timings).toHaveLength(7);
    expect(timings.every(timing => timing.failed)).toBe(true);
    expect(timings.filter(timing => timing.startedAt !== null)).toHaveLength(4);
    expect(timings.filter(timing => timing.startedAt === null)).toHaveLength(3);
    await expect(scheduler.request(sent, '不能自动重发')).rejects.toThrow('执行结果不明');
    slow.resolve('迟到'); await Promise.resolve(); expect(sent).toHaveBeenCalledTimes(4);
    expect(scheduler.getTimings()).toEqual(timings);
    scheduler.connect(); expect(await scheduler.request(() => Promise.resolve('新会话'), '明确重连')).toBe('新会话');
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
    await expect(scheduler.request(sent, '超容量')).rejects.toThrow('队列已满');
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
