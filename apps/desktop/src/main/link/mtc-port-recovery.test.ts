import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MtcPortRecovery } from './mtc-port-recovery';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-24T08:00:00.000Z')); });
afterEach(() => { vi.useRealTimers(); });

function fixture() {
  let outputs: { id: number; name: string }[] = [];
  const list = vi.fn(() => Promise.resolve(outputs)), reopen = vi.fn<(device: number, name: string) => Promise<void>>(() => Promise.resolve());
  const recovered = vi.fn(), log = vi.fn(), active = vi.fn(() => true);
  const recovery = new MtcPortRecovery({ list, reopen, active, recovered, log });
  return { recovery, list, reopen, active, recovered, log, set: (next: { id: number; name: string }[]) => { outputs = next; } };
}

it('端口消失后每秒检查一次；同名端口重新出现即按序号重新打开，并报告中断时长', async () => {
  const f = fixture();
  f.recovery.lost('团播联动台 P1 MTC');
  f.recovery.lost('团播联动台 P1 MTC');
  await vi.advanceTimersByTimeAsync(0);
  expect(f.list).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.list).toHaveBeenCalledTimes(3); expect(f.reopen).not.toHaveBeenCalled();
  f.set([{ id: 2, name: 'Tuanbo MA2' }, { id: 6, name: '团播联动台 P1 MTC' }]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.reopen).toHaveBeenCalledExactlyOnceWith(6, '团播联动台 P1 MTC');
  expect(f.recovered).toHaveBeenCalledExactlyOnceWith({ portName: '团播联动台 P1 MTC', interruptedAt: '2026-10-24T08:00:00.000Z',
    recoveredAt: '2026-10-24T08:00:03.000Z', durationMs: 3000 });
  expect(f.recovery.watching).toBeNull();
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.list).toHaveBeenCalledTimes(4); expect(f.log).not.toHaveBeenCalled();
});

it('同名端口不止一个时不打开任何一个；重开失败继续检查，同样的失败只记一次', async () => {
  const f = fixture();
  f.set([{ id: 3, name: 'MTC' }, { id: 4, name: 'MTC' }]);
  f.recovery.lost('MTC');
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.reopen).not.toHaveBeenCalled(); expect(f.log).toHaveBeenCalledOnce();
  f.set([{ id: 4, name: 'MTC' }]);
  f.reopen.mockRejectedValue(new Error('播放引擎拒绝打开端口：-2147024891'));
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.reopen).toHaveBeenCalledTimes(3); expect(f.log).toHaveBeenCalledTimes(2); expect(f.recovered).not.toHaveBeenCalled();
  f.reopen.mockResolvedValue(undefined);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.recovered).toHaveBeenCalledOnce();
});

it('取消后不再检查；取消时在途的检查结果不会打开端口', async () => {
  const f = fixture();
  let finish!: (outputs: { id: number; name: string }[]) => void;
  f.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  f.recovery.lost('MTC');
  f.recovery.cancel();
  finish([{ id: 1, name: 'MTC' }]);
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.reopen).not.toHaveBeenCalled(); expect(f.list).toHaveBeenCalledOnce();
  f.recovery.lost('MTC'); f.recovery.lost('Other');
  await vi.advanceTimersByTimeAsync(0);
  expect(f.recovery.watching).toBe('Other');
});

it('暂停中只等待，不枚举也不打开；继续播放后下一次检查照常恢复', async () => {
  const f = fixture();
  f.active.mockReturnValue(false);
  f.set([{ id: 2, name: 'MTC' }]);
  f.recovery.lost('MTC');
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.list).not.toHaveBeenCalled(); expect(f.reopen).not.toHaveBeenCalled(); expect(f.log).not.toHaveBeenCalled();
  f.active.mockReturnValue(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.reopen).toHaveBeenCalledExactlyOnceWith(2, 'MTC'); expect(f.recovered).toHaveBeenCalledOnce();
});
