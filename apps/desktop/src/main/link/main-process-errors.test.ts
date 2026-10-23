import { expect, it, vi } from 'vitest';
import { mainProcessErrorReporter } from './main-process-errors';

it('主进程未捕获的错误记录原文和调用栈并通知界面，日志写入失败也不吞掉通知', async () => {
  const record = vi.fn<(message: string, details: { stack?: string }) => Promise<unknown>>(() => Promise.resolve());
  const notify = vi.fn<(message: string) => void>();
  const report = mainProcessErrorReporter(record, notify);
  const error = new Error('读取 OBS 状态失败');
  report('未捕获的异常', error);
  expect(record).toHaveBeenCalledWith('主进程未捕获的异常：读取 OBS 状态失败', { stack: error.stack });
  expect(notify).toHaveBeenCalledWith('主进程未捕获的异常：读取 OBS 状态失败');
  record.mockRejectedValueOnce(new Error('磁盘已满'));
  const console = vi.spyOn(globalThis.console, 'error').mockImplementation(() => undefined);
  report('未处理的异步错误', 'MIDI 端口已关闭');
  await vi.waitFor(() => expect(console).toHaveBeenCalledWith('主进程错误未能写入日志', expect.any(Error), 'MIDI 端口已关闭'));
  expect(notify).toHaveBeenLastCalledWith('主进程未处理的异步错误：MIDI 端口已关闭');
  console.mockRestore();
});
