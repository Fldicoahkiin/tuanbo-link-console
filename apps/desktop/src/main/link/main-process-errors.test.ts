import { expect, it, vi } from 'vitest';
import { closedProgramFaultReporter, mainProcessErrorReporter } from './main-process-errors';
import type { LinkLogInput } from './run-logger';

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

// 窗口在 link:main-process-error 上收到的消息由 LinkApp 用 notify(message, 'error') 标红显示。
it('后台节目关闭后才失败的事（补发的关灯）按错误记录并发到窗口标红；日志写不进去也照样显示', async () => {
  const record = vi.fn<(entry: LinkLogInput) => Promise<unknown>>(() => Promise.resolve());
  const toWindow = vi.fn<(channel: 'link:main-process-error', message: string) => void>();
  const report = closedProgramFaultReporter(record, toWindow);
  const message = '「开场」的灯光没能完全关闭，控台上可能还亮着，请在控台上关掉这首歌的执行器。原因：MA2 没有回应';
  report(message, { projectId: 'project', itemId: 'song' });
  expect(record).toHaveBeenCalledWith({ level: 'error', category: 'state', device: '播放器', projectId: 'project', itemId: 'song', message, result: 'failed' });
  expect(toWindow).toHaveBeenCalledExactlyOnceWith('link:main-process-error', message);
  record.mockRejectedValueOnce(new Error('磁盘已满'));
  const console = vi.spyOn(globalThis.console, 'error').mockImplementation(() => undefined);
  report(message, { projectId: 'project', itemId: null });
  expect(record).toHaveBeenLastCalledWith({ level: 'error', category: 'state', device: '播放器', projectId: 'project', message, result: 'failed' });
  await vi.waitFor(() => expect(console).toHaveBeenCalledWith('后台节目的错误未能写入日志', expect.any(Error), message));
  expect(toWindow).toHaveBeenCalledTimes(2);
  expect(toWindow).toHaveBeenLastCalledWith('link:main-process-error', message);
  console.mockRestore();
});
