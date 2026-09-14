import { expect, it, vi } from 'vitest';
import { LatestPosition } from './latest-position';

it('慢定位期间只执行首个与最后目标，不积压中间位置', async () => {
  let release = (): void => { throw new Error('尚未启动'); };
  const first = new Promise<void>((resolve) => { release = resolve; });
  const apply = vi.fn((position: number) => position === 1 ? first : Promise.resolve());
  const settled = vi.fn(), failed = vi.fn();
  const queue = new LatestPosition(apply, settled, failed);
  queue.push(1); for (let position = 2; position <= 100; position++) queue.push(position);
  expect(apply.mock.calls).toEqual([[1]]);
  release(); await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
  expect(apply.mock.calls).toEqual([[1], [100]]); expect(failed).not.toHaveBeenCalled();
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
