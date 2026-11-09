import type { LinkLogInput } from './run-logger';

/** Uncaught main-process errors are logged with their original text and shown to
 * the operator. The app keeps running: Electron's default modal error box would
 * block the main process, and with it picture, lighting and the whole interface. */
export function mainProcessErrorReporter(record: (message: string, details: { stack?: string }) => Promise<unknown>,
  notify: (message: string) => void): (kind: '未捕获的异常' | '未处理的异步错误', error: unknown) => void {
  return (kind, error) => {
    const message = `主进程${kind}：${error instanceof Error ? error.message : String(error)}`;
    void record(message, error instanceof Error && error.stack ? { stack: error.stack } : {})
      .catch((failure: unknown) => console.error('主进程错误未能写入日志', failure, error));
    notify(message);
  };
}

export function reportMainProcessErrors(report: ReturnType<typeof mainProcessErrorReporter>): void {
  process.on('uncaughtException', error => report('未捕获的异常', error));
  process.on('unhandledRejection', reason => report('未处理的异步错误', reason));
}

/** A failure of a background program that already closed (2026-11-09: the lights-off its stop owed and sent at close).
 * No player shows it any more, so it is logged as an error and sent to the window on the main-process error channel,
 * which the window shows in red (LinkApp: onMainProcessError → notify(message, 'error')). A log that cannot be written
 * does not hide it from the operator. */
export function closedProgramFaultReporter(record: (entry: LinkLogInput) => Promise<unknown>,
  sendToWindow: (channel: 'link:main-process-error', message: string) => void):
  (message: string, context: { projectId: string; itemId: string | null }) => void {
  return (message, { projectId, itemId }) => {
    void record({ level: 'error', category: 'state', device: '播放器', projectId, ...(itemId ? { itemId } : {}), message, result: 'failed' })
      .catch((failure: unknown) => console.error('后台节目的错误未能写入日志', failure, message));
    sendToWindow('link:main-process-error', message);
  };
}
