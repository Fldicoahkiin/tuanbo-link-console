import { useEffect, type MutableRefObject } from 'react';
import { currentMa2LayoutScope } from '../stores/ma2-layout-store';
import { loadMa2ExecutorDirectory, loadMa2ExecutorPage, useMa2ExecutorPageStore } from '../stores/ma2-executor-page-store';
import { useMa2AutoSyncStore } from './use-ma2-auto-sync';
import { useMa2SongSyncStore } from './ma2-song-sync';
import { useMa2MaterialReadStore } from '../stores/ma2-material-read-store';

/** Page polling yields the single console channel to writes, material reads and playback. */
export function pageReadsPaused(): boolean {
  const current = useMa2ExecutorPageStore.getState();
  const automatic = useMa2AutoSyncStore.getState();
  return current.mutating || current.scanning || automatic.status === 'writing' || automatic.status === 'reading'
    || automatic.timelinePlaying || automatic.previewPlaying || useMa2MaterialReadStore.getState().busy
    || Object.values(useMa2SongSyncStore.getState().songs).some(song => song.state === 'syncing');
}

/** One polling loop for a mounted page view; returns its stop function. */
export function startMa2ExecutorPagePolling(scope: string, live: boolean, setNotice: (message: string) => void, directoryNextRead: { current: number }): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const failures = new Map<number, { count: number; retryAt: number }>();
  const report = (cause: unknown): void => { if (!stopped) setNotice(cause instanceof Error ? cause.message : String(cause)); };
  const read = async (): Promise<void> => {
    let current = useMa2ExecutorPageStore.getState();
    if (stopped || current.scope !== scope) return;
    if (!pageReadsPaused() && Date.now() >= directoryNextRead.current) {
      directoryNextRead.current = Date.now() + 10000;
      try { await loadMa2ExecutorDirectory(); }
      catch (cause) { report(cause); }
      current = useMa2ExecutorPageStore.getState();
    }
    const pages = [...new Set(Object.values(current.bandPages).filter((value): value is number => value !== null))];
    if (!pageReadsPaused()) for (const page of pages) {
      if (stopped || currentMa2LayoutScope() !== scope) return;
      if (pageReadsPaused()) break;
      if (!live && current.pages[page]) continue;
      if ((failures.get(page)?.retryAt ?? 0) > Date.now()) continue;
      try { await loadMa2ExecutorPage(page, true); failures.delete(page); }
      catch (cause) {
        const count = (failures.get(page)?.count ?? 0) + 1;
        failures.set(page, { count, retryAt: Date.now() + Math.min(30000, 2000 * 2 ** Math.min(count - 1, 4)) });
        report(cause);
      }
    }
    // A page skipped while reads were paused, or still backing off after a failure, is retried
    // even when not live; otherwise its slots would stay on "读取中…" until the page changes.
    const unread = pages.some(page => !useMa2ExecutorPageStore.getState().pages[page]);
    if (!stopped && (live || unread)) timer = setTimeout(() => { void read(); }, 1500);
  };
  void read();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}

export function useMa2ExecutorPages(scope: string, pageKey: string, live: boolean, selected: boolean,
  setNotice: (message: string) => void, directoryNextRead: MutableRefObject<number>): void {
  useEffect(() => selected ? undefined : startMa2ExecutorPagePolling(scope, live, setNotice, directoryNextRead), [scope, pageKey, live, selected, setNotice, directoryNextRead]);
}
