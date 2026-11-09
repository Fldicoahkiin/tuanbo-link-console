import { toUserErrorMessage } from '@tb/core/link';

/** The text an on-screen notice shows. Error text is put into everyday words first (toUserErrorMessage), unless it is
 * `written` for the operator already: the main process sends such text on link:main-process-error (main-process-errors.ts),
 * and a song title in it, such as 「HAPPY」, must not make it read as a technical error. */
export function noticeText(message: string, tone: 'info' | 'error', written: boolean): string {
  return tone === 'error' && !written ? toUserErrorMessage(message) : message;
}

/** Shows what the main process sends on link:main-process-error in red, as it is (`written`). `subscribe` is
 * linkDesktopViewModel.onMainProcessError; the returned function unsubscribes. */
export function showMainProcessErrors(subscribe: (listener: (message: string) => void) => () => void,
  notify: (message: string, tone: 'error', key: undefined, written: true) => void): () => void {
  return subscribe(message => notify(message, 'error', undefined, true));
}
