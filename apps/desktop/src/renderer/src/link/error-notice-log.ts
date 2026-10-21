import { linkDesktopViewModel } from './view-models/link-desktop-view-model';

const loggedAt = new Map<string, number>();

/** Error toasts collapse on screen; the run log keeps one entry per message per 30 s. */
export function recordErrorNotice(displayMessage: string, technicalError: string): void {
  const previous = loggedAt.get(displayMessage);
  if (previous !== undefined && Date.now() - previous < 30_000) return;
  loggedAt.set(displayMessage, Date.now());
  void linkDesktopViewModel.recordLog({ level: 'error', category: 'system', device: '界面提示', message: displayMessage, result: 'failed',
    ...(displayMessage !== technicalError ? { details: { technicalError: technicalError.slice(0, 8000) } } : {}) })
    .catch((error: unknown) => console.error('错误提示未能写入运行日志', error));
}
