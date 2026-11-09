import { toUserErrorMessage } from '@tb/core/link';

/** The text an on-screen notice shows. Error text is put into everyday words first (toUserErrorMessage), unless it is
 * `written` for the operator already: the main process sends such text on link:main-process-error (main-process-errors.ts),
 * and a song title in it, such as 「HAPPY」, must not make it read as a technical error. */
export function noticeText(message: string, tone: 'info' | 'error', written: boolean): string {
  return tone === 'error' && !written ? toUserErrorMessage(message) : message;
}
