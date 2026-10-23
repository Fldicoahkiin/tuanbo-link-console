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
