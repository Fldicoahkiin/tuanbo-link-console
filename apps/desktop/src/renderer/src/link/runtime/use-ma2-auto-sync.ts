import { useMa2ModeStore } from '../stores/ma2-mode-store';
import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import type { Ma2Catalog, Ma2CatalogRequest } from '@tb/schema';
import { Ma2AutoSync, type Ma2AutoSyncStatus, type Ma2AutoSyncScope } from './ma2-auto-sync';
import { useDocumentStore } from '../stores/document-store';
import { reportCoordinatorError } from './runtime-action-log';
import { archiveMa2Project } from './ma2-project-archive';
import { ma2MaterialConnection } from '../stores/ma2-material-read-store';

export const useMa2AutoSyncStore = create<{
  request: { connection: Ma2CatalogRequest; catalog: Ma2Catalog; scope?: Ma2AutoSyncScope } | null;
  status: Ma2AutoSyncStatus;
  message: string;
  previewPlaying: boolean;
  commitRequest: number;
}>(() => ({ request: null, status: 'off', message: '自动同步未启用', previewPlaying: false, commitRequest: 0 }));

/** Explicitly renaming a console object starts name synchronization without enrolling song edits. */
export async function enableMa2NameSync(documentId: number): Promise<void> {
  const current = (): ReturnType<typeof useDocumentStore.getState> => {
    const state = useDocumentStore.getState();
    if (state.documentId !== documentId) throw new Error('工程已切换，名称同步已取消');
    if (!state.project || !state.path) throw new Error('新名称已保存在本地，请先保存工程后再同步');
    return state;
  };
  current();
  const automatic = useMa2AutoSyncStore.getState();
  if (automatic.request && automatic.status !== 'blocked' && automatic.status !== 'off') return;
  const connection = await ma2MaterialConnection();
  current();
  const catalog = await window.tbLink.readMa2Catalog({ ...connection, targets: [] });
  const materials = current().project?.ma2MaterialLibrary;
  const endpoint = connection.network ? `${connection.network.host}:${connection.network.port}` : '本机 onPC';
  if (!materials?.library || materials.source !== endpoint || materials.library.directory.show !== catalog.directory.show || materials.library.directory.generation !== catalog.directory.generation || materials.library.directory.version !== catalog.directory.version) throw new Error('新名称已保存在本地；控台或 Show 会话已变化，请重新读取后再同步');
  const latest = useMa2AutoSyncStore.getState();
  if (latest.request && latest.status !== 'blocked' && latest.status !== 'off') return;
  useMa2AutoSyncStore.setState({ request: { connection, catalog, scope: 'names' } });
}

export function useMa2AutoSync(playing: boolean, notify: (message: string, tone?: 'info' | 'error') => void): void {
  const method = useMa2ModeStore((state) => state.method);
  const playingRef = useRef(playing); playingRef.current = playing;
  const notifyRef = useRef(notify); notifyRef.current = notify;
  const runnerRef = useRef<Ma2AutoSync | null>(null);
  useEffect(() => { void runnerRef.current?.tick(); }, [playing]);
  useEffect(() => {
    if (method === 'midi') return;
    let lastEditAt = Number.NEGATIVE_INFINITY;
    let applyingReadback = false;
    const runner = new Ma2AutoSync({
      state: () => ({ ...useDocumentStore.getState(), playing: playingRef.current || useMa2AutoSyncStore.getState().previewPlaying, editing: performance.now() - lastEditAt < 1000 }),
      catalog: request => window.tbLink.readMa2Catalog(request),
      prepare: request => window.tbLink.prepareMa2AutoBindings(request),
      rename: request => window.tbLink.renameMa2Object(request),
      read: request => window.tbLink.previewMa2(request),
      compare: request => window.tbLink.compareMa2(request),
      apply: request => window.tbLink.applyMa2(request),
      archive: archiveMa2Project,
      execute: (documentId, command) => {
        applyingReadback = true;
        try { useDocumentStore.getState().executeForDocument(documentId, command); }
        finally { applyingReadback = false; }
      },
      changed: (status, message) => {
        const previous = useMa2AutoSyncStore.getState().status;
        useMa2AutoSyncStore.setState({ status, message });
        if (status === 'verified' && previous !== 'verified' && message === '名称已写入控台并回读确认') notifyRef.current(message);
        if (status === 'blocked') {
          notifyRef.current(message, 'error');
          reportCoordinatorError(message, reason => { useMa2AutoSyncStore.setState({ message: reason }); notifyRef.current(reason, 'error'); });
        }
      }
    });
    runnerRef.current = runner;
    const start = (request: ReturnType<typeof useMa2AutoSyncStore.getState>['request']): void => {
      if (!request) { runner.stop(); return; }
      try { runner.start(request.connection, request.catalog, request.scope); void runner.tick(); }
      catch (error) { const message = String(error); useMa2AutoSyncStore.setState({ status: 'blocked', message }); notifyRef.current(message, 'error'); }
    };
    const unsubscribe = useMa2AutoSyncStore.subscribe((state, previous) => {
      if (state.commitRequest !== previous.commitRequest || state.previewPlaying !== previous.previewPlaying) void runner.tick();
      if (state.request === previous.request) return;
      start(state.request);
    });
    start(useMa2AutoSyncStore.getState().request);
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const documents = useDocumentStore.subscribe((state, previous) => {
      if (state.project === previous.project || applyingReadback) return;
      lastEditAt = performance.now();
      // Publish staged state immediately without making a remote request while playing.
      if (playingRef.current || useMa2AutoSyncStore.getState().previewPlaying) void runner.tick();
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => { void runner.tick(); }, 1000);
    });
    const poll = setInterval(() => { void runner.tick(); }, 1000);
    return () => { runnerRef.current = null; unsubscribe(); documents(); clearInterval(poll); if (debounce) clearTimeout(debounce); runner.stop(); useMa2AutoSyncStore.setState({ request: null }); };
  }, [method]);
}
