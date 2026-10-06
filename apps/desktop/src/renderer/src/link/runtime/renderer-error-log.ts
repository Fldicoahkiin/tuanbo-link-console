import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';

/** Record uncaught UI errors even when the settings or project screens cannot mount. */
export function installRendererErrorLog(): () => void {
  const record = (message: string, failure: unknown): void => {
    void linkDesktopViewModel.recordLog({ level: 'error', category: 'system', device: 'Electron', result: 'failed',
      message: message.slice(0, 8192), details: { stack: failure instanceof Error ? failure.stack?.slice(0, 32768) ?? '' : '' }
    }).catch((error: unknown) => console.error('无法保存界面错误日志', error));
  };
  const onError = (event: ErrorEvent): void => record(`界面异常：${event.message}`, event.error);
  const onRejection = (event: PromiseRejectionEvent): void => {
    const failure: unknown = event.reason;
    record(`未处理的异步错误：${failure instanceof Error ? failure.message : typeof failure === 'string' ? failure : '未知错误'}`, failure);
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => { window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection); };
}
