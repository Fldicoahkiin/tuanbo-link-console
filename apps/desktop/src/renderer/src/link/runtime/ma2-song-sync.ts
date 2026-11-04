import { MA2_SONG_COLLISION, allocateSongMtcStart, applyMa2SongReadback, consoleLabelText, ma2PendingChanges, ma2SongPoints, mergeMa2AttributesCommand, pendingMa2Renames, programTimeOrigin, projectLightingLibrary, setAllocatedMtcStartsCommand, setLightingLibraryCommand, setLightingCommand } from '@tb/core/link';
import type { Ma2LayoutSettings, Ma2NetworkTarget, Ma2SongBinding, Ma2SongConsoleEdits } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { requireSavedProjectPath } from '../project-document';
import { acceptCreatedMa2Layout, currentMa2LayoutScope } from '../stores/ma2-layout-store';
import { locateMa2Executor, ma2ExecutorLocationLabel, loadMa2ExecutorPage } from '../stores/ma2-executor-page-store';
import { reportCoordinatorError } from './runtime-action-log';
import { ma2SyncPlaying, useMa2SyncStore, type NameSync, type SongSync } from '../stores/ma2-sync-store';
import { readMa2Method } from '../stores/ma2-mode-store';
import { ma2SyncActive, useMa2RealtimePreference } from './ma2-realtime-preference';
import { useProgramSelectionStore } from '../stores/program-selection-store';
import { syncBoundSong } from './ma2-bound-song-sync';
import { runMa2NameSync } from './ma2-name-sync';
import { archiveBeforeSync } from './ma2-sync-archive';

/**
 * Failed attempts in a row before a sync stops and waits for an edit or 刷新同步. Way 2 (the song's
 * own Sequence) is retried as the lighting workflow's sync rules say. Way 1 (the console's own
 * Timecode show) and names are not retried on their own, as before both ways shared this driver
 * (project rule 4). Waiting for the connection, for playback to stop or for an edit to settle is
 * never a failed attempt.
 */
const MAX_ATTEMPTS = { own: 3, imported: 1 } as const;
/** Console edits that collide with a write in a row before they count as a failed attempt. */
const MAX_COLLISIONS = 5;
// Each comparison exports the song on the console. The song open in the editor is compared often,
// so console edits show up quickly; the others rarely, so they never hold up the next edit for long.
const FOCUSED_RECHECK_MS = 2000;
const BACKGROUND_RECHECK_MS = 30000;
function focusedItemId(): string | null {
  const project = useDocumentStore.getState().project;
  return project ? useProgramSelectionStore.getState().byProject[project.projectId] ?? null : null;
}
/** When a song is next due: a confirmed song open in the editor comes back early, a reset to 0 always wins. */
function dueAt(entry: SongSync): number | undefined {
  // Parked until the project changes: any edit makes it due at once.
  if (entry.recheckRevision !== undefined && entry.recheckRevision !== useDocumentStore.getState().revision) return 0;
  if (entry.state !== 'verified' || entry.checkedAt === undefined || entry.itemId !== focusedItemId()) return entry.nextCheckAt;
  return Math.min(entry.nextCheckAt ?? Number.POSITIVE_INFINITY, entry.checkedAt + FOCUSED_RECHECK_MS);
}
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
  for (const entry of Object.values(useMa2SyncStore.getState().songs)) {
    if (entry.state !== 'verified') continue;
    const item = project?.rundown.find(value => value.id === entry.itemId);
    const lighting = item?.lighting;
    if (!project || !item || !lighting) continue;
    // Way 1 keeps the baseline the console confirmed in the song, so any difference from it is an edit to sync.
    if (lighting.ma2Bindings?.length) {
      if (ma2PendingChanges(project).some(change => change.itemId === item.id)) update(entry, { state: 'pending', nextCheckAt: 0, message: '修改已暂存，等待同步' });
      continue;
    }
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
  useMa2SyncStore.setState(state => ({ songs: { ...state.songs, [itemId]: { sessionId: crypto.randomUUID(), itemId, documentId, name, settings, state: 'pending', message: '等待同步到控台' } } }));
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
  const entry = useMa2SyncStore.getState().songs[itemId];
  if (!entry || entry.state === 'paused') return;
  update(entry, { state: 'paused', message: entry.requestId ? '正在停止同步，等当前操作完成' : '已暂停同步' });
  if (entry.requestId) void window.tbLink.cancelMa2Read(entry.requestId).catch((cause: unknown) => {
    const message = `停止同步没有确认：${cause instanceof Error ? cause.message : String(cause)}`;
    update(entry, { message }); reportCoordinatorError(message, reason => update(entry, { message: reason }));
  });
}
function update(entry: SongSync, patch: Partial<SongSync>): void {
  useMa2SyncStore.setState(state => {
    const current = state.songs[entry.itemId];
    if (!current || current.sessionId !== entry.sessionId) return state;
    return { songs: { ...state.songs, [entry.itemId]: { ...current, ...patch, ...(current.state === 'paused' ? { state: 'paused' as const } : {}) } } };
  });
}
function confirmedMessage(binding: Ma2SongBinding, edits?: Ma2SongConsoleEdits): string {
  const location = binding.executor ? ma2ExecutorLocationLabel(Number(binding.executor.split('.')[0]), Number(binding.executor.split('.')[1])) : `Layout ${binding.layout}`;
  const taken = edits ? [edits.moved.length ? `挪了 ${edits.moved.length} 个` : '', edits.removed.length ? `删了 ${edits.removed.length} 个` : '', edits.added.length ? `加了 ${edits.added.length} 个` : ''].filter(Boolean) : [];
  return `${location} · 序列 ${binding.sequence} · ${binding.points.length} 步已确认${taken.length ? ` · 控台上${taken.join('、')} Cue，已同步到联动台` : ''}`;
}
function canContinue(entry: SongSync): boolean {
  const document = useDocumentStore.getState();
  const session = useMa2SyncStore.getState().songs[entry.itemId];
  const lighting = document.project?.rundown.find(item => item.id === entry.itemId)?.lighting;
  return document.documentId === entry.documentId && session?.sessionId === entry.sessionId
    && session.state !== 'paused' && ma2SyncActive()
    && readMa2Method() === 'network'
    && lighting !== undefined;
}

type SongConsole = { network: Ma2NetworkTarget; endpoint: string; source: { show: string; generation: string; version: string } };
/** The console every song syncs with. Null when the song now waits for it (its state says why) or its session ended. */
async function reachConsole(entry: SongSync): Promise<SongConsole | null> {
  const status = await window.tbLink.getMa2NetworkStatus();
  if (!canContinue(entry)) return null;
  if (status.state !== 'connected' || !status.settings) {
    update(entry, { state: 'pending', checking: false, waitingForConnection: true, nextCheckAt: Date.now() + 1000, message: '等待控台连接，可以继续编辑，连上后会接着同步' });
    return null;
  }
  const materials = useDocumentStore.getState().project?.ma2MaterialLibrary;
  if (!materials?.library || materials.library.sourceUnverified) throw new Error('请先读取控台素材');
  const { host, port, monitorPort, username } = status.settings;
  const endpoint = `${host}:${port}`;
  // Reached at another address: the session check moves the project's references first, then this song continues.
  if (endpoint !== materials.source) {
    update(entry, { state: 'pending', checking: false, nextCheckAt: Date.now() + 1000, message: '控台换了地址，核对后接着同步' });
    return null;
  }
  const { show, generation, version } = materials.library.directory;
  return { network: { host, port, monitorPort, username }, endpoint, source: { show, generation, version } };
}

/**
 * Way 1: the song plays the console's own Timecode show, and edits are written back to that show
 * (lighting workflow rule 5). Each pass reads the show, so console edits come back on the same
 * cadence as way 2's checks.
 */
async function syncImportedSong(entry: SongSync): Promise<void> {
  const place = await reachConsole(entry);
  if (!place) return;
  // A background tick never opens a dialog: the pre-sync archive needs the project's location.
  requireSavedProjectPath('同步控台');
  if (ma2SyncPlaying()) { update(entry, { state: 'pending', checking: false, message: '播放中，修改先保留，停止后继续同步' }); return; }
  update(entry, entry.state === 'verified' ? { checking: true } : { checking: true, state: 'syncing', message: '正在读取这首歌的控台时间码…' });
  const project = () => { const state = useDocumentStore.getState(); return state.documentId === entry.documentId ? state.project : null; };
  const outcome = await syncBoundSong({
    itemId: entry.itemId, connection: { dataDirectory: '', network: place.network }, project, consoleChanges: useMa2RealtimePreference.getState().consoleChanges,
    current: () => canContinue(entry) && !ma2SyncPlaying(),
    read: request => window.tbLink.previewMa2(request),
    compare: request => window.tbLink.compareMa2(request),
    apply: request => window.tbLink.applyMa2(request),
    archive: async () => { const value = project(); if (!value) throw new Error('工程已切换，同步已取消'); await archiveBeforeSync(entry.documentId, value); },
    confirm: command => { const state = useDocumentStore.getState(); state.executeForDocument(entry.documentId, command); state.markConsoleSynced(entry.documentId); },
    writing: message => update(entry, { state: 'syncing', writing: true, message })
  });
  if (outcome.kind === 'interrupted') { update(entry, { state: 'pending', checking: false, writing: false, nextCheckAt: 0, message: outcome.message }); return; }
  const shows = outcome.timecodes.map(target => `Timecode ${target}`).join('、');
  update(entry, { checking: false, writing: false, waitingForConnection: false, checkedAt: Date.now(), nextCheckAt: Date.now() + BACKGROUND_RECHECK_MS, consecutiveFailures: 0, consecutiveCollisions: 0,
    ...outcome.held ? { state: 'pending' as const, recheckRevision: useDocumentStore.getState().revision, message: outcome.held }
      : { state: 'verified' as const, recheckRevision: undefined, message: shows ? `${shows} ${outcome.wrote ? '已写入控台并回读确认' : '和控台一致'}` : '这首歌的控台时间码起点和歌曲不一致，暂不核对；起始码对上后会自动同步' } });
  // An edit made while this song was being written waits for its own sync instead of the next check.
  markPendingMa2Songs();
}

function setNames(patch: Partial<NameSync>): void {
  useMa2SyncStore.setState(state => ({ names: { ...state.names, ...patch } }));
}
/** Renamed console objects go first in each pass, under the same waits and the names' failure policy. */
async function syncNames(playing: boolean): Promise<void> {
  const names = useMa2SyncStore.getState().names;
  const document = useDocumentStore.getState();
  if (!pendingMa2Renames(document.project).length) {
    // Undone, or confirmed by an explicit request meanwhile.
    if (names.state === 'pending' || names.state === 'blocked') setNames({ state: 'idle', message: '', blockedRevision: undefined });
    return;
  }
  if (names.state === 'syncing') return;
  if (names.state === 'blocked' && names.blockedRevision === document.revision) return;
  if (names.state !== 'blocked' && names.nextCheckAt && Date.now() < names.nextCheckAt) return;
  if (playing || ma2SyncPlaying()) { setNames({ state: 'pending', message: '播放中，改名停止后再同步' }); return; }
  const status = await window.tbLink.getMa2NetworkStatus();
  if (status.state !== 'connected' || !status.settings) { setNames({ state: 'pending', nextCheckAt: Date.now() + 1000, message: '等待控台连接，连上后同步改名' }); return; }
  const { host, port, monitorPort, username } = status.settings;
  await runMa2NameSync({ dataDirectory: '', network: { host, port, monitorPort, username } }, document.documentId,
    () => readMa2Method() === 'network' && ma2SyncActive());
}

/** Serialize console reconciliation; local editing and saving remain independent. */
export async function tickMa2SongSync(playing: boolean): Promise<void> {
  if (running || readMa2Method() !== 'network' || !ma2SyncActive()) return;
  running = true;
  try {
    await syncNames(playing);
    // Songs with unconfirmed local edits go first; periodic checks of confirmed songs follow. Within
    // each, the song open in the editor goes first.
    const order = { pending: 0, syncing: 0, blocked: 1, verified: 2, paused: 3 } as const;
    const focus = focusedItemId();
    const rank = (entry: SongSync): number => order[entry.state] * 2 + (entry.itemId === focus ? 0 : 1);
    const startRevision = useDocumentStore.getState().revision;
    for (const entry of Object.values(useMa2SyncStore.getState().songs).sort((a, b) => rank(a) - rank(b))) {
      if (entry.documentId !== useDocumentStore.getState().documentId) { stopMa2SongSync(entry.itemId); continue; }
      if (entry.state === 'paused') continue;
      if (entry.state === 'blocked' && entry.blockedRevision === useDocumentStore.getState().revision) continue;
      // An edit made while this pass was checking other songs is synced on the next pass, before them.
      if (entry.state === 'verified' && useDocumentStore.getState().revision !== startRevision) break;
      const due = dueAt(entry);
      if (due && Date.now() < due && (!entry.consecutiveFailures || entry.blockedRevision === useDocumentStore.getState().revision)) continue;
      // A confirmed song's check waits for the stop too; it has nothing to send, so it stays confirmed.
      if (playing) { if (entry.state !== 'verified') update(entry, { state: 'pending', message: '播放中，修改会在停止后同步' }); continue; }
      update(entry, { attemptedAt: Date.now() });
      const imported = Boolean(useDocumentStore.getState().project?.rundown.find(value => value.id === entry.itemId)?.lighting?.ma2Bindings?.length);
      try {
        const before = useDocumentStore.getState(); const item = before.project?.rundown.find(value => value.id === entry.itemId);
        if (!before.project || !item?.lighting) throw new Error('这首歌已不存在');
        if (imported) { await syncImportedSong(entry); continue; }
        const points = ma2SongPoints(item.lighting);
        if (!points.length && !item.lighting.consoleSong) {
          update(entry, { state: 'pending', checking: false, message: '请先在时间线上添加 Cue，新歌还没在控台创建' });
          continue;
        }
        // The song's MTC start places its own Timecode show; changing it rewrites the show.
        let start = songStart(item);
        const signature = songSignature(points, item.lighting.consoleSong?.name ?? entry.name, start);
        const place = await reachConsole(entry);
        if (!place) continue;
        // An unassigned executor is assigned again by the full sync, so it is never only checked.
        const checkOnly = entry.acknowledged === signature && Boolean(entry.remoteRevision) && Boolean(item.lighting.consoleSong) && item.lighting.consoleSong?.assignment !== 'unassigned' && !entry.rewriteLegacyNames;
        // A periodic re-check of a confirmed song keeps its state and message.
        update(entry, checkOnly && entry.state === 'verified' ? { checking: true } : { checking: true, state: 'syncing', message: `正在检查这首歌的 ${points.length} 个 Cue…` });
        const { network, endpoint } = place;
        const { show, generation, version } = place.source;
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
          if (start === undefined) throw new Error('这首歌的 MTC 起点分配后没有写入歌曲，这次没有同步');
        }
        if (checkOnly && entry.remoteRevision && item.lighting.consoleSong) {
          const binding = item.lighting.consoleSong;
          // The song's own Timecode show is watched too: a time moved there on the console comes back here.
          const changed = await window.tbLink.checkMa2Song({ network, expectedSource: { show, generation, version }, sequence: binding.sequence, ...(binding.executor ? { executor: binding.executor } : {}), revision: entry.remoteRevision,
            ...(binding.timecode ? { timecode: { number: binding.timecode.number, revision: binding.timecode.revision } } : {}) });
          if (!canContinue(entry)) continue;
          if (!changed) {
            update(entry, { checking: false, state: 'verified', waitingForConnection: false, checkedAt: Date.now(), nextCheckAt: Date.now() + BACKGROUND_RECHECK_MS, message: confirmedMessage(binding) });
            // An edit made while the console was compared is not confirmed by that comparison.
            markPendingMa2Songs(); continue;
          }
          update(entry, { state: 'syncing', message: `控台有变化，正在检查这首歌的 ${points.length} 个 Cue…` });
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
        if (ma2SyncPlaying()) {
          update(entry, { state: 'pending', message: '播放中，修改先保留，停止后继续同步' }); continue;
        }
        const requestId = crypto.randomUUID();
        update(entry, { requestId, progress: null });
        const requestedName = item.lighting.consoleSong?.name ?? entry.name;
        const synced = await window.tbLink.syncMa2Song({ network, expectedSource: { show, generation, version }, projectId: before.project.projectId, itemId: item.id,
          requestId, progressId: requestId, settings, name: requestedName, points,
          ...(item.lighting.consoleSong ? { binding: item.lighting.consoleSong } : {}), ...(entry.rewriteLegacyNames ? { rewriteLegacyNames: true } : {}),
          writeMode: useMa2RealtimePreference.getState().writeMode, consoleChanges: useMa2RealtimePreference.getState().consoleChanges,
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
        if (after.documentId !== entry.documentId) throw new Error('控台操作已完成，但工程已切换，请回到原来的工程确认');
        const current = after.project?.rundown.find(value => value.id === entry.itemId)?.lighting;
        if (!current || !after.project) throw new Error('歌曲已删除，控台上的结果保留，请读取控台确认');
        // The console's address and Show name may follow the console meanwhile; the song's place on it may not.
        const locationIdentity = (binding: typeof current.consoleSong) => binding ? JSON.stringify([binding.sequence, binding.layout, binding.executor, binding.assignment]) : '';
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
            const updated = setLightingCommand(entry.itemId, acknowledged, '读取歌曲 Cue').execute(merged);
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
        update(entry, { state: 'verified', checking: false, waitingForConnection: false, checkedAt: Date.now(), nextCheckAt: Date.now() + BACKGROUND_RECHECK_MS, remoteRevision, consecutiveFailures: 0, consecutiveCollisions: 0,
          rewriteLegacyNames: false, acknowledged: songSignature(ma2SongPoints(confirmed), result.binding.name, start),
          message: confirmedMessage(result.binding, result.consoleEdits) });
        // An edit made while this song was being written waits for its own sync instead of the next check.
        markPendingMa2Songs();
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        // A transport loss is a wait state. After reconnect, the service reads
        // the native sequence and its durable journal before planning any write.
        let disconnected = false;
        try { disconnected = (await window.tbLink.getMa2NetworkStatus()).state !== 'connected'; }
        catch (statusError) { reportCoordinatorError(`读取连接状态失败：${String(statusError)}`, reason => update(entry, { message: reason })); }
        const playingNow = ma2SyncPlaying();
        // The console edited the song's Sequence while it was being written: nothing was written and the
        // next pass reads it again. A few in a row are a wait; an operator who keeps editing for longer
        // stops the retries like any failure, so the sync never keeps going round (2026-10-26).
        const collisions = message.startsWith(MA2_SONG_COLLISION) ? (entry.consecutiveCollisions ?? 0) + 1 : 0;
        const collided = collisions > 0 && collisions <= MAX_COLLISIONS;
        const waiting = disconnected || playingNow || collided;
        // Waiting for the console or for playback to stop is not a failed attempt.
        const consecutiveFailures = waiting ? entry.consecutiveFailures ?? 0 : (entry.consecutiveFailures ?? 0) + 1;
        const exhausted = consecutiveFailures >= (imported ? MAX_ATTEMPTS.imported : MAX_ATTEMPTS.own);
        update(entry, { state: exhausted ? 'blocked' : 'pending', blockedRevision: useDocumentStore.getState().revision, consecutiveFailures, consecutiveCollisions: collisions,
          nextCheckAt: Date.now() + (collided ? FOCUSED_RECHECK_MS : waiting ? 1000 : 1000 * consecutiveFailures),
          waitingForConnection: disconnected, checking: false, writing: false, recheckRevision: undefined, requestId: null, progress: null,
          message: playingNow ? '播放中，修改先保留，停止后继续同步'
            : disconnected ? `等待连接恢复后继续同步：${message}`
            : collided ? '控台上刚改过这首歌的序列，这次没有写入；稍后重新读取控台再同步'
            : exhausted && consecutiveFailures === 1 ? `同步失败，没有自动重试：${message}。修改保留在本地，处理好后点“刷新同步”`
            : exhausted ? `连续 ${consecutiveFailures} 次同步失败，已停止自动重试：${message}。修改保留在本地，处理好后点“刷新同步”`
            : `第 ${consecutiveFailures} 次同步失败，${consecutiveFailures} 秒后再试：${message}` });
        reportCoordinatorError(message, reason => { update(entry, { message: reason }); });
      }
    }
    finishMa2SyncOnce();
  } finally { running = false; }
}

/**
 * A one-time sync (real-time sync off) ends when every song of the open project was taken up since it
 * began, or waits on the operator: stopped after failing on this revision, or paused. Each song keeps
 * what that pass found; nothing runs again until the next edit is synced by hand.
 */
function finishMa2SyncOnce(): void {
  const { once, enabled } = useMa2RealtimePreference.getState();
  if (once === null || enabled) return;
  const { documentId, revision } = useDocumentStore.getState();
  const state = useMa2SyncStore.getState();
  const songs = Object.values(state.songs).filter(song => song.documentId === documentId);
  if (state.names.state === 'syncing' || songs.some(song => song.requestId)) return;
  if (songs.every(song => song.state === 'paused' || (song.attemptedAt ?? 0) >= once || song.state === 'blocked' && song.blockedRevision === revision)) useMa2RealtimePreference.setState({ once: null });
}
