import { create } from 'zustand';
import { allocateSongMtcStart, applyMa2SongReadback, consoleLabelText, ma2SongPoints, mergeMa2AttributesCommand, programTimeOrigin, projectLightingLibrary, setAllocatedMtcStartsCommand, setLightingLibraryCommand, setLightingCommand } from '@tb/core/link';
import type { Ma2LayoutSettings, Ma2ReadProgress, Ma2SongBinding } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { requireSavedProjectPath } from '../project-document';
import { acceptCreatedMa2Layout, currentMa2LayoutScope } from '../stores/ma2-layout-store';
import { locateMa2Executor, ma2ExecutorLocationLabel, loadMa2ExecutorPage } from '../stores/ma2-executor-page-store';
import { archiveMa2Project } from './ma2-project-archive';
import { reportCoordinatorError } from './runtime-action-log';
import { useMa2AutoSyncStore } from '../stores/ma2-auto-sync-store';
import { readMa2Method } from '../stores/ma2-mode-store';
import { useMa2RealtimePreference } from './ma2-realtime-preference';
import { useProgramSelectionStore } from '../stores/program-selection-store';

/**
 * 'blocked': the same sync failed MAX_ATTEMPTS times in a row; it waits for an edit or 刷新同步.
 * `checkedAt`: when a confirmed song was last compared with the console.
 */
type SongSync = { sessionId: string; itemId: string; documentId: number; name: string; settings: Ma2LayoutSettings; state: 'pending' | 'syncing' | 'verified' | 'blocked' | 'paused'; message: string; requestId?: string | null; progress?: Ma2ReadProgress | null; checking?: boolean; acknowledged?: string; remoteRevision?: string | undefined; blockedRevision?: number | undefined; nextCheckAt?: number; checkedAt?: number; waitingForConnection?: boolean; consecutiveFailures?: number; archivedSignature?: string; rewriteLegacyNames?: boolean };
const MAX_ATTEMPTS = 3;
// Each comparison exports the song on the console. The song open in the editor is compared often,
// so console edits show up quickly; the others rarely, so they never hold up the next edit for long.
const FOCUSED_RECHECK_MS = 2000;
const BACKGROUND_RECHECK_MS = 30000;
// One archive covers a burst of edits: each sync no longer writes the whole project again.
const ARCHIVE_INTERVAL_MS = 60000;
let lastArchive: { documentId: number; at: number } | null = null;
async function archiveBeforeSync(documentId: number, project: Parameters<typeof archiveMa2Project>[1]): Promise<void> {
  if (lastArchive?.documentId === documentId && Date.now() - lastArchive.at < ARCHIVE_INTERVAL_MS) return;
  await archiveMa2Project(documentId, project);
  lastArchive = { documentId, at: Date.now() };
}
function focusedItemId(): string | null {
  const project = useDocumentStore.getState().project;
  return project ? useProgramSelectionStore.getState().byProject[project.projectId] ?? null : null;
}
/** When a song is next due: a confirmed song open in the editor comes back early, a reset to 0 always wins. */
function dueAt(entry: SongSync): number | undefined {
  if (entry.state !== 'verified' || entry.checkedAt === undefined || entry.itemId !== focusedItemId()) return entry.nextCheckAt;
  return Math.min(entry.nextCheckAt ?? Number.POSITIVE_INFINITY, entry.checkedAt + FOCUSED_RECHECK_MS);
}
export const useMa2SongSyncStore = create<{ songs: Record<string, SongSync> }>(() => ({ songs: {} }));
let running = false;
type Program = NonNullable<ReturnType<typeof useDocumentStore.getState>['project']>['rundown'][number];
/** The song's MTC start once it has one: it places the song's own Timecode show. */
function songStart(item: Program): number | undefined {
  return item.playback || item.p1Media ? Math.round(programTimeOrigin(item)) : undefined;
}
/** What a confirmed sync acknowledges: the song's points, its name and, once it has one, its MTC start. */
function songSignature(points: ReturnType<typeof ma2SongPoints>, name: string, start: number | undefined): string {
  return JSON.stringify([points, name, ...start === undefined ? [] : [start]]);
}
/** Confirmed songs whose local content no longer matches what the console confirmed wait for a sync again. */
export function markPendingMa2Songs(): void {
  const project = useDocumentStore.getState().project;
  for (const entry of Object.values(useMa2SongSyncStore.getState().songs)) {
    if (entry.state !== 'verified') continue;
    const item = project?.rundown.find(value => value.id === entry.itemId);
    const lighting = item?.lighting;
    if (!item || !lighting) continue;
    try {
      if (entry.acknowledged !== songSignature(ma2SongPoints(lighting), lighting.consoleSong?.name ?? entry.name, songStart(item))) update(entry, { state: 'pending', nextCheckAt: 0, message: '修改已暂存，等待同步' });
    } catch (cause) {
      update(entry, { state: 'pending', nextCheckAt: 0, message: cause instanceof Error ? cause.message : String(cause) });
    }
  }
}
/** A new session reads the console in full on its first pass: nothing is taken as already confirmed. */
export function startMa2SongSync(itemId: string, name: string, settings: Ma2LayoutSettings): void {
  const documentId = useDocumentStore.getState().documentId;
  useMa2SongSyncStore.setState(state => ({ songs: { ...state.songs, [itemId]: { sessionId: crypto.randomUUID(), itemId, documentId, name, settings, state: 'pending', message: '等待同步到控台' } } }));
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
function confirmedMessage(binding: Ma2SongBinding): string {
  const location = binding.executor ? ma2ExecutorLocationLabel(Number(binding.executor.split('.')[0]), Number(binding.executor.split('.')[1])) : `Layout ${binding.layout}`;
  return `${location} · 序列 ${binding.sequence} · ${binding.points.length} 步已回读`;
}
function canContinue(entry: SongSync): boolean {
  const document = useDocumentStore.getState();
  const session = useMa2SongSyncStore.getState().songs[entry.itemId];
  const lighting = document.project?.rundown.find(item => item.id === entry.itemId)?.lighting;
  return document.documentId === entry.documentId && session?.sessionId === entry.sessionId
    && session.state !== 'paused' && useMa2RealtimePreference.getState().enabled
    && readMa2Method() === 'network'
    && lighting !== undefined;
}

/** Serialize console reconciliation; local editing and saving remain independent. */
export async function tickMa2SongSync(playing: boolean): Promise<void> {
  if (running || readMa2Method() !== 'network' || !useMa2RealtimePreference.getState().enabled) return;
  running = true;
  try {
    // Songs with unconfirmed local edits go first; periodic checks of confirmed songs follow. Within
    // each, the song open in the editor goes first.
    const order = { pending: 0, syncing: 0, blocked: 1, verified: 2, paused: 3 } as const;
    const focus = focusedItemId();
    const rank = (entry: SongSync): number => order[entry.state] * 2 + (entry.itemId === focus ? 0 : 1);
    const startRevision = useDocumentStore.getState().revision;
    for (const entry of Object.values(useMa2SongSyncStore.getState().songs).sort((a, b) => rank(a) - rank(b))) {
      if (entry.documentId !== useDocumentStore.getState().documentId) { stopMa2SongSync(entry.itemId); continue; }
      if (entry.state === 'paused') continue;
      if (entry.state === 'blocked' && entry.blockedRevision === useDocumentStore.getState().revision) continue;
      // An edit made while this pass was checking other songs is synced on the next pass, before them.
      if (entry.state === 'verified' && useDocumentStore.getState().revision !== startRevision) break;
      const due = dueAt(entry);
      if (due && Date.now() < due && (!entry.consecutiveFailures || entry.blockedRevision === useDocumentStore.getState().revision)) continue;
      if (playing) { update(entry, { state: 'pending', message: '播放中，修改将在停止后同步' }); continue; }
      try {
        const before = useDocumentStore.getState(); const item = before.project?.rundown.find(value => value.id === entry.itemId);
        if (!before.project || !item?.lighting) throw new Error('本曲已不存在');
        if (item.lighting.ma2Bindings?.length) throw new Error('本曲已有控台时间码绑定；请在未绑定的新曲创建歌曲序列，避免改变现有控台编排');
        const points = ma2SongPoints(item.lighting);
        if (!points.length && !item.lighting.consoleSong) {
          update(entry, { state: 'pending', checking: false, message: '请先在时间线添加 Cue，新歌曲尚未创建' });
          continue;
        }
        const materials = before.project.ma2MaterialLibrary;
        if (!materials?.library || materials.library.sourceUnverified) throw new Error('请先读取并核对控台素材');
        // The song's MTC start places its own Timecode show; changing it rewrites the show.
        let start = songStart(item);
        const signature = songSignature(points, item.lighting.consoleSong?.name ?? entry.name, start);
        const networkStatus = await window.tbLink.getMa2NetworkStatus();
        if (!canContinue(entry)) continue;
        if (networkStatus.state !== 'connected' || !networkStatus.settings) {
          update(entry, { state: 'pending', checking: false, waitingForConnection: true, nextCheckAt: Date.now() + 1000, message: '等待控台连接；可以继续编辑，连接恢复后核对并续传' });
          continue;
        }
        // An unassigned executor is assigned again by the full sync, so it is never only checked.
        const checkOnly = entry.acknowledged === signature && Boolean(entry.remoteRevision) && Boolean(item.lighting.consoleSong) && item.lighting.consoleSong?.assignment !== 'unassigned' && !entry.rewriteLegacyNames;
        // A periodic re-check of a confirmed song keeps its state and message.
        update(entry, checkOnly && entry.state === 'verified' ? { checking: true } : { checking: true, state: 'syncing', message: `核对本曲 ${points.length} 个 Cue…` });
        const { host, port, monitorPort, username } = networkStatus.settings;
        const network = { host, port, monitorPort, username };
        const endpoint = `${host}:${port}`;
        if (endpoint !== materials.source) throw new Error('素材来源与当前控台不一致');
        const { show, generation, version } = materials.library.directory;
        // A song without an MTC start gets one before its first show is written: after every show on
        // the console and every other song, kept through undo like a console read-back.
        if (start === undefined && item.referenceAudio && (!item.lighting.consoleSong || item.lighting.consoleSong.executor)) {
          const ranges = await window.tbLink.ma2TimecodeRanges(network);
          const current = useDocumentStore.getState();
          if (!canContinue(entry) || current.documentId !== entry.documentId || !current.project) continue;
          current.execute(setAllocatedMtcStartsCommand(new Map([[item.id, allocateSongMtcStart(current.project, item.id, ranges)]])));
          // The start the song holds now: one given meanwhile by the session check is kept, not replaced.
          const allocated = useDocumentStore.getState().project?.rundown.find(value => value.id === item.id);
          start = allocated ? songStart(allocated) : undefined;
          if (start === undefined) throw new Error('本曲 MTC 起点分配后未写入歌曲，未同步');
        }
        if (checkOnly && entry.remoteRevision && item.lighting.consoleSong) {
          const binding = item.lighting.consoleSong;
          const changed = await window.tbLink.checkMa2Song({ network, expectedSource: { show, generation, version }, sequence: binding.sequence, ...(binding.executor ? { executor: binding.executor } : {}), revision: entry.remoteRevision });
          if (!canContinue(entry)) continue;
          if (!changed) {
            update(entry, { checking: false, state: 'verified', waitingForConnection: false, checkedAt: Date.now(), nextCheckAt: Date.now() + BACKGROUND_RECHECK_MS, message: confirmedMessage(binding) });
            // An edit made while the console was compared is not confirmed by that comparison.
            markPendingMa2Songs(); continue;
          }
          update(entry, { state: 'syncing', message: `控台有变化，核对本曲 ${points.length} 个 Cue…` });
        }
        // A background tick never opens a dialog: the pre-sync archive needs the project's location.
        requireSavedProjectPath('同步控台');
        if (!canContinue(entry)) continue;
        const scope = currentMa2LayoutScope();
        const settings = ma2SongSyncSettings(before.project, entry.itemId);
        const archived = entry.acknowledged !== signature;
        // Retries of the same unconfirmed content reuse the archive taken before its first attempt.
        if (archived && entry.archivedSignature !== signature) { await archiveBeforeSync(entry.documentId, before.project); update(entry, { archivedSignature: signature }); }
        if (!canContinue(entry)) continue;
        if (useMa2AutoSyncStore.getState().timelinePlaying || useMa2AutoSyncStore.getState().previewPlaying) {
          update(entry, { state: 'pending', message: '播放中保留当前修改；停止后核对原位置并继续同步' }); continue;
        }
        const requestId = crypto.randomUUID();
        update(entry, { requestId, progress: null });
        const requestedName = item.lighting.consoleSong?.name ?? entry.name;
        const synced = await window.tbLink.syncMa2Song({ network, expectedSource: { show, generation, version }, projectId: before.project.projectId, itemId: item.id,
          requestId, progressId: requestId, settings, name: requestedName, points,
          ...(item.lighting.consoleSong ? { binding: item.lighting.consoleSong } : {}), ...(entry.rewriteLegacyNames ? { rewriteLegacyNames: true } : {}),
          ...(start === undefined ? {} : { timecodeStartMs: start, ...(item.referenceAudio ? { timecodeLengthMs: Math.ceil(item.referenceAudio.durationMs) } : {}) }) },
          progress => update(entry, { progress }));
        update(entry, { requestId: null, progress: null });
        if (useDocumentStore.getState().documentId === entry.documentId) useDocumentStore.getState().markConsoleSynced(entry.documentId);
        // The console holds the pinyin of a Chinese song name; keep the local name unless it was changed there.
        const result = synced.binding.name === consoleLabelText(requestedName) ? { ...synced, binding: { ...synced.binding, name: requestedName } } : synced;
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
        // The binding changed, or the points the console now confirms do: an empty Cue becomes a reference to its new Cue.
        if (JSON.stringify(current.consoleSong) !== JSON.stringify(result.binding) || JSON.stringify(ma2SongPoints(applyMa2SongReadback(current, points, result))) !== JSON.stringify(ma2SongPoints(current))) {
          if (!archived) await archiveBeforeSync(entry.documentId, after.project);
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
        }
        if (!canContinue(entry)) continue;
        if (result.layout) acceptCreatedMa2Layout(scope, result.layout, !item.lighting.consoleSong);
        if (result.binding.executor && !item.lighting.consoleSong) {
          const [page, slot] = result.binding.executor.split('.').map(Number);
          locateMa2Executor(page!, slot!); await loadMa2ExecutorPage(page!);
        }
        const confirmed = applyMa2SongReadback(item.lighting, points, result);
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(result.binding.baselineXml));
        const remoteRevision = result.remoteRevision ?? Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
        update(entry, { state: 'verified', checking: false, waitingForConnection: false, checkedAt: Date.now(), nextCheckAt: Date.now() + BACKGROUND_RECHECK_MS, remoteRevision, consecutiveFailures: 0,
          rewriteLegacyNames: false, acknowledged: songSignature(ma2SongPoints(confirmed), result.binding.name, start),
          message: confirmedMessage(result.binding) });
        // An edit made while this song was being written waits for its own sync instead of the next check.
        markPendingMa2Songs();
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        // A transport loss is a wait state. After reconnect, the service reads
        // the native sequence and its durable journal before planning any write.
        let disconnected = false;
        try { disconnected = (await window.tbLink.getMa2NetworkStatus()).state !== 'connected'; }
        catch (statusError) { reportCoordinatorError(`读取连接状态：${String(statusError)}`, reason => update(entry, { message: reason })); }
        const playback = useMa2AutoSyncStore.getState();
        const playingNow = playback.timelinePlaying || playback.previewPlaying;
        const waiting = disconnected || playingNow;
        // Waiting for the console or for playback to stop is not a failed attempt.
        const consecutiveFailures = waiting ? entry.consecutiveFailures ?? 0 : (entry.consecutiveFailures ?? 0) + 1;
        const exhausted = consecutiveFailures >= MAX_ATTEMPTS;
        update(entry, { state: exhausted ? 'blocked' : 'pending', blockedRevision: useDocumentStore.getState().revision, consecutiveFailures,
          nextCheckAt: Date.now() + (waiting ? 1000 : 1000 * consecutiveFailures),
          waitingForConnection: disconnected, checking: false, requestId: null, progress: null,
          message: playingNow ? '播放中保留当前修改；停止后核对原位置并继续同步'
            : disconnected ? `等待连接恢复后核对并续传；${message}`
            : exhausted ? `同步连续 ${consecutiveFailures} 次失败，已停止自动重试：${message}。修改保留在本地，处理后点「刷新同步」`
            : `第 ${consecutiveFailures} 次同步失败，${consecutiveFailures} 秒后再试：${message}` });
        reportCoordinatorError(message, reason => { update(entry, { message: reason }); });
      }
    }
  } finally { running = false; }
}
