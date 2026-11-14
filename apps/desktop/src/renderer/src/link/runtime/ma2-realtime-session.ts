import { allocateMissingMtcStarts, saveMa2MaterialLibraryCommand, setAllocatedMtcStartsCommand, songsNeedingMtcStart } from '@tb/core/link';
import { ma2EffectLibrarySchema } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { readMa2Method } from '../stores/ma2-mode-store';
import { useMa2MaterialReadStore } from '../stores/ma2-material-read-store';
import { ma2SongSyncSettings, startMa2SongSync, stopMa2SongSync } from './ma2-song-sync';
import { ma2SyncActive, setMa2RealtimeEnabled, useMa2RealtimePreference } from './ma2-realtime-preference';
import { useMa2SyncStore, type Ma2SessionCheck } from '../stores/ma2-sync-store';
import { currentShowWait } from '../stores/show-state-store';
import { useMtcStartAllocationStore } from '../stores/mtc-start-allocation-store';
import { reportCoordinatorError } from './runtime-action-log';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';

let preparing = false;
let sessionDocument = -1;
let blockedContext = '';
let verifiedSource = '';
let nextSourceCheck = 0;
/** Changes the session check's state only when it differs, so a steady state does not wake its readers every tick. */
function setSession(status: Ma2SessionCheck['status'], message: string): void {
  const session = useMa2SyncStore.getState().session;
  if (session.status !== status || session.message !== message) useMa2SyncStore.setState({ session: { status, message } });
}
/**
 * Checks that the console the project last read is reachable and the same console, moves the
 * project's references when it was saved under another Show name or reached at another address,
 * and gives every song with console lighting, either way, its sync job.
 */
export async function prepareMa2RealtimeSession(): Promise<boolean> {
  if (preparing) return false;
  if (readMa2Method() !== 'network') {
    for (const song of Object.values(useMa2SyncStore.getState().songs)) stopMa2SongSync(song.itemId);
    verifiedSource = '';
    if (ma2SyncActive()) setSession('waiting', '请在设备设置中通过网络连接 MA2，再同步到控台');
    return false;
  }
  const state = useDocumentStore.getState();
  if (sessionDocument !== state.documentId) {
    sessionDocument = state.documentId;
    verifiedSource = ''; nextSourceCheck = 0;
    for (const song of Object.values(useMa2SyncStore.getState().songs)) if (song.documentId !== state.documentId) stopMa2SongSync(song.itemId);
    useMa2SyncStore.setState(value => ({ songs: Object.fromEntries(Object.entries(value.songs).filter(([, song]) => song.documentId === state.documentId)) }));
    useMa2SyncStore.setState({ names: { state: 'idle', message: '' } });
    setSession('waiting', '实时同步已开启，等待连接控台和打开工程');
  }
  // Off, each song keeps what its last pass found; turning sync off already stopped what was running.
  if (!ma2SyncActive()) return false;
  // The session check reads the console: it waits only while the program moves, prepares or stops (showGate, S3b).
  const wait = currentShowWait('ma2.sync.read');
  if (wait !== null) { setSession('waiting', wait); return false; }
  if (!state.project) { setSession('waiting', '请先打开工程'); return false; }
  if (!state.path) { setSession('waiting', '请先保存工程，再同步到控台'); return false; }
  if (useMa2MaterialReadStore.getState().busy) { setSession('waiting', '正在读取控台素材，读完后继续同步'); return false; }
  const material = state.project.ma2MaterialLibrary;
  if (!material?.library) { setSession('waiting', '请先读取控台素材，再同步到控台'); return false; }
  if (material.library.sourceUnverified) { setSession('waiting', '上次读取还没确认，请重新读取控台素材'); return false; }
  const current = (): boolean => useDocumentStore.getState().documentId === state.documentId
    && ma2SyncActive() && readMa2Method() === 'network' && !useMa2MaterialReadStore.getState().busy;
  preparing = true;
  let context = '';
  try {
    const status = await window.tbLink.getMa2NetworkStatus();
    if (status.state !== 'connected' || !status.settings) {
      blockedContext = ''; verifiedSource = ''; nextSourceCheck = 0;
      setSession('waiting', '等待控台连接，可以继续编辑和保存');
      useMa2SyncStore.setState(value => ({ songs: Object.fromEntries(Object.entries(value.songs).map(([key, song]) => [key,
        song.documentId === state.documentId && song.state !== 'paused'
          ? { ...song, state: 'pending' as const, waitingForConnection: true, checking: false, nextCheckAt: Date.now() + 1000, message: '等待控台连接，可以继续编辑，连上后会接着同步' }
          : song])) }));
      return false;
    }
    const { host, port, monitorPort, username } = status.settings;
    const endpoint = `${host}:${port}`;
    context = JSON.stringify([state.documentId, state.revision, material.source, material.library.directory.show, material.library.directory.generation, material.library.directory.version, host, port]);
    if (!current()) return false;
    const connection = { dataDirectory: '', network: { host, port, monitorPort, username } };
    const sourceKey = JSON.stringify([state.documentId, endpoint, material.source, material.library.directory.show, material.library.directory.generation, material.library.directory.version]);
    if (verifiedSource !== sourceKey || Date.now() >= nextSourceCheck) {
      if (!verifiedSource && Date.now() < nextSourceCheck) return false;
      // The lightweight directory is verified twice by the adapter; no Cue XML
      // is transferred. A bridge restart changes generation, not Show identity.
      const metadata = ma2EffectLibrarySchema.parse(await window.tbLink.readMa2EffectLibrary({ ...connection, targets: [] }));
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
        setSession('waiting', '已重新连上控台，正在从原来的位置继续');
        for (const song of Object.values(useMa2SyncStore.getState().songs)) {
          if (song.documentId !== state.documentId || song.requestId || song.state === 'paused') continue;
          useMa2SyncStore.setState(value => ({ songs: { ...value.songs, [song.itemId]: { ...song, nextCheckAt: 0, consecutiveFailures: 0 } } }));
        }
      }
      verifiedSource = JSON.stringify([state.documentId, endpoint, endpoint, directory.show, directory.generation, directory.version]);
      nextSourceCheck = Date.now() + 5000;
    }
    if (!current()) return false;
    const unallocated = useDocumentStore.getState().project;
    if (!unallocated) return false;
    if (songsNeedingMtcStart(unallocated).length && !await allocateMtcStarts(connection.network, state.documentId, sourceKey, current)) return false;
    const project = useDocumentStore.getState().project;
    if (!project) return false;
    // Way 1 (the console's own Timecode show) and way 2 (the song's own Sequence) share one sync job per song.
    for (const item of project.rundown) {
      if (!item.lighting) continue;
      const existing = useMa2SyncStore.getState().songs[item.id];
      if (existing && (existing.state !== 'paused' || existing.requestId)) continue;
      const events = item.lighting.tracks.flatMap(track => track.clips.flatMap(clip => clip.events));
      if (!item.lighting.ma2Bindings?.length && !item.lighting.consoleSong && !events.some(event => event.kind === 'ma2' || event.kind === 'empty-cue')) continue;
      startMa2SongSync(item.id, item.lighting.consoleSong?.name ?? item.title, ma2SongSyncSettings(project, item.id));
    }
    // The whole check succeeded: a problem it reported earlier is over. A song's own failure stays on that song.
    blockedContext = '';
    setSession('ready', '已连上控台，修改会自动同步到控台');
    return true;
  } catch (cause) {
    verifiedSource = ''; nextSourceCheck = Date.now() + 1000;
    if (current()) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const errorContext = `${context}:${message}`;
      const reported = blockedContext === errorContext;
      blockedContext = errorContext;
      setSession('blocked', message);
      if (!reported) reportCoordinatorError(message, reason => { setSession('blocked', reason); });
    }
    return false;
  } finally { preparing = false; }
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
    const message = cause instanceof Error ? cause.message : String(cause);
    const repeated = allocation.context === context && allocation.error === message;
    useMtcStartAllocationStore.setState({ error: message, context, retryAt: Date.now() + 30_000 });
    if (!repeated) reportCoordinatorError(`分配 MTC 起点失败：${message}`, reason => { useMtcStartAllocationStore.setState({ error: reason }); });
  }
  return true;
}

/** A blocked name sync is tried again by the operator's explicit retry or refresh, like a blocked song. */
function retryNames(): void {
  const names = useMa2SyncStore.getState().names;
  if (names.state === 'blocked') useMa2SyncStore.setState({ names: { ...names, state: 'pending', blockedRevision: undefined, nextCheckAt: 0, message: '正在重新同步名称' } });
}

export function retryMa2RealtimeSession(): void {
  setMa2RealtimeEnabled(true);
  setSession('waiting', '正在重新检查控台'); retryNames();
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
  setMa2RealtimeEnabled(true);
  checkEverySong(itemId);
}

/**
 * 同步一次 (2026-11-04, sync by hand): with real-time sync off, every song is read in full and written
 * where it differs, once; real-time sync stays off and nothing runs again until the next 同步一次.
 */
export function syncMa2Once(): void {
  if (useMa2RealtimePreference.getState().enabled) { refreshMa2RealtimeSession(); return; }
  useMa2RealtimePreference.setState({ once: Date.now() });
  checkEverySong();
}

/**
 * A different write mode or console-edit choice applies to what is on the console now, not only to
 * the next edit: every song is read in full again on its next pass, which only runs while syncing.
 */
export function recheckMa2Songs(): void {
  for (const song of Object.values(useMa2SyncStore.getState().songs)) {
    if (song.requestId || song.state === 'paused') continue;
    useMa2SyncStore.setState(value => ({ songs: { ...value.songs, [song.itemId]: { ...song, state: 'pending', nextCheckAt: 0, consecutiveFailures: 0, remoteRevision: undefined, blockedRevision: undefined, message: '同步方式改了，下次同步按新的方式重新检查' } } }));
  }
}

function checkEverySong(itemId?: string): void {
  setSession('waiting', '正在重新检查控台'); if (itemId === undefined) retryNames();
  const project = useDocumentStore.getState().project;
  for (const song of Object.values(useMa2SyncStore.getState().songs)) {
    if (song.requestId || itemId !== undefined && song.itemId !== itemId) continue;
    const item = project?.rundown.find(value => value.id === song.itemId);
    if (!project || !item) continue;
    if (song.state === 'paused') { startMa2SongSync(item.id, item.lighting?.consoleSong?.name ?? song.name, ma2SongSyncSettings(project, item.id)); continue; }
    // Dropping the confirmed revision turns the next pass into a full read; the acknowledged content stays, so no extra archive is taken.
    useMa2SyncStore.setState(value => ({ songs: { ...value.songs, [song.itemId]: { ...song, state: 'pending', nextCheckAt: 0, consecutiveFailures: 0, remoteRevision: undefined, blockedRevision: undefined, message: '正在重新检查控台' } } }));
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
  setMa2RealtimeEnabled(true);
  const project = useDocumentStore.getState().project;
  if (!project) return;
  for (const song of songsWithoutConsoleShow(project)) {
    if (useMa2SyncStore.getState().songs[song.itemId]?.requestId) continue;
    const item = project.rundown.find(value => value.id === song.itemId)!;
    startMa2SongSync(item.id, item.lighting?.consoleSong?.name ?? item.title, ma2SongSyncSettings(project, item.id));
  }
  void prepareMa2RealtimeSession();
}

export function pendingSongSummary(project: ReturnType<typeof useDocumentStore.getState>['project']): Array<{ itemId: string; title: string; count: number; page: number }> {
  if (!project) return [];
  return project.rundown.flatMap(item => {
    if (!item.lighting || item.lighting.consoleSong || item.lighting.ma2Bindings?.length) return [];
    const count = new Set(item.lighting.tracks.flatMap(track => track.clips.flatMap(clip => clip.events.filter(event => event.kind === 'ma2' || event.kind === 'empty-cue').map(event => event.effectGroupId ?? event.id)))).size;
    return count ? [{ itemId: item.id, title: item.title, count, page: ma2SongSyncSettings(project, item.id).executorPage ?? 1000 }] : [];
  });
}
