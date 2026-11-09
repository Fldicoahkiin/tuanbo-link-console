import { toUserErrorMessage } from '@tb/core/link';
import type { LinkLogInput } from './run-logger';

/** Uncaught main-process errors are logged with their original text and shown to
 * the operator in plain words: the window shows what this channel sends as it is.
 * The app keeps running: Electron's default modal error box would block the main
 * process, and with it picture, lighting and the whole interface. */
export function mainProcessErrorReporter(record: (message: string, details: { stack?: string }) => Promise<unknown>,
  notify: (message: string) => void): (kind: '未捕获的异常' | '未处理的异步错误', error: unknown) => void {
  return (kind, error) => {
    const message = `主进程${kind}：${error instanceof Error ? error.message : String(error)}`;
    void record(message, error instanceof Error && error.stack ? { stack: error.stack } : {})
      .catch((failure: unknown) => console.error('主进程错误未能写入日志', failure, error));
    notify(toUserErrorMessage(message));
  };
}

export function reportMainProcessErrors(report: ReturnType<typeof mainProcessErrorReporter>): void {
  process.on('uncaughtException', error => report('未捕获的异常', error));
  process.on('unhandledRejection', reason => report('未处理的异步错误', reason));
}

/** Failures of background programs that no player state shows, as NativeProgramService reports them. */
export type ClosedProgramFaults = {
  /** `message` is written for the operator; it is logged now and shown once. */
  report(message: string, context: { projectId: string; itemId: string | null }): void;
  /** The window's page is gone (its renderer exited, or it reloaded): nothing sent to it now would be shown. */
  windowExited(): void;
  /** A window opened a program: it shows what is sent from now on, and what no window has shown yet. */
  windowOpened(): void;
};

/** A failure of a background program that no player shows (2026-11-09: the lights-off its stop owed, sent at close or
 * while the program played on without a window). It is logged as an error when it happens and shown once in red on the
 * main-process error channel, which the window shows as it is (LinkApp: onMainProcessError). It goes to the window
 * there is; while there is none, from a renderer exit or a page reload until a window opens a program again, it waits
 * for that window.
 * The window subscribes to the channel before it loads what it needs to open a program (LinkApp), so the open proves it
 * listens. A log that cannot be written does not hide it from the operator. */
export function closedProgramFaultReporter(record: (entry: LinkLogInput) => Promise<unknown>,
  sendToWindow: (channel: 'link:main-process-error', message: string) => void): ClosedProgramFaults {
  let windowShows = false;
  const unshown: string[] = [];
  return {
    report: (message, { projectId, itemId }) => {
      void record({ level: 'error', category: 'state', device: '播放器', projectId, ...(itemId ? { itemId } : {}), message, result: 'failed' })
        .catch((failure: unknown) => console.error('后台节目的错误未能写入日志', failure, message));
      if (windowShows) sendToWindow('link:main-process-error', message); else unshown.push(message);
    },
    windowExited: () => { windowShows = false; },
    windowOpened: () => {
      windowShows = true;
      for (const message of unshown.splice(0)) sendToWindow('link:main-process-error', message);
    }
  };
}
