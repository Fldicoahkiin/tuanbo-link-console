import { importMa2TimecodeCommand, ma2BindingHold, ma2ShowStartTicks, ma2TimecodeStartMismatch, programTimeOrigin, refreshMa2BindingCommand, type LinkCommand } from '@tb/core/link';
import { ma2EffectLibrarySchema, ma2TimecodePreviewSchema, type LightingDocument, type Ma2ObjectDirectory, type Ma2NetworkStatus, type Ma2TimecodePreview } from '@tb/schema';
import { updateMa2Song, useMa2SyncStore, type SongSync } from '../stores/ma2-sync-store';
import { confirmMa2Edit } from './ma2-edit-times';
import { useDocumentStore } from '../stores/document-store';
import { currentShowWait } from '../stores/show-state-store';
import { readSongClockCatalog, songClockBindings, throwMa2ReadFailure } from './ma2-console-reading';

/**
 * One console Timecode show read right now (2026-11-11), the same read each sync pass makes. Null when
 * the console is not connected over the network; the caller says it uses the last read instead. A moving
 * program is never interrupted by a read: it throws showGate's text, which says to pause or stop first.
 */
export async function readMa2ShowNow(target: number, timeOriginMs: number | undefined, connection?: Ma2NetworkStatus): Promise<Ma2TimecodePreview | null> {
  const status = connection ?? await window.tbLink.getMa2NetworkStatus();
  if (status.state !== 'connected' || !status.settings) return null;
  const wait = currentShowWait('ma2.sync.read');
  if (wait) throw new Error(wait);
  const { host, port, monitorPort, username } = status.settings;
  try { return ma2TimecodePreviewSchema.parse(await window.tbLink.previewMa2({ dataDirectory: '', network: { host, port, monitorPort, username }, target, timeOriginMs })); }
  catch (cause) { throwMa2ReadFailure(target, cause); }
}

/** Apply the read to the exact song whose unsynced edits were archived. */
export async function adoptMa2ConsoleVersion(entry: SongSync, lighting: LightingDocument | undefined) {
  const { itemId } = entry;
  const currentDocument = () => {
    const state = useDocumentStore.getState();
    if (state.documentId !== entry.documentId || useMa2SyncStore.getState().songs[itemId]?.sessionId !== entry.sessionId) throw new Error('工程或同步任务已经换了，没有改动歌曲');
    if (state.project?.rundown.find(item => item.id === itemId)?.lighting !== lighting) throw new Error('当前节目刚有新的灯光修改，已保留最新改动。请重新核对当前节目');
    return state;
  };
  currentDocument();
  try {
    const read = await readMa2SongFromConsole(itemId);
    const after = currentDocument();
    confirmMa2Edit(() => after.executeForDocument(entry.documentId, read.command));
    return { timecodes: read.timecodes, checkedConnection: read.checkedConnection, playbackClockNote: read.playbackClockNote };
  } catch (cause) {
    const state = useDocumentStore.getState();
    if (state.documentId === entry.documentId) {
      updateMa2Song(entry, { state: 'blocked', needsSourceCheck: true, needsConflictChoice: false, failedItem: state.project?.rundown.find(item => item.id === itemId),
        checking: false, writing: false, message: cause instanceof Error ? cause.message : String(cause) });
    }
    throw cause;
  }
}

/**
 * 用控台上的 for a way-1 song (2026-11-11): every Timecode show the song uses is read from the console
 * now and becomes the song's Cues, in one undoable step; the song's unsynced lighting edits go to the
 * archive. Throws when the console is not connected: the last read is not "the console's version".
 */
export async function readMa2SongFromConsole(itemId: string): Promise<{ command: LinkCommand; timecodes: number[]; checkedConnection: number | undefined; playbackClockNote: string | undefined }> {
  const project = useDocumentStore.getState().project;
  const item = project?.rundown.find(value => value.id === itemId);
  if (!project || !item) throw new Error('当前节目已变化，请重新核对当前节目');
  const owned = item.lighting?.consoleSong;
  const bindings = owned?.timecode ? [{ timecode: owned.timecode.number, timeOriginMs: programTimeOrigin(item) }] : item?.lighting?.ma2Bindings ?? [];
  if (!bindings.length) throw new Error('这首歌已经不用控台上的时间线');
  const reads: Ma2TimecodePreview[] = [];
  const connection = await window.tbLink.getMa2NetworkStatus();
  if (connection.state !== 'connected' || !connection.settings) throw new Error('控台没连上，读不到控台上现在的版本；连上后再点“用控台上的”');
  const { host, port, monitorPort, username } = connection.settings;
  const savedEndpoint = owned?.endpoint ?? project?.ma2MaterialLibrary?.source ?? project?.ma2ReadState?.source;
  if (savedEndpoint && savedEndpoint !== `${host}:${port}`) throw new Error('控台地址已变化，请重新核对当前节目');
  let expected = project?.ma2MaterialLibrary?.library?.directory ?? project?.ma2ReadState?.catalog.directory;
  const network = { host, port, monitorPort, username };
  if (connection.awaitingRead) await window.tbLink.startMa2Reading(network);
  const checkSource = (source: Ma2ObjectDirectory, unverified?: boolean): void => {
    if (unverified || !source.generation || (owned && source.show !== owned.show) || (expected && (source.show !== expected.show || source.version !== expected.version || source.generation !== expected.generation))) {
      throw new Error(`控台当前是“${source.show}”，Show 或连接已变化，已保留原编排。请重新核对当前节目`);
    }
    expected = source;
  };
  const readSource = async () => {
    const live = ma2EffectLibrarySchema.parse(await window.tbLink.readMa2EffectLibrary({ dataDirectory: '', network, details: 'source', targets: [] }));
    checkSource(live.directory, live.sourceUnverified);
    return live.directory;
  };
  const targets = bindings.map(binding => binding.timecode);
  const clock = songClockBindings(item);
  const { show, generation, version } = await readSource();
  const times = await readSongClockCatalog(network, targets, clock, { show, generation, version });
  checkSource(times.directory, times.sourceUnverified);
  if (times.playbackConflict) throw new Error(times.playbackConflict);
  if (times.incomplete || targets.some(target => !times.directory.entries.some(entry => entry.target === target))) throw new Error('控台的时间线目录刚有变化，已保留原编排。请重新核对当前节目');
  const latest = useDocumentStore.getState().project;
  if (!latest) throw new Error('工程已切换，读回已取消');
  for (const entry of times.songOffsets ?? []) {
    const hold = ma2BindingHold(latest, itemId, entry.target, entry.offset);
    if (hold) throw new Error(hold);
  }
  const playbackClockNote = [times.playbackClockNote, times.needsPlaybackPreparation ? '控台的选曲设置待更新，请点“同步当前节目”。' : ''].filter(Boolean).join(' ') || undefined;
  for (const binding of bindings) {
    const read = await readMa2ShowNow(binding.timecode, binding.timeOriginMs, connection);
    if (!read) throw new Error('控台没连上，读不到控台上现在的版本；连上后再点“用控台上的”');
    if (read.target !== binding.timecode) throw new Error(`控台读回的时间线与 Timecode ${binding.timecode} 不一致，请重新核对当前节目`);
    if (owned) {
      const ticks = ma2ShowStartTicks({ offset: read.timing?.offsetNative ?? null });
      if (ticks === null) throw new Error('控台时间线的起点未能确认，请重新核对当前节目');
      const mismatch = ma2TimecodeStartMismatch(item.title, binding.timecode, programTimeOrigin(item), ticks, project.timebase.frameRate);
      if (mismatch) throw new Error(mismatch);
    }
    reads.push(read);
  }
  await readSource();
  const current = await window.tbLink.getMa2NetworkStatus();
  if (current.state !== 'connected' || current.connection !== connection.connection) throw new Error('读取期间控台连接已变化，请重新核对当前节目');
  const steps = reads.map(read => owned ? importMa2TimecodeCommand(itemId, read, undefined, 'use-console') : refreshMa2BindingCommand(itemId, read.target, true, read));
  return { timecodes: reads.map(read => read.target), checkedConnection: connection.connection, playbackClockNote, command: { id: crypto.randomUUID(), label: '用控台上的灯光', execute: project => steps.reduce((value, step) => step.execute(value), project), undo: before => before } };
}
