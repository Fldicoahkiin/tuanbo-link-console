import { useEffect, type MutableRefObject } from 'react';
import { currentMa2LayoutScope } from '../stores/ma2-layout-store';
import { loadMa2ExecutorDirectory, loadMa2ExecutorPage, useMa2ExecutorPageStore } from '../stores/ma2-executor-page-store';
import { useMa2AutoSyncStore } from './use-ma2-auto-sync';
import { useMa2SongSyncStore } from './ma2-song-sync';

function writesPending(): boolean {
  const current = useMa2ExecutorPageStore.getState();
  const automatic = useMa2AutoSyncStore.getState();
  return current.mutating || current.scanning || automatic.status === 'writing' || automatic.status === 'reading'
    || Object.values(useMa2SongSyncStore.getState().songs).some(song => song.state === 'syncing');
}

export function useMa2ExecutorPages(scope: string, pageKey: string, live: boolean, selected: boolean,
  setNotice: (message: string) => void, directoryNextRead: MutableRefObject<number>): void {
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const failures = new Map<number, { count: number; retryAt: number }>();
    const report = (cause: unknown): void => { if (!stopped) setNotice(cause instanceof Error ? cause.message : String(cause)); };
    const read = async (): Promise<void> => {
      let current = useMa2ExecutorPageStore.getState();
      if (stopped || current.scope !== scope) return;
      if (!writesPending() && Date.now() >= directoryNextRead.current) {
        directoryNextRead.current = Date.now() + 10000;
        try { await loadMa2ExecutorDirectory(); }
        catch (cause) { report(cause); }
        current = useMa2ExecutorPageStore.getState();
      }
      if (!writesPending()) for (const page of [...new Set(Object.values(current.bandPages).filter((value): value is number => value !== null))]) {
        if (stopped || currentMa2LayoutScope() !== scope) return;
        if (writesPending()) break;
        if (!live && current.pages[page]) continue;
        if ((failures.get(page)?.retryAt ?? 0) > Date.now()) continue;
        try { await loadMa2ExecutorPage(page, true); failures.delete(page); }
        catch (cause) {
          const count = (failures.get(page)?.count ?? 0) + 1;
          failures.set(page, { count, retryAt: Date.now() + Math.min(30000, 2000 * 2 ** Math.min(count - 1, 4)) });
          report(cause);
        }
      }
      if (!stopped && live) timer = setTimeout(() => { void read(); }, 1500);
    };
    if (!selected) void read();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [scope, pageKey, live, selected, setNotice, directoryNextRead]);
}
