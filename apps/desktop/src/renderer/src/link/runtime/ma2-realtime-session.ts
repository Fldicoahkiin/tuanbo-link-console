import { MA2_BRIDGE_BUSY_BEFORE_REQUEST, isShowWait, toUserErrorMessage, hasMa2SongSyncTarget, ma2BindingHold, allocateMissingMtcStarts, ma2SongPairs, pendingMa2Renames, saveMa2MaterialLibraryCommand, setAllocatedMtcStartsCommand, songsNeedingMtcStart } from '@tb/core/link';
import { ma2EffectLibrarySchema, type LightingDocument, type LinkProject, type Ma2Catalog, type Ma2CatalogRequest, type Ma2NetworkTarget } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { refreshSongCatalog } from './ma2-current-song-catalog';
import { readMa2Method } from '../stores/ma2-mode-store';
import { ma2SongSyncSettings, startMa2SongSync, stopMa2SongSync } from './ma2-song-sync';
import { ma2SongSyncActive, ma2SyncActive, setMa2RealtimeEnabled, useMa2RealtimePreference } from './ma2-realtime-preference';
import { updateMa2Song, useMa2SyncStore, type Ma2SessionCheck, type SongSync } from '../stores/ma2-sync-store';
import { confirmSongSelection, ma2ConsoleReading, readSongClockCatalog, songClockBindings } from './ma2-console-reading';
import { currentShowWait } from '../stores/show-state-store';
import { useMtcStartAllocationStore } from '../stores/mtc-start-allocation-store';
import { reportCoordinatorError } from './runtime-action-log';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';

let preparation: { documentId: number; itemId: string | null; result: Promise<boolean> } | undefined;
let sessionDocument = -1;
let blockedContext = '';
let verifiedSource = '';
let nextSourceCheck = 0;
/** Changes the session check's state only when it differs, so a steady state does not wake its readers every tick. */
function setSession(status: Ma2SessionCheck['status'], message: string, waitFor?: Ma2SessionCheck['waitFor']): void {
  const session = useMa2SyncStore.getState().session;
  if (session.status !== status || session.message !== message || session.waitFor !== waitFor) useMa2SyncStore.setState({ session: { status, message, ...(waitFor && { waitFor }) } });
}

/** Update the queue once per connection change, including songs still waiting their turn after reconnect. */
function setSongsWaitingForConnection(documentId: number, waiting: boolean): void {
  useMa2SyncStore.setState(state => {
    const changed = Object.values(state.songs).filter(song => song.documentId === documentId && song.state !== 'paused' && Boolean(song.waitingForConnection) !== waiting);
    if (!changed.length) return state;
    const songs = { ...state.songs };
    for (const song of changed) songs[song.itemId] = waiting
      ? { ...song, state: 'pending', waitingForConnection: true, checking: false, nextCheckAt: Date.now() + 1000, message: '等待控台连接，可以继续编辑，连上后会接着同步' }
      : { ...song, waitingForConnection: false, nextCheckAt: 0, message: '控台已连接，等待核对这首歌' };
    return { songs };
  });
}

function invalidateConfirmedSongs(documentId: number): void {
  useMa2SyncStore.setState(state => {
    const confirmed = Object.values(state.songs).filter(song => song.documentId === documentId && song.state === 'verified');
    if (!confirmed.length) return state;
    const songs = { ...state.songs };
    for (const song of confirmed) songs[song.itemId] = { ...song, state: 'pending', nextCheckAt: 0, needsSourceCheck: true, message: '控台 Show 已重新加载，等待核对这首歌' };
    return { songs };
  });
}

/**
 * Checks that the console the project last read is reachable and the same console, moves the
 * project's references when it was saved under another Show name or reached at another address,
 * and gives every song with console lighting, either way, its sync job.
 */
export function prepareMa2RealtimeSession(): Promise<boolean> {
  const documentId = useDocumentStore.getState().documentId;
  const itemId = useMa2RealtimePreference.getState().onceItemId;
  if (preparation) return preparation.documentId === documentId && preparation.itemId === itemId
    ? preparation.result : Promise.resolve(false);
  const result = checkSession().finally(() => { preparation = undefined; });
  preparation = { documentId, itemId, result };
  return result;
}

function blockMissingTimecode(project: LinkProject, selected: LinkProject['rundown'][number], target: number, show: string, savedShow: string): void {
  const previousShow = project.ma2ReadState?.catalog.directory.show ?? savedShow;
  const action = previousShow === show ? '请在控台恢复这条时间线，或在「控台时间线」重新关联。'
    : `请在控台打开工程上次使用的 Show「${previousShow}」，再点同步。`;
  const message = `当前 Show「${show}」没有「${selected.title}」关联的 Timecode ${target}。工程里的灯光和素材已保留。${action}`;
  blockCurrentSong(project, selected, message);
}

function blockCurrentSong(project: LinkProject, selected: LinkProject['rundown'][number], message: string, selectorTrackRepair?: SongSync['selectorTrackRepair']): void {
  verifiedSource = ''; nextSourceCheck = 0;
  if (!useMa2SyncStore.getState().songs[selected.id]) startMa2SongSync(selected.id, selected.title, ma2SongSyncSettings(project, selected.id));
  updateMa2Song(useMa2SyncStore.getState().songs[selected.id]!, { state: 'blocked', needsSourceCheck: true, needsConflictChoice: false, failedItem: selected, checking: false, writing: false, selectorTrackRepair, message });
  setSession('waiting', '等待核对当前节目', 'check');
  useMa2RealtimePreference.setState({ once: null, onceItemId: null });
  void linkDesktopViewModel.recordLog({ level: 'warning', category: 'device', device: 'MA2', message }).catch(console.error);
}

function acceptSongClock(project: LinkProject, item: LinkProject['rundown'][number], checked: Ma2Catalog, network: Ma2NetworkTarget): boolean {
  if (checked.playbackConflict) {
    const { show, generation, version } = checked.directory;
    blockCurrentSong(project, item, checked.playbackConflict, checked.selectorTrackConflict && { target: checked.selectorTrackConflict, network, source: { show, generation, version } });
    return false;
  }
  const previous = useMa2SyncStore.getState().songs[item.id];
  if (previous?.playbackClockNote !== checked.playbackClockNote) {
    if (!previous) startMa2SongSync(item.id, item.title, ma2SongSyncSettings(project, item.id));
    updateMa2Song(useMa2SyncStore.getState().songs[item.id]!, { playbackClockNote: checked.playbackClockNote });
  }
  return true;
}

export async function muteMa2SelectorTrack(song: SongSync): Promise<void> {
  const repair = song.selectorTrackRepair;
  const current = () => {
    const latest = useMa2SyncStore.getState().songs[song.itemId];
    return useDocumentStore.getState().documentId === song.documentId && latest?.sessionId === song.sessionId
      && latest.state === 'blocked' && latest.selectorTrackRepair === repair && latest.message === song.message;
  };
  if (!repair || !current()) throw new Error('歌曲或控台连接已切换，请重新核对当前节目');
  const wait = currentShowWait('ma2.sync.write');
  if (wait) throw new Error(wait);
  await window.tbLink.prepareMa2Playback({ network: repair.network, expectedSource: repair.source, muteSelectorTrack: repair.target, progressId: crypto.randomUUID() });
  if (current()) syncMa2Once(song.itemId);
}

async function confirmCurrentSong(project: LinkProject, selected: LinkProject['rundown'][number], times: Ma2Catalog,
  network: Ma2NetworkTarget, targets: number[], clock: Pick<Ma2CatalogRequest, 'otherClockBindings'>, endpoint: string, current: () => boolean): Promise<boolean> {
  if (times.playbackConflict) return acceptSongClock(project, selected, times, network);
  await refreshSongCatalog(network, endpoint, times, current);
  const latest = useDocumentStore.getState().project;
  if (!current() || !latest) return false;
  for (const entry of times.songOffsets ?? []) {
    const hold = ma2BindingHold(latest, selected.id, entry.target, entry.offset);
    if (hold) {
      blockCurrentSong(latest, selected, hold);
      return false;
    }
  }
  const checked = await confirmSongSelection(times, network, targets, clock, current, () => setSession('waiting', '正在恢复控台按时间码选歌的设置', 'check'));
  return current() && acceptSongClock(latest, selected, checked, network);
}

function waitForMa2Reading(): false {
  useMa2RealtimePreference.setState({ enabled: false, once: null, onceItemId: null });
  setSession('waiting', '控台已登录，请先读取控台灯光，再同步当前节目', 'connection');
  return false;
}

async function checkSession(): Promise<boolean> {
  if (readMa2Method() !== 'network') {
    for (const song of Object.values(useMa2SyncStore.getState().songs)) stopMa2SongSync(song.itemId);
    verifiedSource = '';
    if (ma2SyncActive()) setSession('waiting', '请在设备设置中通过网络连接 MA2，再同步到控台', 'connection');
    return false;
  }
  const state = useDocumentStore.getState();
  if (sessionDocument !== state.documentId) {
    sessionDocument = state.documentId;
    blockedContext = ''; verifiedSource = ''; nextSourceCheck = 0;
    for (const song of Object.values(useMa2SyncStore.getState().songs)) if (song.documentId !== state.documentId) stopMa2SongSync(song.itemId);
    useMa2SyncStore.setState(value => ({ songs: Object.fromEntries(Object.entries(value.songs).filter(([, song]) => song.documentId === state.documentId)) }));
    useMa2SyncStore.setState({ names: { state: 'idle', message: '' } });
    setSession('waiting', ma2SyncActive() ? '正在检查控台连接' : '尚未核对控台连接', 'check');
  }
  // Off, each song keeps what its last pass found; turning sync off already stopped what was running.
  if (!ma2SyncActive()) return false;
  // The session check reads the console: it waits only while the program moves, prepares or stops (showGate, S3b).
  const wait = currentShowWait('ma2.sync.read');
  if (wait !== null) { setSession('waiting', wait, 'show'); return false; }
  if (!state.project) { setSession('waiting', '请先打开工程', 'project'); return false; }
  if (!state.path) { setSession('waiting', '请先保存工程，再同步到控台', 'save'); return false; }
  if (ma2ConsoleReading()) { setSession('waiting', '正在读取或准备控台，完成后继续同步', 'reading'); return false; }
  const material = state.project.ma2MaterialLibrary;
  if (!material?.library) { setSession('waiting', '请先读取控台素材，再同步到控台', 'library'); return false; }
  if (material.library.sourceUnverified) { setSession('waiting', '上次读取还没确认，请重新读取控台素材', 'verify-library'); return false; }
  const { once, onceItemId: selectedId } = useMa2RealtimePreference.getState();
  const selected = state.project.rundown.find(item => item.id === selectedId);
  const bindings = selected?.lighting?.ma2Bindings;
  const ownedTimecode = selected?.lighting?.consoleSong?.timecode?.number;
  const targets = [...new Set([...(bindings ?? []).map(binding => binding.timecode), ...(ownedTimecode ? [ownedTimecode] : [])])];
  const current = (): boolean => {
    const doc = useDocumentStore.getState();
    const request = useMa2RealtimePreference.getState();
    const lighting = doc.project?.rundown.find(item => item.id === selectedId)?.lighting;
    return doc.documentId === state.documentId && request.once === once && request.onceItemId === selectedId
      && (!selectedId || (lighting?.ma2Bindings === bindings && lighting?.consoleSong?.timecode?.number === ownedTimecode))
      && ma2SyncActive() && readMa2Method() === 'network' && !ma2ConsoleReading();
  };
  let context = '';
  try {
    const status = await window.tbLink.getMa2NetworkStatus();
    if (!current()) return false;
    if (status.state !== 'connected' || !status.settings) {
      blockedContext = ''; verifiedSource = ''; nextSourceCheck = 0;
      setSession('waiting', '等待控台连接，可以继续编辑和保存', 'connection');
      setSongsWaitingForConnection(state.documentId, true);
      return false;
    }
    if (status.awaitingRead) return waitForMa2Reading();
    const { host, port, monitorPort, username } = status.settings;
    const endpoint = `${host}:${port}`;
    const connection = { dataDirectory: '', network: { host, port, monitorPort, username } };
    const sourceKey = JSON.stringify([state.documentId, endpoint, material.source, material.library.directory.show, material.library.directory.generation, material.library.directory.version]);
    context = sourceKey;
    const waitingForSource = Object.values(useMa2SyncStore.getState().songs).filter(song => song.documentId === state.documentId && song.needsSourceCheck && ma2SongSyncActive(song.itemId));
    if (waitingForSource.length || verifiedSource !== sourceKey || Date.now() >= nextSourceCheck) {
      if (!verifiedSource && Date.now() < nextSourceCheck) return false;
      // The foreground read already saved the directory. On startup at the same endpoint,
      // check the live identity first; only a changed identity needs a new directory.
      const sourceOnly = verifiedSource === sourceKey || (material.source === endpoint && !material.library.incomplete);
      const saved = material.library.directory;
      const clock = songClockBindings(selected ?? undefined);
      const times = targets.length ? await readSongClockCatalog(connection.network, targets, clock) : null;
      if (!current()) return false;
      if (times && selected) {
        if (times.sourceUnverified || times.incomplete) throw new Error('控台还没读完时间线目录，请稍后再核对当前节目');
        const missing = targets.find(target => !times.directory.entries.some(entry => entry.target === target));
        if (missing) {
          if (times.directory.show !== saved.show || times.directory.generation !== saved.generation || times.directory.version !== saved.version) invalidateConfirmedSongs(state.documentId);
          blockMissingTimecode(state.project, selected, missing, times.directory.show, saved.show);
          return false;
        }
      }
      // A targeted directory read already identifies the live Show. Reuse it for the source check.
      let metadata = times ?? ma2EffectLibrarySchema.parse(await window.tbLink.readMa2EffectLibrary({ ...connection, targets: [], ...(sourceOnly ? { details: 'source' as const } : {}) }));
      if (!current()) return false;
      if ((sourceOnly || times) && (!metadata.directory.generation || metadata.directory.show !== saved.show || metadata.directory.version !== saved.version
        || metadata.directory.generation !== saved.generation || (times && !sourceOnly))) {
        metadata = ma2EffectLibrarySchema.parse(await window.tbLink.readMa2EffectLibrary({ ...connection, targets: [] }));
        if (times && (times.directory.show !== metadata.directory.show || times.directory.generation !== metadata.directory.generation
          || times.directory.version !== metadata.directory.version)) throw new Error('控台的节目目录刚有变化，请重新核对当前节目');
      }
      if (!current()) return false;
      const latest = useDocumentStore.getState();
      const cache = latest.project?.ma2MaterialLibrary;
      if (!cache?.library || cache.source !== material.source || cache.library.directory.show !== material.library.directory.show
        || cache.library.directory.generation !== material.library.directory.generation || cache.library.directory.version !== material.library.directory.version) return false;
      const directory = metadata.directory;
      if (metadata.sourceUnverified || metadata.incomplete) throw new Error('控台还没读完，本地修改已保留，请稍后重新读取');
      // The console is known by its object numbers (2026-10-30): a Show saved under a new name, another
      // address or a restarted bridge is the same console, and the project's references move with it.
      const moved = cache.source !== endpoint || directory.show !== cache.library.directory.show || directory.version !== cache.library.directory.version;
      if (moved || directory.generation !== cache.library.directory.generation) {
        invalidateConfirmedSongs(state.documentId);
        const exists = (sequence: number): boolean => directory.entries.some(entry => entry.target === sequence);
        if (moved) void linkDesktopViewModel.recordLog({ level: 'info', category: 'device', device: 'MA2',
          message: `控台现在是 ${endpoint} 上的“${directory.show}”（工程上次读的是 ${cache.source} 上的“${cache.library.directory.show}”），按编号接着同步`,
          details: { from: { endpoint: cache.source, show: cache.library.directory.show, generation: cache.library.directory.generation, version: cache.library.directory.version },
            to: { endpoint, show: directory.show, generation: directory.generation, version: directory.version } } }).catch(console.error);
        // Keep cached fixture data explicitly at its original readAt. This
        // advances only the verified session/directory; song content is still
        // compared against native snapshots before each write.
        latest.executeForDocument(state.documentId, saveMa2MaterialLibraryCommand(endpoint, {
          ...cache.library, directory,
          sequences: cache.library.sequences.filter(sequence => exists(sequence.sequence)),
          fixtureUsage: cache.library.fixtureUsage.filter(entry => exists(entry.sequence)),
          ...(cache.library.cueAttributes ? { cueAttributes: cache.library.cueAttributes.filter(entry => exists(entry.sequence)) } : {}),
          errors: cache.library.errors.filter(entry => exists(entry.sequence))
        }));
        setSession('waiting', '已重新连上控台，正在从原来的位置继续', 'check');
        for (const song of Object.values(useMa2SyncStore.getState().songs)) {
          if (song.documentId !== state.documentId || song.requestId || song.state === 'paused') continue;
          useMa2SyncStore.setState(value => ({ songs: { ...value.songs, [song.itemId]: { ...song, nextCheckAt: 0, consecutiveFailures: 0 } } }));
        }
      }
      if (times && selected && !await confirmCurrentSong(state.project, selected, times, connection.network, targets, clock, endpoint, current)) return false;
      for (const song of waitingForSource) {
        const currentSong = useMa2SyncStore.getState().songs[song.itemId];
        if (currentSong?.sessionId === song.sessionId) useMa2SyncStore.setState(value => ({ songs: { ...value.songs, [song.itemId]: { ...currentSong, needsSourceCheck: false, nextCheckAt: 0 } } }));
      }
      verifiedSource = JSON.stringify([state.documentId, endpoint, endpoint, directory.show, directory.generation, directory.version]);
      nextSourceCheck = Date.now() + 5000;
    }
    if (!current()) return false;
    const unallocated = useDocumentStore.getState().project;
    if (!unallocated) return false;
    if (!useMa2RealtimePreference.getState().onceItemId && songsNeedingMtcStart(unallocated).length && !await allocateMtcStarts(connection.network, state.documentId, sourceKey, current)) return false;
    const project = useDocumentStore.getState().project;
    if (!project) return false;
    setSongsWaitingForConnection(state.documentId, false);
    // Way 1 (the console's own Timecode show) and way 2 (the song's own Sequence) share one sync job per song.
    for (const item of project.rundown) {
      if (!item.lighting || !ma2SongSyncActive(item.id)) continue;
      const existing = useMa2SyncStore.getState().songs[item.id];
      if (existing && (existing.state !== 'paused' || existing.requestId)) continue;
      if (!hasMa2SongSyncTarget(item.lighting)) continue;
      startMa2SongSync(item.id, item.lighting.consoleSong?.name ?? item.lighting.timelineDestination?.name ?? item.title, ma2SongSyncSettings(project, item.id));
    }
    // The whole check succeeded: a problem it reported earlier is over. A song's own failure stays on that song.
    blockedContext = '';
    const songs = Object.values(useMa2SyncStore.getState().songs).filter(song => song.documentId === state.documentId && ma2SongSyncActive(song.itemId) && song.state !== 'paused');
    if (!songs.length && !pendingMa2Renames(project).length) {
      const readFailure = project.ma2ReadState?.failures[0];
      const unmatched = ma2SongPairs(project).unresolved[0];
      setSession('waiting', readFailure ? `Cue 还没放进歌曲：${readFailure.message}`
        : unmatched ? `还没有可同步的歌曲：${unmatched.reason}`
        : '尚未匹配控台时间线；请确认 MTC 起始码，或新建时间线并指定位置', readFailure ? 'song-read' : unmatched ? 'unmatched' : 'empty');
      return false;
    }
    setSession('ready', '已连上控台，可以同步当前节目');
    return true;
  } catch (cause) {
    if (current()) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const wait = isShowWait(cause) ? toUserErrorMessage(cause) : currentShowWait('ma2.sync.read');
      if (wait) { setSession('waiting', wait, 'show'); return false; }
      verifiedSource = ''; nextSourceCheck = Date.now() + 1000;
      if (message === MA2_BRIDGE_BUSY_BEFORE_REQUEST) { setSession('waiting', message, 'check'); return false; }
      const errorContext = `${context}:${message}`;
      const reported = blockedContext === errorContext;
      blockedContext = errorContext;
      setSession('blocked', message);
      if (!reported) reportCoordinatorError(message, reason => { if (blockedContext === errorContext && current()) setSession('blocked', reason); });
    }
    return false;
  }
}

/**
 * Songs being lit get their MTC start as soon as the console is reachable, before their first Cue, so
 * each song shows the timecode its console show will run on. A failure is shown on those songs and
 * logged, and does not hold up the other songs; it is tried again on another console session or
 * after 30 s, not on every edit. Returns false when the session changed or the show started moving meanwhile.
 */
async function allocateMtcStarts(network: Parameters<typeof window.tbLink.ma2TimecodeRanges>[0], documentId: number, context: string, current: () => boolean): Promise<boolean> {
  const allocation = useMtcStartAllocationStore.getState();
  if (allocation.context === context && Date.now() < allocation.retryAt) return true;
  try {
    const ranges = await window.tbLink.ma2TimecodeRanges(network);
    if (!current() || currentShowWait('ma2.sync.read') !== null) return false;
    const latest = useDocumentStore.getState();
    if (latest.project && songsNeedingMtcStart(latest.project).length) latest.executeForDocument(documentId, setAllocatedMtcStartsCommand(allocateMissingMtcStarts(latest.project, ranges)));
    useMtcStartAllocationStore.setState({ error: null, context: '', retryAt: 0 });
  } catch (cause) {
    if (!current()) return false;
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message === MA2_BRIDGE_BUSY_BEFORE_REQUEST) { setSession('waiting', message, 'check'); return false; }
    const repeated = allocation.context === context && allocation.error === message;
    useMtcStartAllocationStore.setState({ error: message, context, retryAt: Date.now() + 30_000 });
    if (!repeated) reportCoordinatorError(`分配 MTC 起点失败：${message}`, reason => { if (current()) useMtcStartAllocationStore.setState({ error: reason }); });
  }
  return true;
}

/** A blocked name sync is tried again by the operator's explicit retry or refresh, like a blocked song. */
function retryNames(): void {
  const names = useMa2SyncStore.getState().names;
  if (names.state === 'blocked') useMa2SyncStore.setState({ names: { ...names, state: 'pending', blockedNames: undefined, nextCheckAt: 0, message: '正在重新同步名称' } });
}

export function retryMa2RealtimeSession(): void {
  useMa2RealtimePreference.setState({ enabled: false, once: Date.now(), onceItemId: null });
  setSession('waiting', '正在重新检查控台', 'check'); retryNames();
  for (const song of Object.values(useMa2SyncStore.getState().songs)) {
    if (song.state !== 'blocked' && song.state !== 'paused') continue;
    if (song.requestId) continue;
    const project = useDocumentStore.getState().project;
    const item = project?.rundown.find(value => value.id === song.itemId);
    if (project && item) startMa2SongSync(item.id, item.lighting?.consoleSong?.name ?? song.name, ma2SongSyncSettings(project, item.id));
  }
  void prepareMa2RealtimeSession();
}

/**
 * 刷新同步: each song (or the one given) reads its console Sequence in full right away and is written
 * wherever the console differs from the timeline, including Cues or a Sequence deleted on the console.
 * A song whose write is running keeps it; its result is read back as usual.
 */
export function refreshMa2RealtimeSession(itemId?: string): void {
  useMa2RealtimePreference.setState({ enabled: false, once: Date.now(), onceItemId: itemId ?? null });
  checkEverySong(itemId);
}

/**
 * 同步一次 (2026-11-04, sync by hand): with real-time sync off, every song is read in full and written
 * where it differs, once; real-time sync stays off and nothing runs again until the next 同步一次.
 */
export function syncMa2Once(itemId?: string): void {
  useMa2RealtimePreference.setState({ enabled: false, once: Date.now(), onceItemId: itemId ?? null });
  checkEverySong(itemId, true);
}

/**
 * A different write mode or console-edit choice applies to what is on the console now, not only to
 * the next edit: every song is read in full again on its next pass, which only runs while syncing.
 */
export function recheckMa2Songs(): void {
  for (const song of Object.values(useMa2SyncStore.getState().songs)) {
    if (song.requestId || song.state === 'paused') continue;
    useMa2SyncStore.setState(value => ({ songs: { ...value.songs, [song.itemId]: { ...song, state: 'pending', nextCheckAt: 0, consecutiveFailures: 0, remoteRevision: undefined, failedItem: undefined, message: '同步方式改了，下次同步按新的方式重新检查' } } }));
  }
}

function checkEverySong(itemId?: string, compareConfirmed = false): void {
  nextSourceCheck = 0;
  setSession('waiting', '正在重新检查控台', 'check'); if (itemId === undefined) retryNames();
  const project = useDocumentStore.getState().project;
  for (const song of Object.values(useMa2SyncStore.getState().songs)) {
    if (song.requestId || itemId !== undefined && song.itemId !== itemId) continue;
    const item = project?.rundown.find(value => value.id === song.itemId);
    if (!project || !item) continue;
    if (song.state === 'paused') { startMa2SongSync(item.id, item.lighting?.consoleSong?.name ?? song.name, ma2SongSyncSettings(project, item.id)); continue; }
    // Dropping the confirmed revision turns the next pass into a full read; the acknowledged content stays, so no extra archive is taken.
    useMa2SyncStore.setState(value => ({ songs: { ...value.songs, [song.itemId]: { ...song, state: 'pending', nextCheckAt: 0, consecutiveFailures: 0, remoteRevision: compareConfirmed ? song.remoteRevision : undefined, failedItem: undefined, message: '正在重新检查控台' } } }));
  }
  void prepareMa2RealtimeSession();
}

export function pauseMa2RealtimeSession(): void {
  if (ma2SyncActive()) setMa2RealtimeEnabled(false);
  for (const song of Object.values(useMa2SyncStore.getState().songs)) stopMa2SongSync(song.itemId);
}

/** Songs synced as a console Sequence on an executor that have no Timecode show of their own yet: they cannot play from MTC. */
export function songsWithoutConsoleShow(project: ReturnType<typeof useDocumentStore.getState>['project']): Array<{ itemId: string; title: string }> {
  return project?.rundown.flatMap(item => item.lighting?.consoleSong?.executor && !item.lighting.consoleSong.timecode ? [{ itemId: item.id, title: item.title }] : []) ?? [];
}

/** Syncs those songs again in full, which writes their Timecode shows. */
export function writeMissingConsoleShows(): void {
  useMa2RealtimePreference.setState({ enabled: false, once: Date.now(), onceItemId: null });
  const project = useDocumentStore.getState().project;
  if (!project) return;
  for (const song of songsWithoutConsoleShow(project)) {
    if (useMa2SyncStore.getState().songs[song.itemId]?.requestId) continue;
    const item = project.rundown.find(value => value.id === song.itemId)!;
    startMa2SongSync(item.id, item.lighting?.consoleSong?.name ?? item.title, ma2SongSyncSettings(project, item.id));
  }
  void prepareMa2RealtimeSession();
}

/** New timelines with an explicit destination, including empty ones, wait for console creation. */
export function pendingSongSummary(project: ReturnType<typeof useDocumentStore.getState>['project']): Array<{ itemId: string; title: string; count: number; page: number }> {
  if (!project) return [];
  return project.rundown.flatMap(item => {
    if (!hasMa2SongSyncTarget(item.lighting) || !item.lighting?.timelineDestination || item.lighting.consoleSong || item.lighting.ma2Bindings?.length) return [];
    return [{ itemId: item.id, title: item.title, count: songCueCount(item.lighting), page: ma2SongSyncSettings(project, item.id).executorPage ?? 1000 }];
  });
}

/** Local Cue drafts without a destination need association; pressing sync cannot write them yet. */
export function unlinkedSongSummary(project: ReturnType<typeof useDocumentStore.getState>['project']): Array<{ itemId: string; title: string; count: number }> {
  return project?.rundown.flatMap(item => {
    if (!item.lighting || hasMa2SongSyncTarget(item.lighting)) return [];
    const count = songCueCount(item.lighting);
    return count ? [{ itemId: item.id, title: item.title, count }] : [];
  }) ?? [];
}

function songCueCount(document: LightingDocument): number {
  return new Set(document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events.filter(event => event.kind === 'ma2' || event.kind === 'empty-cue').map(event => event.effectGroupId ?? event.id)))).size;
}
