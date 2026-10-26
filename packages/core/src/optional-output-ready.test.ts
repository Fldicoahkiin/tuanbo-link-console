import { afterEach, expect, it, vi } from 'vitest';
import { optionalOutputReady } from './optional-output-ready';

afterEach(() => vi.useRealTimers());

it('取消适配器自身失败也必须结束等待，并将原始清理错误交回调用方', async () => {
  vi.useFakeTimers();
  const pending = optionalOutputReady(new Promise<never>(() => undefined), () => { throw new Error('测试：设备关闭失败'); }, '灯光');
  const failed = expect(pending).rejects.toThrow('设备关闭失败');
  await vi.advanceTimersByTimeAsync(1000);
  await failed;
});

it('准备超时只取消一次；迟到的完成不能启用通道，也不能改写失败结果', async () => {
  vi.useFakeTimers();
  let complete: ((value: string) => void) | undefined;
  const source = new Promise<string>(resolve => { complete = resolve; }), cancel = vi.fn();
  const result = optionalOutputReady(source, cancel, '画面');
  const failed = expect(result).rejects.toThrow('准备超时（');
  await vi.advanceTimersByTimeAsync(1000); await failed;
  complete!('迟到'); await vi.advanceTimersByTimeAsync(10000);
  expect(cancel).toHaveBeenCalledOnce();
  await expect(result).rejects.toThrow('准备超时（');
});
