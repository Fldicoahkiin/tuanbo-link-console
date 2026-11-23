import { afterEach, expect, it, vi } from 'vitest';
import { runMa2GuardedLua } from './ma2-lua-command';
import { stopMa2ConsoleCues } from './ma2-pool-playback';

vi.mock('./ma2-lua-command', () => ({ runMa2GuardedLua: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

it('停止命令只发一次，第一次仍读到旧 Cue 时等控台完成释放', async () => {
  vi.useFakeTimers();
  const read = vi.mocked(runMa2GuardedLua);
  read.mockResolvedValueOnce('sent').mockResolvedValueOnce('1').mockResolvedValueOnce('0');
  const stop = stopMa2ConsoleCues({ command: vi.fn() }, () => undefined);
  await vi.runAllTimersAsync();
  await stop;
  expect(read.mock.calls.filter(([, script]) => script.includes('Off Executor'))).toHaveLength(1);
  expect(read).toHaveBeenCalledTimes(3);
});

it('连续读回仍在运行时保留真实的未停止结果', async () => {
  vi.useFakeTimers();
  const read = vi.mocked(runMa2GuardedLua);
  read.mockResolvedValueOnce('sent').mockResolvedValue('2');
  const result = expect(stopMa2ConsoleCues({ command: vi.fn() }, () => undefined)).rejects.toThrow('控台还有执行器在运行（2）');
  await vi.runAllTimersAsync();
  await result;
  expect(read).toHaveBeenCalledTimes(5);
});
