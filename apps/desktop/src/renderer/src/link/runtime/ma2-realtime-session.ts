import { pendingMa2Renames, saveMa2MaterialLibraryCommand } from '@tb/core/link';
import { ma2EffectLibrarySchema } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { readMa2Method } from '../stores/ma2-mode-store';
import { useMa2MaterialReadStore } from '../stores/ma2-material-read-store';
import { ma2SongSyncSettings, startMa2SongSync, stopMa2SongSync, useMa2SongSyncStore } from './ma2-song-sync';
import { setMa2RealtimeEnabled, useMa2RealtimePreference } from './ma2-realtime-preference';
import { useMa2AutoSyncStore } from '../stores/ma2-auto-sync-store';
import { reportCoordinatorError } from './runtime-action-log';

let preparing = false;
let sessionDocument = -1;
let blockedContext = '';
let verifiedSource = '';
let nextSourceCheck = 0;
/** Set only when this session check raised 'blocked', so a recovery never clears Ma2AutoSync's own block. */
let sessionBlocked = false;
/** Network song creation never enters the legacy implicit Timecode provisioning path. */
export async function prepareMa2RealtimeSession(): Promise<boolean> {
  if (preparing) return false;
  if (readMa2Method() !== 'network') {
    for (const song of Object.values(useMa2SongSyncStore.getState().songs)) stopMa2SongSync(song.itemId);
    verifiedSource = '';
    return false;
  }
  const state = useDocumentStore.getState();
  if (sessionDocument !== state.documentId) {
    sessionDocument = state.documentId;
    verifiedSource = ''; nextSourceCheck = 0;
    for (const song of Object.values(useMa2SongSyncStore.getState().songs)) if (song.documentId !== state.documentId) stopMa2SongSync(song.itemId);
    useMa2SongSyncStore.setState(value => ({ songs: Object.fromEntries(Object.entries(value.songs).filter(([, song]) => song.documentId === state.documentId)) }));
    useMa2AutoSyncStore.setState({ request: null, status: 'waiting', message: '实时同步已开启，等待控台连接与工程' });
  }
  if (!useMa2RealtimePreference.getState().enabled) {
    pauseMa2RealtimeSession();
    return false;
  }
  const playback = useMa2AutoSyncStore.getState();
  if (playback.timelinePlaying || playback.previewPlaying) return false;
  if (!state.project || !state.path || useMa2MaterialReadStore.getState().busy) return false;
  const material = state.project.ma2MaterialLibrary;
  if (!material?.library || material.library.sourceUnverified) return false;
  const current = (): boolean => useDocumentStore.getState().documentId === state.documentId
    && useMa2RealtimePreference.getState().enabled && readMa2Method() === 'network' && !useMa2MaterialReadStore.getState().busy;
  preparing = true;
  let context = '';
  try {
    const status = await window.tbLink.getMa2NetworkStatus();
    if (status.state !== 'connected' || !status.settings) {
      blockedContext = ''; verifiedSource = ''; nextSourceCheck = 0;
      if (useMa2AutoSyncStore.getState().request || useMa2AutoSyncStore.getState().status === 'blocked') useMa2AutoSyncStore.setState({ request: null, status: 'waiting', message: '等待控台连接；本地编辑和保存仍可使用' });
      useMa2SongSyncStore.setState(value => ({ songs: Object.fromEntries(Object.entries(value.songs).map(([key, song]) => [key,
        song.documentId === state.documentId && song.state !== 'paused'
          ? { ...song, state: 'pending' as const, waitingForConnection: true, checking: false, nextCheckAt: Date.now() + 1000, message: '等待控台连接；可以继续编辑，连接恢复后核对并续传' }
          : song])) }));
      return false;
    }
    const { host, port, monitorPort, username } = status.settings;
    context = JSON.stringify([state.documentId, state.revision, material.source, material.library.directory.show, material.library.directory.generation, material.library.directory.version, host, port]);
    if (material.source !== `${host}:${port}`) throw new Error('当前控台与工程素材来源不同，请读取当前控台后再同步');
    if (!current()) return false;
    const connection = { dataDirectory: '', network: { host, port, monitorPort, username } };
    const sourceKey = JSON.stringify([state.documentId, material.source, material.library.directory.show, material.library.directory.generation, material.library.directory.version]);
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
      if (metadata.sourceUnverified || metadata.incomplete) throw new Error('控台目录尚未核对完成；本地修改保留，稍后重新读取');
      if (directory.show !== cache.library.directory.show || directory.version !== cache.library.directory.version) throw new Error('控台 Show 或版本已变化，原工程修改已保留，请读取当前控台后核对');
      if (directory.generation !== cache.library.directory.generation) {
        const exists = (sequence: number): boolean => directory.entries.some(entry => entry.target === sequence);
        // Keep cached fixture data explicitly at its original readAt. This
        // advances only the verified session/directory; song content is still
        // compared against native snapshots before each write.
        latest.executeForDocument(state.documentId, saveMa2MaterialLibraryCommand(cache.source, {
          ...cache.library, directory,
          sequences: cache.library.sequences.filter(sequence => exists(sequence.sequence)),
          fixtureUsage: cache.library.fixtureUsage.filter(entry => exists(entry.sequence)),
          ...(cache.library.cueAttributes ? { cueAttributes: cache.library.cueAttributes.filter(entry => exists(entry.sequence)) } : {}),
          errors: cache.library.errors.filter(entry => exists(entry.sequence))
        }));
        useMa2AutoSyncStore.setState({ request: null, status: 'waiting', message: '控台会话已重新核对，正在续接原位置' });
        for (const song of Object.values(useMa2SongSyncStore.getState().songs)) {
          if (song.documentId !== state.documentId || song.requestId || song.state === 'paused') continue;
          useMa2SongSyncStore.setState(value => ({ songs: { ...value.songs, [song.itemId]: { ...song, nextCheckAt: 0, consecutiveFailures: 0 } } }));
        }
      }
      verifiedSource = JSON.stringify([state.documentId, cache.source, directory.show, directory.generation, directory.version]);
      nextSourceCheck = Date.now() + 5000;
    }
    if (!current()) return false;
    const project = useDocumentStore.getState().project;
    if (!project) return false;
    for (const item of project.rundown) {
      if (!item.lighting || item.lighting.ma2Bindings?.length || item.lighting.consoleSong?.assignment === 'unassigned') continue;
      const existing = useMa2SongSyncStore.getState().songs[item.id];
      if (existing && (existing.state !== 'paused' || existing.requestId)) continue;
      const events = item.lighting.tracks.flatMap(track => track.clips.flatMap(clip => clip.events));
      if (!item.lighting.consoleSong && !events.some(event => event.kind === 'ma2' || event.kind === 'empty-cue')) continue;
      startMa2SongSync(item.id, item.lighting.consoleSong?.name ?? item.title, ma2SongSyncSettings(project, item.id));
    }
    const automatic = useMa2AutoSyncStore.getState();
    const hasBindings = project.rundown.some(item => item.lighting?.ma2Bindings?.length);
    if ((!hasBindings && !pendingMa2Renames(project).length) || automatic.request) {
      // The whole check succeeded: lift a block this session raised earlier, never Ma2AutoSync's own.
      if (sessionBlocked) {
        sessionBlocked = false; blockedContext = '';
        if (automatic.status === 'blocked' && !automatic.request) useMa2AutoSyncStore.setState({ status: 'waiting', message: '控台已重新核对，继续同步' });
      }
      return true;
    }
    const catalog = await window.tbLink.readMa2Catalog({ ...connection, targets: [] });
    const source = project.ma2MaterialLibrary!.library!.directory;
    if (catalog.directory.show !== source.show || catalog.directory.generation !== source.generation || catalog.directory.version !== source.version) throw new Error('控台 Show 或会话已变化，请刷新素材后核对');
    if (!current()) return false;
    blockedContext = context; sessionBlocked = false;
    useMa2AutoSyncStore.setState({ request: { connection, catalog, scope: hasBindings ? 'bound' : 'names' } });
    return true;
  } catch (cause) {
    verifiedSource = ''; nextSourceCheck = Date.now() + 1000;
    if (current()) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const errorContext = `${context}:${message}`;
      const reported = blockedContext === errorContext;
      blockedContext = errorContext; sessionBlocked = true;
      useMa2AutoSyncStore.setState({ status: 'blocked', message });
      if (!reported) reportCoordinatorError(message, reason => { useMa2AutoSyncStore.setState({ message: reason }); });
    }
    return false;
  } finally { preparing = false; }
}

export function retryMa2RealtimeSession(): void {
  setMa2RealtimeEnabled(true);
  useMa2AutoSyncStore.setState({ request: null, status: 'waiting', message: '正在重新核对控台' });
  for (const song of Object.values(useMa2SongSyncStore.getState().songs)) {
    if (song.state !== 'blocked' && song.state !== 'paused') continue;
    if (song.requestId) continue;
    const project = useDocumentStore.getState().project;
    const item = project?.rundown.find(value => value.id === song.itemId);
    if (project && item) startMa2SongSync(item.id, item.lighting?.consoleSong?.name ?? song.name, ma2SongSyncSettings(project, item.id), song.confirmedDeletions);
  }
  void prepareMa2RealtimeSession();
}

export function pauseMa2RealtimeSession(): void {
  if (useMa2RealtimePreference.getState().enabled) setMa2RealtimeEnabled(false);
  if (useMa2AutoSyncStore.getState().request) useMa2AutoSyncStore.setState({ request: null });
  for (const song of Object.values(useMa2SongSyncStore.getState().songs)) stopMa2SongSync(song.itemId);
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
    if (useMa2SongSyncStore.getState().songs[song.itemId]?.requestId) continue;
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
