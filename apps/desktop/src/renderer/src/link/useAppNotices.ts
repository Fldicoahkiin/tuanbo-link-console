import { useCallback, useState } from 'react';
import { isShowWait, ma2MtcConflictTargets } from '@tb/core/link';
import { useDocumentStore } from './stores/document-store';
import { recordErrorNotice } from './error-notice-log';
import { noticeText } from './notice-text';

export type MtcConflict = { documentId: number; targets: [number, number] };
type Notice = { id: string; message: string; tone: 'info' | 'error'; key?: string; conflict?: MtcConflict };

export function useAppNotices() {
  const [notices, setNotices] = useState<Notice[]>([]);
  /** `written`: the text is written for the operator already and is shown as it is (noticeText). */
  const notify = useCallback((message: string, tone: 'info' | 'error' = 'info', key?: string, written = false) => {
    const id = crypto.randomUUID();
    // A wait is not a failure (AGENTS §4): never in red, also when the edit that hit it reports it as an error.
    if (tone === 'error' && isShowWait(message)) tone = 'info';
    const targets = ma2MtcConflictTargets(message);
    const conflict = targets ? { targets, documentId: useDocumentStore.getState().documentId } : undefined;
    if (conflict) {
      key = `mtc-overlap-${conflict.documentId}-${[...conflict.targets].sort((a, b) => a - b).join('-')}`;
      tone = 'error';
    }
    const displayMessage = conflict ? `Timecode ${conflict.targets.join(' 和 ')} 的时间范围重叠。` : noticeText(message, tone, written);
    if (tone === 'error' && message) recordErrorNotice(displayMessage, message);
    setNotices((current) => [...current.filter(notice => notice.message !== displayMessage && (!key || notice.key !== key)), ...(message ? [{ id, message: displayMessage, tone, ...(conflict ? { conflict } : {}), ...(key ? { key } : {}) }] : [])]);
    if (tone === 'info') window.setTimeout(() => setNotices((current) => current.filter((notice) => notice.id !== id)), 5_000);
  }, []);

  return { notices, setNotices, notify };
}
