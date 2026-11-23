import { sameMa2SongBinding, hasMa2SongSyncTarget, MA2_EDIT_ORDER_UNKNOWN, MA2_SONG_COLLISION, allocateSongMtcStart, isShowWait, toUserErrorMessage, applyMa2SongReadback, consoleLabelText, ma2LatestChoiceText, ma2PendingChanges, ma2SongPoints, mergeMa2AttributesCommand, projectLightingLibrary, setAllocatedMtcStartsCommand, setLightingLibraryCommand, setLightingCommand } from '@tb/core/link';
import type { Ma2LayoutSettings, Ma2NetworkTarget } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { confirmedMessage } from '../view-models/ma2-workbench-sync-status';
import { requireSavedProjectPath } from '../project-document';
import { acceptCreatedMa2Layout, currentMa2LayoutScope } from '../stores/ma2-layout-store';
import { locateMa2Executor, loadMa2ExecutorPage } from '../stores/ma2-executor-page-store';
import { recordRuntimeOperator, reportCoordinatorError } from './runtime-action-log';
import { settleInterruptedMa2Song, updateMa2Song as update, useMa2SyncStore, type SongSync } from '../stores/ma2-sync-store';
import { ma2ConsoleReading, readMa2SongPreview, settleTimecodeSourceError } from './ma2-console-reading';
import { currentShowWait } from '../stores/show-state-store';
import { checkSongDestination, songDestination, confirmMa2Edit, consoleSeenAt, editTimes, noteMa2LocalEdits, songSignature, songStart, type Program } from './ma2-edit-times';
import { readMa2Method } from '../stores/ma2-mode-store';
import { ma2SongSyncActive, ma2SyncActive, useMa2RealtimePreference } from './ma2-realtime-preference';
import { BACKGROUND_RECHECK_MS, dueAt, songSyncOrder } from './ma2-song-sync-order';
import { syncBoundSong } from './ma2-bound-song-sync';
import { syncPendingMa2Names } from './ma2-name-sync';
import { archiveBeforeSync } from './ma2-sync-archive';
import { archiveMa2Project } from './ma2-project-archive';
import { adoptMa2ConsoleVersion } from './ma2-console-version';
import { ma2ConsoleChangesFor, ma2SongShifted } from './ma2-song-shift';
import { unboundMa2Tracks } from '@tb/core/link';

/**
 * Failed attempts in a row before a sync stops and waits for an edit or 刷新同步. Way 2 (the song's
 * own Sequence) is retried as the lighting workflow's sync rules say. Way 1 (the console's own
 * Timecode show) and names are not retried on their own, as before both ways shared this driver
 * (project rule 4). Waiting for the connection, for the show or for an edit to settle is never a
 * failed attempt. The show is asked of showGate (S3b, 2026-11-11, 第 3 题): writes wait as `ma2.sync.write`, the
 * periodic check of a confirmed song as `ma2.sync.read`, only while the program moves, prepares or stops; paused,
 * paused at the end and P1 waiting for the next song sync as when stopped. A pass checks before each step, so a song
 * stops at the step it reached and the next pass after the wait carries on from there.
 */
const MAX_ATTEMPTS = { own: 3, imported: 1 } as const;
/** Console edits that collide with a write in a row before they count as a failed attempt. */
const MAX_COLLISIONS = 5;
const COLLISION_RECHECK_MS = 2000;
let running = false;
/**
 * Confirmed songs whose local content no longer matches what the console confirmed wait for a sync again.
 * The edit time is noted at once (the latest-wins rule compares it); the comparison waits for an idle
 * moment so typing in a large project does not stall, at most 200 ms. A pass of tickMa2SongSync runs a
 * waiting comparison first, so a pass never starts from an older mark. This is the window's own state,
 * not an external boundary: nothing is retried.
 */
export function markPendingMa2Songs(): void {
  noteMa2LocalEdits();
  if (cancelScheduledCheck) return;
  const run = (): void => { cancelScheduledCheck = null; checkPendingMa2Songs(); };
  if (typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(run, { timeout: 200 });
    cancelScheduledCheck = () => { cancelIdleCallback(handle); };
  } else {
    const handle = setTimeout(run, 0);
    cancelScheduledCheck = () => { clearTimeout(handle); };
  }
}
/** Runs the comparison markPendingMa2Songs left waiting for an idle moment now; nothing when none waits. */
export function flushPendingMa2Songs(): void {
  if (!cancelScheduledCheck) return;
  cancelScheduledCheck(); cancelScheduledCheck = null;
  checkPendingMa2Songs();
}
/** Right after a pass confirms a song: an edit made meanwhile waits for its own sync, not the next check. */
function markPendingMa2SongsNow(): void {
  markPendingMa2Songs();
  flushPendingMa2Songs();
}
/** Cancels the comparison waiting for an idle moment; null when none waits. */
let cancelScheduledCheck: (() => void) | null = null;
/**
 * What each confirmed song was last compared with and what came of it (null: matches what the console
 * confirmed, otherwise why it waits). The answer is worked out from these inputs alone, so a song whose
 * lighting, start, name and acknowledged content are the same objects is not compared again.
 */
type ComparedSong = { sessionId: string; lighting: object; playback: unknown; p1Media: unknown; name: string; acknowledged: string | undefined; outcome: string | null };
const comparedSongs = new Map<string, ComparedSong>();
function checkPendingMa2Songs(): void {
  const project = useDocumentStore.getState().project;
  const songs = useMa2SyncStore.getState().songs;
  for (const itemId of comparedSongs.keys()) if (!songs[itemId]) comparedSongs.delete(itemId);
  for (const entry of Object.values(songs)) {
    if (entry.state !== 'verified') continue;
    const item = project?.rundown.find(value => value.id === entry.itemId);
    const lighting = item?.lighting;
    if (!project || !item || !lighting) continue;
    const inputs = { sessionId: entry.sessionId, lighting, playback: item.playback, p1Media: item.p1Media, name: entry.name, acknowledged: entry.acknowledged };
    const known = comparedSongs.get(entry.itemId);
    const same = known !== undefined && (Object.keys(inputs) as Array<keyof typeof inputs>).every(key => known[key] === inputs[key]);
    const outcome = same ? known.outcome : pendingReason(project, entry, item, lighting);
    comparedSongs.set(entry.itemId, { ...inputs, outcome });
    if (outcome !== null) update(entry, { state: 'pending', nextCheckAt: 0, message: outcome });
  }
}
function pendingReason(project: NonNullable<ReturnType<typeof useDocumentStore.getState>['project']>, entry: SongSync, item: Program, lighting: NonNullable<Program['lighting']>): string | null {
  // Way 1 keeps the baseline the console confirmed in the song, so any difference from it is an edit to sync.
  if (lighting.ma2Bindings?.length) return unboundMa2Tracks(lighting).length || ma2PendingChanges(project).some(change => change.itemId === item.id) ? '修改已暂存，等待同步' : null;
  try {
    return entry.acknowledged !== songSignature(ma2SongPoints(lighting), lighting.consoleSong?.name ?? entry.name, songStart(item)) ? '修改已暂存，等待同步' : null;
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}
/** A new session reads the console in full on its first pass: nothing is taken as already confirmed. */
export function startMa2SongSync(itemId: string, name: string, settings: Ma2LayoutSettings): void {
  const documentId = useDocumentStore.getState().documentId;
  useMa2SyncStore.setState(state => {
    // What the app knows about edit times and reported failures outlives a restart of the song's sync.
    const previous = state.songs[itemId];
    const kept = previous?.documentId === documentId ? { localEditedAt: previous.localEditedAt, consoleSeen: previous.consoleSeen, loggedFailure: previous.loggedFailure, announcedFailure: previous.announcedFailure } : {};
    return { songs: { ...state.songs, [itemId]: { sessionId: crypto.randomUUID(), itemId, documentId, name, settings, state: 'pending', message: '等待同步到控台', ...kept } } };
  });
  // What the song holds now is where its next edit is timed from.
  noteMa2LocalEdits();
}
/** One destination policy for the header, automatic startup and the song panel. */
export function ma2SongSyncSettings(project: NonNullable<ReturnType<typeof useDocumentStore.getState>['project']>, itemId?: string): Ma2LayoutSettings {
  const binding = project.rundown.find(item => item.id === itemId)?.lighting?.consoleSong;
  const destination = project.rundown.find(item => item.id === itemId)?.lighting?.timelineDestination;
  const saved = projectLightingLibrary(project).consoleWorkspace;
  return {
    layout: binding?.layout ?? saved?.layout ?? 999, name: saved?.name ?? '歌曲 Cue',
    columns: saved?.columns ?? 8, nextSequence: binding?.sequence ?? destination?.sequence ?? saved?.nextSequence ?? 9000,
    ...(!binding?.layout ? { executorPage: binding?.executor ? Number(binding.executor.split('.')[0]) : destination ? Number(destination.executor.split('.')[0]) : saved?.executorPage ?? 1000 } : {})
  };
}
/**
 * 用控台上的 on a way-1 song the sync stopped on (2026-11-11): the project is archived first, then the
 * song's Timecode shows are read from the console now and become its Cues; its unsynced lighting edits
 * are dropped from the song and kept in the archive. The song then matches the console.
 */
export async function takeMa2SongFromConsole(itemId: string): Promise<string> {
  const entry = useMa2SyncStore.getState().songs[itemId];
  const before = useDocumentStore.getState();
  if (!entry || entry.documentId !== before.documentId || !before.project) throw new Error('这首歌没有在同步，或者工程已经换了');
  requireSavedProjectPath('用控台上的版本');
  const lighting = before.project.rundown.find(item => item.id === itemId)?.lighting;
  if (!await archiveMa2Project(before.documentId, before.project, 'manual')) throw new Error('原编排未能存档，未替换当前节目的灯光');
  const { timecodes, checkedConnection, playbackClockNote } = await adoptMa2ConsoleVersion(entry, lighting);
  const message = `已换成控台上的 ${timecodes.map(target => `Timecode ${target}`).join('、')}；联动台原来没写到控台的改动已存档`;
  update(entry, { state: 'verified', checking: false, writing: false, consecutiveFailures: 0, checkedAt: Date.now(), checkedConnection, nextCheckAt: Date.now() + BACKGROUND_RECHECK_MS,
    needsSourceCheck: false, localEditedAt: undefined, consoleSeen: undefined, ...succeeded, playbackClockNote, message });
  const project = useDocumentStore.getState().project;
  if (project) void recordRuntimeOperator(project.projectId, project.rundown.find(value => value.id === itemId), message).catch((cause: unknown) => update(entry, { message: `${message}；运行日志写入失败：${cause instanceof Error ? cause.message : String(cause)}` }));
  return message;
}

/**
 * 用联动台的 on a way-1 song the sync stopped on (2026-11-11): one pass writes the timeline over what was
 * changed on the console, as 以联动台为准 does; the console's version stays in the pre-sync archive and
 * the backup the console write makes. With real-time sync off it waits for 同步一次 like any edit.
 */
export function writeMa2SongFromSoftware(itemId: string): string {
  const entry = useMa2SyncStore.getState().songs[itemId];
  if (!entry) throw new Error('这首歌没有在同步');
  const message = ma2SyncActive() ? '按联动台的写到控台…' : '点“同步一次”时按联动台的写到控台';
  useMa2SyncStore.setState(state => ({ songs: { ...state.songs, [itemId]: { ...entry, state: 'pending', failedItem: undefined, consecutiveFailures: 0, nextCheckAt: 0, consoleChangesOnce: 'software', message } } }));
  return message;
}

export function chooseMa2ConflictingPoints(itemId: string, choice: 'local' | 'remote'): void {
  const entry = useMa2SyncStore.getState().songs[itemId];
  if (!entry?.needsConflictChoice || entry.documentId !== useDocumentStore.getState().documentId) return;
  update(entry, { state: 'pending', conflictChoice: choice, needsConflictChoice: false, consecutiveFailures: 0, failedItem: undefined, nextCheckAt: 0 });
}

function manualConflict(entry: SongSync) {
  if (useMa2RealtimePreference.getState().enabled) return undefined;
  return { ...(entry.checkedAt === undefined ? {} : { lastConfirmedAt: entry.checkedAt }), ...(entry.conflictChoice ? { choice: entry.conflictChoice } : {}) };
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
function canContinue(entry: SongSync): boolean {
  const document = useDocumentStore.getState();
  const session = useMa2SyncStore.getState().songs[entry.itemId];
  const lighting = document.project?.rundown.find(item => item.id === entry.itemId)?.lighting;
  return document.documentId === entry.documentId && session?.sessionId === entry.sessionId
    && session.state !== 'paused' && ma2SongSyncActive(entry.itemId)
    && readMa2Method() === 'network'
    && lighting !== undefined;
}

type SongConsole = { network: Ma2NetworkTarget; connectionId: number | undefined; endpoint: string; source: { show: string; generation: string; version: string } };
/** The console every song syncs with. Null when the song now waits for it (its state says why) or its session ended. */
async function reachConsole(entry: SongSync): Promise<SongConsole | null> {
  const status = await window.tbLink.getMa2NetworkStatus();
  if (!canContinue(entry)) return null;
  if (status.state !== 'connected' || !status.settings) {
    update(entry, { state: 'pending', checking: false, waitingForConnection: true, nextCheckAt: Date.now() + 1000, message: '等待控台连接，可以继续编辑，连上后会接着同步' });
    return null;
  }
  const materials = useDocumentStore.getState().project?.ma2MaterialLibrary;
  if (ma2ConsoleReading() || !materials?.library || materials.library.sourceUnverified) {
    update(entry, { state: 'pending', checking: false, waitingForConnection: false, nextCheckAt: Date.now() + 1000,
      message: ma2ConsoleReading() ? '正在读取或准备控台，完成后继续同步' : '等待确认控台素材，读取完成后继续同步' });
    return null;
  }
  const { host, port, monitorPort, username } = status.settings;
  const endpoint = `${host}:${port}`;
  // Reached at another address: the session check moves the project's references first, then this song continues.
  if (endpoint !== materials.source) {
    update(entry, { state: 'pending', checking: false, nextCheckAt: Date.now() + 1000, message: '控台换了地址，核对后接着同步' });
    return null;
  }
  const { show, generation, version } = materials.library.directory;
  return { network: { host, port, monitorPort, username }, connectionId: status.connection, endpoint, source: { show, generation, version } };
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
  const wait = currentShowWait('ma2.sync.write');
  if (wait) { update(entry, { state: 'pending', checking: false, message: wait }); return; }
  update(entry, entry.state === 'verified' ? { checking: true } : { checking: true, state: 'syncing', message: '正在读取这首歌的控台时间码…' });
  const project = () => { const state = useDocumentStore.getState(); return state.documentId === entry.documentId ? state.project : null; };
  const outcome = await syncBoundSong({
    // A song moved as a whole (blank time before its music) is written, not read back, until the console confirms it.
    itemId: entry.itemId, manualConflict: manualConflict(entry), connection: { dataDirectory: '', network: place.network }, project, consoleChanges: ma2ConsoleChangesFor(entry, useMa2RealtimePreference.getState().consoleChanges),
    current: () => canContinue(entry) && currentShowWait('ma2.sync.write') === null,
    executor: request => window.tbLink.readMa2Executor(request),
    firstTrack: (timecode, { executor, expectedSequence, points }) => window.tbLink.addMa2FirstTrackCues({
      dataDirectory: '', network: place.network, expectedSource: place.source, projectId: project()!.projectId, itemId: entry.itemId, timecode, executor,
      ...(expectedSequence && { expectedSequence }), points
    }),
    emptySequence: async (points, timecode, previous) => {
      const current = project();
      if (!current) throw new Error('工程已经切换');
      const settings = ma2SongSyncSettings(current, entry.itemId);
      const result = await window.tbLink.syncMa2Song({
        network: place.network, expectedSource: place.source, projectId: current.projectId,
        itemId: `${entry.itemId}:timecode:${timecode}:empty`, requestId: crypto.randomUUID(),
        name: previous?.name ?? `TC ${timecode} Cue`, settings: { ...settings, executorPage: settings.executorPage ?? 1000 },
        points, binding: previous, writeMode: 'direct', consoleChanges: 'read-back'
      });
      return result.binding;
    },
    assign: sequence => window.tbLink.assignMa2PoolSequence({ dataDirectory: '', network: place.network, expectedSource: place.source, projectId: project()!.projectId, sequence }),
    route: command => confirmMa2Edit(() => useDocumentStore.getState().executeForDocument(entry.documentId, command)),
    read: request => readMa2SongPreview(entry, request),
    compare: request => window.tbLink.compareMa2(request),
    apply: request => window.tbLink.applyMa2({ ...request, expectedSource: place.source }),
    archive: async () => { const value = project(); if (!value) throw new Error('工程已切换，同步已取消'); await archiveBeforeSync(entry.documentId, value); },
    confirm: command => {
      const state = useDocumentStore.getState();
      confirmMa2Edit(() => { state.executeForDocument(entry.documentId, command); state.markConsoleSynced(entry.documentId); });
    },
    writing: message => update(entry, { state: 'syncing', writing: true, message }),
    localEditedAt: () => useMa2SyncStore.getState().songs[entry.itemId]?.localEditedAt,
    consoleSeen: (timecode, revision) => consoleSeenAt(entry, `tc:${timecode}`, revision)
  });
  if (outcome.kind === 'interrupted') { update(entry, { state: 'pending', checking: false, writing: false, nextCheckAt: 0, message: currentShowWait('ma2.sync.write') ?? outcome.message }); return; }
  const shows = outcome.timecodes.map(target => `Timecode ${target}`).join('、');
  const chosen = outcome.chosen.join('；');
  const direction = outcome.deskChanges
    ? outcome.localChanges ? '两边的修改已核对，合并结果已由控台确认' : '控台改动已读回联动台'
    : outcome.wrote ? '已写入控台并核对' : '和控台一致';
  const latest = useDocumentStore.getState();
  if (chosen && latest.project) void recordRuntimeOperator(latest.project.projectId, latest.project.rundown.find(value => value.id === entry.itemId), chosen).catch((cause: unknown) => update(entry, { message: `${chosen}；运行日志写入失败：${cause instanceof Error ? cause.message : String(cause)}` }));
  update(entry, { checking: false, writing: false, waitingForConnection: false, checkedAt: Date.now(), checkedConnection: place.connectionId, nextCheckAt: Date.now() + BACKGROUND_RECHECK_MS, consecutiveFailures: 0, consecutiveCollisions: 0, ...succeeded,
    ...outcome.held ? { state: 'pending' as const, recheckRevision: useDocumentStore.getState().revision, message: outcome.held }
      : { state: 'verified' as const, recheckRevision: undefined, message: `${shows} ${direction}${chosen ? `；${chosen}` : ''}` } });
  // An edit made while this song was being written waits for its own sync instead of the next check.
  markPendingMa2SongsNow();
}

/** What a successful pass clears: a failure after it is reported again, and a one-time 用联动台的 is used up. */
const succeeded = { conflictChoice: undefined, needsConflictChoice: false, failedItem: undefined, loggedFailure: undefined, announcedFailure: undefined, consoleChangesOnce: undefined } as const;

function finishDeselectedSong(entry: SongSync): void {
  const song = useMa2SyncStore.getState().songs[entry.itemId];
  if (song?.sessionId === entry.sessionId && song.state !== 'paused' && song.checking && !ma2SongSyncActive(entry.itemId)) {
    update(entry, { state: 'pending', checking: false, writing: false, message: '等待下次同步时核对这首歌' });
  }
}

/** Serialize console reconciliation; local editing and saving remain independent. */
export async function tickMa2SongSync(): Promise<void> {
  // The pass starts from the latest marks, not from a comparison still waiting for an idle moment.
  flushPendingMa2Songs();
  if (running || readMa2Method() !== 'network' || !ma2SyncActive() || ma2ConsoleReading()) return;
  running = true;
  try {
    if (!useMa2RealtimePreference.getState().onceItemId) await syncPendingMa2Names();
    // Songs with unconfirmed local edits go first; periodic checks of confirmed songs follow. Within
    // each, the song open in the editor goes first.
    const order = songSyncOrder(flushPendingMa2Songs);
    const startRevision = useDocumentStore.getState().revision;
    for (const entry of order.songs) {
      if (order.changed(entry)) break;
      if (entry.documentId !== useDocumentStore.getState().documentId) { stopMa2SongSync(entry.itemId); continue; }
      if (entry.state === 'paused' || !ma2SongSyncActive(entry.itemId)) continue;
      const attemptedItem = useDocumentStore.getState().project?.rundown.find(item => item.id === entry.itemId);
      if (entry.needsSourceCheck || entry.state === 'blocked' && entry.failedItem === attemptedItem) continue;
      // An edit made while this pass was checking other songs is synced on the next pass, before them.
      if (entry.state === 'verified' && useDocumentStore.getState().revision !== startRevision) break;
      const due = dueAt(entry);
      if (due && Date.now() < due && (!entry.consecutiveFailures || entry.failedItem === attemptedItem)) continue;
      // A confirmed song's check waits for the show too; it has nothing to send, so it stays confirmed.
      const wait = currentShowWait(entry.state === 'verified' ? 'ma2.sync.read' : 'ma2.sync.write');
      if (wait) { if (entry.state !== 'verified') update(entry, { state: 'pending', message: wait }); continue; }
      update(entry, { attemptedAt: Date.now() });
      const imported = Boolean(useDocumentStore.getState().project?.rundown.find(value => value.id === entry.itemId)?.lighting?.ma2Bindings?.length);
      try {
        const before = useDocumentStore.getState(); const item = before.project?.rundown.find(value => value.id === entry.itemId);
        if (!before.project || !item?.lighting) throw new Error('这首歌已不存在');
        if (imported) { await syncImportedSong(entry); continue; }
        if (!hasMa2SongSyncTarget(item.lighting)) throw new Error('尚未匹配控台时间线，请先新建时间线并指定 MTC 和控台位置');
        const destination = songDestination(item.lighting);
        const stillSelected = () => checkSongDestination(entry, destination);
        const points = ma2SongPoints(item.lighting);
        // The song's MTC start places its own Timecode show; changing it rewrites the show.
        let start = songStart(item);
        const signature = songSignature(points, item.lighting.consoleSong?.name ?? item.lighting.timelineDestination?.name ?? entry.name, start);
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
          if (!canContinue(entry) || !stillSelected()) continue;
          if (!changed) {
            consoleSeenAt(entry, 'own', null);
            update(entry, { checking: false, state: 'verified', waitingForConnection: false, checkedAt: Date.now(), checkedConnection: place.connectionId, nextCheckAt: Date.now() + BACKGROUND_RECHECK_MS, message: confirmedMessage(binding), ...succeeded });
            // An edit made while the console was compared is not confirmed by that comparison.
            markPendingMa2SongsNow(); continue;
          }
          // The check does not say what changed, only that the console is no longer the confirmed baseline.
          consoleSeenAt(entry, 'own', entry.remoteRevision);
          update(entry, { state: 'syncing', message: `控台有变化，正在检查这首歌的 ${points.length} 个 Cue…` });
        }
        // A background tick never opens a dialog: the pre-sync archive needs the project's location.
        requireSavedProjectPath('同步控台');
        if (!canContinue(entry)) continue;
        const scope = currentMa2LayoutScope();
        const settings = ma2SongSyncSettings(before.project, entry.itemId);
        const archived = entry.acknowledged !== signature;
        // Retries of the same unconfirmed content reuse the archive taken before its first attempt.
        if (archived && entry.archivedSignature !== signature && await archiveBeforeSync(entry.documentId, before.project)) update(entry, { archivedSignature: signature });
        if (!canContinue(entry) || !stillSelected()) continue;
        const waitBeforeWrite = currentShowWait('ma2.sync.write');
        if (waitBeforeWrite) { update(entry, { state: 'pending', message: waitBeforeWrite }); continue; }
        const requestId = crypto.randomUUID();
        update(entry, { requestId, progress: null });
        const requestedName = item.lighting.consoleSong?.name ?? item.lighting.timelineDestination?.name ?? entry.name;
        const synced = await window.tbLink.syncMa2Song({ network, expectedSource: { show, generation, version }, projectId: before.project.projectId, itemId: item.id,
          requestId, progressId: requestId, settings, name: requestedName, points,
          ...(item.lighting.consoleSong ? { binding: item.lighting.consoleSong } : {}), ...(item.lighting.timelineDestination ? { destination: item.lighting.timelineDestination } : {}), ...(entry.rewriteLegacyNames ? { rewriteLegacyNames: true } : {}),
          // A song moved as a whole is written over the console's changes until the console confirms it (E15).
          writeMode: useMa2RealtimePreference.getState().writeMode, consoleChanges: ma2SongShifted(entry) ? 'software' : useMa2RealtimePreference.getState().consoleChanges,
          ...editTimes(entry), manualConflict: manualConflict(entry),
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
        if (!stillSelected()) continue;
        // The binding changed, or the points the console now confirms do: an empty Cue becomes a reference to its new Cue.
        if (!sameMa2SongBinding(current.consoleSong, result.binding) || JSON.stringify(ma2SongPoints(applyMa2SongReadback(current, points, result))) !== JSON.stringify(ma2SongPoints(current))) {
          if (!archived) await archiveBeforeSync(entry.documentId, after.project);
          if (!canContinue(entry) || !stillSelected()) continue;
          confirmMa2Edit(() => after.executeForDocument(entry.documentId, { id: crypto.randomUUID(), label: '同步歌曲控台序列', scope: 'lighting', historyRebaseKey: `ma2-song:${entry.itemId}`, rebaseHistory: project => ({
            ...project, rundown: project.rundown.map(value => value.id !== entry.itemId || !value.lighting || songDestination(value.lighting) !== destination ? value : { ...value, lighting: { ...value.lighting, consoleSong: result.binding } })
          }), execute(project) {
            const lighting = project.rundown.find(value => value.id === entry.itemId)?.lighting;
            if (!lighting) throw new Error('歌曲已不存在');
            if (songDestination(lighting) !== destination) throw new Error('这首歌已更换控台位置，旧同步结果没有写回，请重新核对当前时间线');
            const merged = mergeMa2AttributesCommand(endpoint, result.library, [result.binding.sequence], false, result.libraryDirectoryScope).execute(project);
            const acknowledged = applyMa2SongReadback(lighting, points, result);
            if (lighting.consoleSong && lighting.consoleSong.name !== item.lighting?.consoleSong?.name) acknowledged.consoleSong = { ...result.binding, name: lighting.consoleSong.name };
            const updated = setLightingCommand(entry.itemId, acknowledged, '读取歌曲 Cue').execute(merged);
            const library = projectLightingLibrary(updated);
            return setLightingLibraryCommand({ ...library, consoleWorkspace: { ...entry.settings, ...library.consoleWorkspace, nextSequence: Math.min(99999, Math.max(library.consoleWorkspace?.nextSequence ?? 1, result.binding.sequence + 1)) } }).execute(updated);
          }, undo: before => before }));
        }
        if (!canContinue(entry)) continue;
        if (result.layout) acceptCreatedMa2Layout(scope, result.layout, !item.lighting.consoleSong);
        if (result.binding.executor && !item.lighting.consoleSong) {
          const [page, slot] = result.binding.executor.split('.').map(Number);
          locateMa2Executor(page!, slot!); await loadMa2ExecutorPage(page!);
        }
        const confirmed = applyMa2SongReadback(item.lighting, points, result);
        const remoteRevision = result.remoteRevision ?? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(result.binding.baselineXml))), value => value.toString(16).padStart(2, '0')).join('');
        if (result.consoleEdits?.conflicts) void recordRuntimeOperator(after.project.projectId, after.project.rundown.find(value => value.id === entry.itemId), `「${item.title}」：${ma2LatestChoiceText('这首歌', result.consoleEdits.conflicts.count, result.consoleEdits.conflicts.winner, result.consoleEdits.conflicts.operatorChoice)}`).catch((cause: unknown) => reportCoordinatorError(`运行日志写入失败：${cause instanceof Error ? cause.message : String(cause)}`, reason => update(entry, { message: reason })));
        update(entry, { state: 'verified', checking: false, waitingForConnection: false, checkedAt: Date.now(), checkedConnection: place.connectionId, nextCheckAt: Date.now() + BACKGROUND_RECHECK_MS, remoteRevision, consecutiveFailures: 0, consecutiveCollisions: 0,
          rewriteLegacyNames: false, acknowledged: songSignature(ma2SongPoints(confirmed), result.binding.name, start), consoleSeen: undefined, ...succeeded,
          message: confirmedMessage(result.binding, result.consoleEdits) });
        // An edit made while this song was being written waits for its own sync instead of the next check.
        markPendingMa2SongsNow();
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (message.includes(MA2_EDIT_ORDER_UNKNOWN)) {
          update(entry, { state: 'blocked', checking: false, writing: false, requestId: null, progress: null, failedItem: attemptedItem,
            conflictChoice: undefined, needsConflictChoice: true, message: MA2_EDIT_ORDER_UNKNOWN });
          continue;
        }
        if (settleTimecodeSourceError(entry, cause, canContinue(entry), attemptedItem?.lighting) || settleInterruptedMa2Song(entry, message)) continue;
        // A transport loss is a wait state. After reconnect, the service reads
        // the native sequence and its durable journal before planning any write.
        let disconnected = false;
        try { disconnected = (await window.tbLink.getMa2NetworkStatus()).state !== 'connected'; }
        catch (statusError) { reportCoordinatorError(`读取连接状态失败：${String(statusError)}`, reason => update(entry, { message: reason })); }
        // The main process has the last word (S3a): it refuses with showGate's own text when the window's mirror of the
        // show was one change late, and a sync stopped at a step boundary (M3) adds how far it got. Either way the song
        // only waits; the next pass after the wait starts it again from reading the console.
        const showWait = isShowWait(cause) ? toUserErrorMessage(cause) : currentShowWait('ma2.sync.write');
        // The console edited the song's Sequence while it was being written: nothing was written and the
        // next pass reads it again. A few in a row are a wait; an operator who keeps editing for longer
        // stops the retries like any failure, so the sync never keeps going round (2026-10-26).
        const collisions = message.startsWith(MA2_SONG_COLLISION) ? (entry.consecutiveCollisions ?? 0) + 1 : 0;
        const collided = collisions > 0 && collisions <= MAX_COLLISIONS;
        const waiting = disconnected || showWait !== null || collided;
        // Waiting for the console or for the show is not a failed attempt.
        const consecutiveFailures = waiting ? entry.consecutiveFailures ?? 0 : (entry.consecutiveFailures ?? 0) + 1;
        const exhausted = !waiting && consecutiveFailures >= (imported ? MAX_ATTEMPTS.imported : MAX_ATTEMPTS.own);
        // A failure is a state, not one message per attempt (2026-11-11): the run log gets each text once
        // and a toast says once that the song stopped, until the text changes or the song syncs again.
        // The text says what really happens next: an edit or 刷新同步 tries again, nothing gives up for good.
        const reason = message.replace(/[。；;.\s]+$/, '');
        const title = useDocumentStore.getState().project?.rundown.find(value => value.id === entry.itemId)?.title ?? entry.name;
        const failure = showWait !== null ? showWait
          : disconnected ? `等待连接恢复后继续同步：${reason}`
          : collided ? '控台上刚改过这首歌的灯光，这次没有写入；稍后重新读取控台再同步'
          : exhausted ? `同步没成功：${reason}。改动还留在联动台，${useMa2RealtimePreference.getState().enabled ? '下次改动或点“刷新同步”时再试' : '点“同步一次”时再试'}${imported ? '；也可以在「同步状态详情」里选“用控台上的”或“用联动台的”' : ''}`
          : `同步没成功，${consecutiveFailures} 秒后再试：${reason}`;
        const latestEntry = useMa2SyncStore.getState().songs[entry.itemId];
        const reported = latestEntry?.sessionId === entry.sessionId ? latestEntry : entry;
        // A wait for the show is no failure: it is neither logged nor counted as the text already reported.
        const log = showWait === null && reason !== reported.loggedFailure;
        update(entry, { state: exhausted ? 'blocked' : 'pending', failedItem: waiting ? undefined : attemptedItem, consecutiveFailures, consecutiveCollisions: collisions,
          nextCheckAt: Date.now() + (collided ? COLLISION_RECHECK_MS : waiting ? 1000 : 1000 * consecutiveFailures),
          waitingForConnection: disconnected, checking: false, writing: false, recheckRevision: undefined, requestId: null, progress: null,
          // 用联动台的 chosen once holds through a wait (console away, the show, the console being edited); a real failure uses it up.
          ...waiting ? {} : { consoleChangesOnce: undefined },
          ...showWait === null ? { loggedFailure: reason } : {}, ...exhausted ? { announcedFailure: reason } : {},
          message: failure });
        if (log) reportCoordinatorError(`「${title}」${failure}`, value => { update(entry, { message: value }); });
      } finally { finishDeselectedSong(entry); }
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
  const { once, enabled, onceItemId } = useMa2RealtimePreference.getState();
  if (once === null || enabled) return;
  const { documentId, project } = useDocumentStore.getState();
  const state = useMa2SyncStore.getState();
  const songs = Object.values(state.songs).filter(song => song.documentId === documentId && (!onceItemId || song.itemId === onceItemId));
  if (!onceItemId && (state.names.state === 'syncing' || state.names.state === 'pending') || songs.some(song => song.requestId)) return;
  if (songs.every(song => song.state === 'paused' || song.state === 'verified' && (song.checkedAt ?? 0) >= once || song.state === 'blocked' && song.failedItem === project?.rundown.find(item => item.id === song.itemId))) useMa2RealtimePreference.setState({ once: null, onceItemId: null });
}
