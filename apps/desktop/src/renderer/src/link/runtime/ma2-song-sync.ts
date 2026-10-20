import { create } from 'zustand';
import { applyMa2SongReadback, ma2SongPoints, mergeMa2AttributesCommand, projectLightingLibrary, setLightingLibraryCommand, setLightingCommand } from '@tb/core/link';
import type { Ma2LayoutSettings, Ma2ReadProgress, Ma2SongConflict, Ma2SongConflictResolution } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { acceptCreatedMa2Layout, currentMa2LayoutScope } from '../stores/ma2-layout-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { locateMa2Executor, ma2ExecutorLocationLabel, loadMa2ExecutorPage } from '../stores/ma2-executor-page-store';
import { archiveMa2Project } from './ma2-project-archive';
import { reportCoordinatorError } from './runtime-action-log';
import { useMa2AutoSyncStore } from '../stores/ma2-auto-sync-store';
import { readMa2Method } from '../stores/ma2-mode-store';
import { useMa2RealtimePreference } from './ma2-realtime-preference';

type SongSync = { sessionId: string; itemId: string; documentId: number; name: string; settings: Ma2LayoutSettings; state: 'pending' | 'syncing' | 'verified' | 'blocked' | 'paused'; message: string; requestId?: string | null; progress?: Ma2ReadProgress | null; checking?: boolean; acknowledged?: string; remoteRevision?: string; confirmedDeletions?: string[]; blockedRevision?: number; nextCheckAt?: number; waitingForConnection?: boolean; conflicts?: Ma2SongConflict[]; conflictResolutions?: Ma2SongConflictResolution[]; consecutiveFailures?: number };
export const useMa2SongSyncStore = create<{ songs: Record<string, SongSync> }>(() => ({ songs: {} }));
let running = false;
export function markPendingMa2Songs(): void {
  const project = useDocumentStore.getState().project;
  for (const entry of Object.values(useMa2SongSyncStore.getState().songs)) {
    if (entry.state !== 'verified') continue;
    const lighting = project?.rundown.find(item => item.id === entry.itemId)?.lighting;
    if (!lighting) continue;
    try {
      if (entry.acknowledged !== JSON.stringify([ma2SongPoints(lighting), lighting.consoleSong?.name ?? entry.name])) update(entry, { state: 'pending', nextCheckAt: 0, message: '修改已暂存，等待同步' });
    } catch (cause) {
      update(entry, { state: 'pending', nextCheckAt: 0, message: cause instanceof Error ? cause.message : String(cause) });
    }
  }
}
export function startMa2SongSync(itemId: string, name: string, settings: Ma2LayoutSettings, confirmedDeletions?: string[]): void {
  const documentId = useDocumentStore.getState().documentId;
  useMa2SongSyncStore.setState(state => ({ songs: { ...state.songs, [itemId]: { sessionId: crypto.randomUUID(), itemId, documentId, name, settings, state: 'pending', message: '等待同步到控台', ...(confirmedDeletions ? { confirmedDeletions } : {}) } } }));
}
/** Resolve only the exact comparison currently displayed; stale decisions are re-read. */
export function resolveMa2SongConflict(itemId: string, key: string, choice: 'local' | 'console'): void {
  const entry = useMa2SongSyncStore.getState().songs[itemId];
  const conflict = entry?.conflicts?.find(value => value.key === key);
  if (!entry || !conflict || entry.documentId !== useDocumentStore.getState().documentId) return;
  update(entry, { state: 'pending', blockedRevision: -1, nextCheckAt: 0,
    conflictResolutions: [...(entry.conflictResolutions ?? []).filter(value => value.key !== key), { key, token: conflict.token, choice }],
    message: '正在核对所选内容，确认后同步' });
}
/** One destination policy for the header, automatic startup and the song panel. */
export function ma2SongSyncSettings(project: NonNullable<ReturnType<typeof useDocumentStore.getState>['project']>, itemId: string): Ma2LayoutSettings {
  const binding = project.rundown.find(item => item.id === itemId)?.lighting?.consoleSong;
  const saved = projectLightingLibrary(project).consoleWorkspace;
  return {
    layout: binding?.layout ?? saved?.layout ?? 999, name: saved?.name ?? '歌曲 Cue',
    columns: saved?.columns ?? 8, nextSequence: binding?.sequence ?? saved?.nextSequence ?? 9000,
    ...(!binding?.layout ? { executorPage: binding?.executor ? Number(binding.executor.split('.')[0]) : saved?.executorPage ?? 1000 } : {})
  };
}
export function stopMa2SongSync(itemId: string): void {
  const entry = useMa2SongSyncStore.getState().songs[itemId];
  if (!entry || entry.state === 'paused') return;
  update(entry, { state: 'paused', message: entry.requestId ? '正在停止同步，等待当前操作返回核对结果' : '已暂停同步' });
  if (entry.requestId) void window.tbLink.cancelMa2Read(entry.requestId).catch((cause: unknown) => {
    const message = `停止同步未确认：${cause instanceof Error ? cause.message : String(cause)}`;
    update(entry, { message }); reportCoordinatorError(message, reason => update(entry, { message: reason }));
  });
}
function update(entry: SongSync, patch: Partial<SongSync>): void {
  useMa2SongSyncStore.setState(state => {
    const current = state.songs[entry.itemId];
    if (!current || current.sessionId !== entry.sessionId) return state;
    return { songs: { ...state.songs, [entry.itemId]: { ...current, ...patch, ...(current.state === 'paused' ? { state: 'paused' as const } : {}) } } };
  });
}
function canContinue(entry: SongSync): boolean {
  const document = useDocumentStore.getState();
  const session = useMa2SongSyncStore.getState().songs[entry.itemId];
  const lighting = document.project?.rundown.find(item => item.id === entry.itemId)?.lighting;
  return document.documentId === entry.documentId && session?.sessionId === entry.sessionId
    && session.state !== 'paused' && useMa2RealtimePreference.getState().enabled
    && readMa2Method() === 'network'
    && lighting?.outputMode === 'network' && lighting.consoleSong?.assignment !== 'unassigned';
}

/** Serialize console reconciliation; local editing and saving remain independent. */
export async function tickMa2SongSync(playing: boolean): Promise<void> {
  if (running || readMa2Method() !== 'network' || !useMa2RealtimePreference.getState().enabled) return;
  running = true;
  try {
    for (const entry of Object.values(useMa2SongSyncStore.getState().songs)) {
      if (entry.documentId !== useDocumentStore.getState().documentId) { stopMa2SongSync(entry.itemId); continue; }
      if (entry.state === 'paused') continue;
      if (entry.nextCheckAt && Date.now() < entry.nextCheckAt && (!entry.consecutiveFailures || entry.blockedRevision === useDocumentStore.getState().revision)) continue;
      if (playing) { update(entry, { state: 'pending', message: '播放中，修改将在停止后同步' }); continue; }
      try {
        const before = useDocumentStore.getState(); const item = before.project?.rundown.find(value => value.id === entry.itemId);
        if (!before.project || !item?.lighting) throw new Error('本曲已不存在');
        if (item.lighting.consoleSong?.assignment === 'unassigned') {
          update(entry, { state: 'verified', checking: false, message: `序列 ${item.lighting.consoleSong.sequence} 已保留，执行器已解除分配` });
          continue;
        }
        if (item.lighting.outputMode !== 'network') throw new Error('歌曲序列播放需要网络直控，请先切换灯光输出');
        if (item.lighting.ma2Bindings?.length) throw new Error('本曲已有控台时间码绑定；请在未绑定的新曲创建歌曲序列，避免改变现有控台编排');
        const points = ma2SongPoints(item.lighting);
        if (!points.length && !item.lighting.consoleSong) {
          update(entry, { state: 'pending', checking: false, message: '请先在时间线添加 Cue，新歌曲尚未创建' });
          continue;
        }
        const materials = before.project.ma2MaterialLibrary;
        if (!materials?.library || materials.library.sourceUnverified) throw new Error('请先读取并核对控台素材');
        const signature = JSON.stringify([points, item.lighting.consoleSong?.name ?? entry.name]);
        const networkStatus = await window.tbLink.getMa2NetworkStatus();
        if (!canContinue(entry)) continue;
        if (networkStatus.state !== 'connected' || !networkStatus.settings) {
          update(entry, { state: 'pending', checking: false, waitingForConnection: true, nextCheckAt: Date.now() + 1000, message: '等待控台连接；可以继续编辑，连接恢复后核对并续传' });
          continue;
        }
        update(entry, entry.state === 'verified' && entry.acknowledged === signature ? { checking: true } : { checking: true, state: 'syncing', message: `核对本曲 ${points.length} 个 Cue…` });
        const { host, port, monitorPort, username } = networkStatus.settings;
        const network = { host, port, monitorPort, username };
        const endpoint = `${host}:${port}`;
        if (endpoint !== materials.source) throw new Error('素材来源与当前控台不一致');
        const { show, generation, version } = materials.library.directory;
        if (entry.acknowledged === signature && entry.remoteRevision && item.lighting.consoleSong && !entry.conflictResolutions?.length) {
          const binding = item.lighting.consoleSong;
          const changed = await window.tbLink.checkMa2Song({ network, expectedSource: { show, generation, version }, sequence: binding.sequence, ...(binding.executor ? { executor: binding.executor } : {}), revision: entry.remoteRevision });
          if (!canContinue(entry)) continue;
          if (!changed) { update(entry, { checking: false, state: entry.conflicts?.length ? 'blocked' : 'verified', waitingForConnection: false, nextCheckAt: Date.now() + 1000 }); continue; }
        }
        const path = before.path ?? await linkDesktopViewModel.saveProject(null, before.project);
        if (!path) throw new Error('请先保存工程');
        if (!before.path) before.markSaved(path, before.revision, entry.documentId);
        if (!canContinue(entry)) continue;
        const scope = currentMa2LayoutScope();
        const settings = ma2SongSyncSettings(before.project, entry.itemId);
        const archived = entry.acknowledged !== signature;
        if (archived) await archiveMa2Project(entry.documentId, before.project);
        if (!canContinue(entry)) continue;
        if (useMa2AutoSyncStore.getState().timelinePlaying || useMa2AutoSyncStore.getState().previewPlaying) {
          update(entry, { state: 'pending', message: '播放中保留当前修改；停止后核对原位置并继续同步' }); continue;
        }
        const requestId = crypto.randomUUID();
        update(entry, { requestId, progress: null });
        const result = await window.tbLink.syncMa2Song({ network, expectedSource: { show, generation, version }, projectId: before.project.projectId, itemId: item.id,
          requestId, progressId: requestId, settings, name: item.lighting.consoleSong?.name ?? entry.name, points,
          ...(item.lighting.consoleSong ? { binding: item.lighting.consoleSong } : {}), ...(entry.confirmedDeletions ? { confirmedDeletions: entry.confirmedDeletions } : {}),
          ...(entry.conflictResolutions?.length ? { conflictResolutions: entry.conflictResolutions } : {}) },
          progress => update(entry, { progress }));
        update(entry, { requestId: null, progress: null });
        // A completed command belongs to the captured song session. The durable
        // main-process journal recovers its result later if the editor has moved
        // on, paused, or changed output mode in the meantime.
        if (!canContinue(entry)) continue;
        const after = useDocumentStore.getState();
        if (after.documentId !== entry.documentId) throw new Error('控台操作已完成但工程已切换，请回到原工程核对');
        const current = after.project?.rundown.find(value => value.id === entry.itemId)?.lighting;
        if (!current || !after.project) throw new Error('歌曲已移除，控台结果保留，请读取核对');
        const locationIdentity = (binding: typeof current.consoleSong) => binding ? JSON.stringify([binding.endpoint, binding.show, binding.sequence, binding.layout, binding.executor, binding.assignment]) : '';
        if (locationIdentity(current.consoleSong) !== locationIdentity(item.lighting.consoleSong)) continue;
        if (JSON.stringify(current.consoleSong) !== JSON.stringify(result.binding)) {
          if (!archived) await archiveMa2Project(entry.documentId, after.project);
          if (!canContinue(entry)) continue;
          after.executeForDocument(entry.documentId, { id: crypto.randomUUID(), label: '同步歌曲控台序列', scope: 'lighting', historyRebaseKey: `ma2-song:${entry.itemId}`, rebaseHistory: project => ({
            ...project, rundown: project.rundown.map(value => value.id !== entry.itemId || !value.lighting ? value : { ...value, lighting: { ...value.lighting, consoleSong: result.binding } })
          }), execute(project) {
            const lighting = project.rundown.find(value => value.id === entry.itemId)?.lighting;
            if (!lighting) throw new Error('歌曲已不存在');
            const merged = mergeMa2AttributesCommand(endpoint, result.library, [result.binding.sequence], false).execute(project);
            const acknowledged = applyMa2SongReadback(lighting, points, result);
            if (lighting.consoleSong && lighting.consoleSong.name !== item.lighting?.consoleSong?.name) acknowledged.consoleSong = { ...result.binding, name: lighting.consoleSong.name };
            const updated = setLightingCommand(entry.itemId, acknowledged, '回读歌曲 Cue').execute(merged);
            const library = projectLightingLibrary(updated);
            return setLightingLibraryCommand({ ...library, consoleWorkspace: { ...entry.settings, ...library.consoleWorkspace, nextSequence: Math.min(99999, Math.max(library.consoleWorkspace?.nextSequence ?? 1, result.binding.sequence + 1)) } }).execute(updated);
          }, undo: before => before });
          const saved = useDocumentStore.getState(); if (!saved.project) throw new Error('工程已关闭');
          const savedPath = await linkDesktopViewModel.saveProject(path, saved.project);
          if (!savedPath) throw new Error('控台已同步，工程保存未完成');
          saved.markSaved(savedPath, saved.revision, entry.documentId);
        }
        if (!canContinue(entry)) continue;
        if (result.layout) acceptCreatedMa2Layout(scope, result.layout, !item.lighting.consoleSong);
        if (result.binding.executor && !item.lighting.consoleSong) {
          const [page, slot] = result.binding.executor.split('.').map(Number);
          locateMa2Executor(page!, slot!); await loadMa2ExecutorPage(page!);
        }
        const confirmed = applyMa2SongReadback(item.lighting, points, result);
        const location = result.binding.executor ? ma2ExecutorLocationLabel(Number(result.binding.executor.split('.')[0]), Number(result.binding.executor.split('.')[1])) : `Layout ${result.binding.layout}`;
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(result.binding.baselineXml));
        const remoteRevision = result.remoteRevision ?? Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
        const conflicts = result.conflicts ?? [];
        update(entry, { state: conflicts.length ? 'blocked' : 'verified', checking: false, waitingForConnection: false, nextCheckAt: Date.now() + 1000, remoteRevision, consecutiveFailures: 0,
          conflicts, conflictResolutions: [], acknowledged: JSON.stringify([ma2SongPoints(confirmed), result.binding.name]),
          message: `${location} · 序列 ${result.binding.sequence} · ${conflicts.length ? `${conflicts.length} 项需要选择保留内容，其余已回读` : `${result.binding.points.length} 步已回读`}`, confirmedDeletions: [] });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        // A transport loss is a wait state. After reconnect, the service reads
        // the native sequence and its durable journal before planning any write.
        let disconnected = false;
        try { disconnected = (await window.tbLink.getMa2NetworkStatus()).state !== 'connected'; }
        catch (statusError) { reportCoordinatorError(`读取连接状态：${String(statusError)}`, reason => update(entry, { message: reason })); }
        const playback = useMa2AutoSyncStore.getState();
        const playingNow = playback.timelinePlaying || playback.previewPlaying;
        const consecutiveFailures = (entry.consecutiveFailures ?? 0) + 1;
        update(entry, { state: 'pending', blockedRevision: useDocumentStore.getState().revision, consecutiveFailures,
          nextCheckAt: Date.now() + (disconnected || playingNow ? 1000 : Math.min(30000, 1000 * 2 ** Math.min(consecutiveFailures - 1, 5))),
          waitingForConnection: disconnected, checking: false, requestId: null, progress: null,
          message: playingNow ? '播放中保留当前修改；停止后核对原位置并继续同步' : disconnected ? `等待连接恢复后核对并续传；${message}` : `修改已保留，稍后重新核对原位置；${message}` });
        reportCoordinatorError(message, reason => { update(entry, { message: reason }); });
      }
    }
  } finally { running = false; }
}
