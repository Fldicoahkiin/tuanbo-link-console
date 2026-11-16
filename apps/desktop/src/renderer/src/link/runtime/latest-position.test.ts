import { expect, it, vi } from 'vitest';
import { LatestPosition } from './latest-position';

it('慢定位期间只执行首个与最后目标，不积压中间位置', async () => {
  let release = (): void => { throw new Error('尚未启动'); };
  const first = new Promise<void>((resolve) => { release = resolve; });
  const apply = vi.fn((position: number) => position === 1 ? first : Promise.resolve());
  const settled = vi.fn(), failed = vi.fn();
  const queue = new LatestPosition(apply, settled, failed);
  queue.push(1); for (let position = 2; position <= 100; position++) queue.push(position);
  expect(apply.mock.calls.map(([position]) => position)).toEqual([1]);
  release(); await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
  expect(apply.mock.calls.map(([position]) => position)).toEqual([1, 100]); expect(failed).not.toHaveBeenCalled();
});

it('新目标使旧定位的后续画面作废，重复的松手位置不再排一次', async () => {
  let release = (): void => { throw new Error('尚未启动'); };
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const shown: number[] = [];
  const apply = vi.fn(async (position: number, current: () => boolean) => {
    if (position === 1) await waiting;
    if (current()) shown.push(position);
  });
  const settled = vi.fn(), failed = vi.fn();
  const queue = new LatestPosition(apply, settled, failed);
  queue.push(1); queue.push(2); queue.push(2); release();
  await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
  expect(shown).toEqual([2]); expect(apply).toHaveBeenCalledTimes(2);
  expect(failed).not.toHaveBeenCalled();
});

it('取消后已经在准备的画面也失效，不能重新加入目标', async () => {
  let release = (): void => { throw new Error('尚未启动'); };
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const shown = vi.fn(), settled = vi.fn();
  const queue = new LatestPosition(async (_, current) => { await waiting; if (current()) shown(); }, settled, vi.fn());
  queue.push(1); queue.cancel(); queue.push(2); release();
  await Promise.resolve(); await Promise.resolve();
  expect(shown).not.toHaveBeenCalled(); expect(settled).not.toHaveBeenCalled();
});

it('停止清除待执行目标，旧操作完成后不能恢复播放', async () => {
  let release = (): void => { throw new Error('尚未启动'); };
  const apply = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
  const settled = vi.fn(), failed = vi.fn();
  const queue = new LatestPosition(apply, settled, failed);
  queue.push(1); queue.push(2); queue.cancel(); release();
  await Promise.resolve(); await Promise.resolve();
  expect(apply).toHaveBeenCalledOnce(); expect(settled).not.toHaveBeenCalled();
});
