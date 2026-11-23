import { useMa2ReadStore } from '../stores/ma2-read-store';
import { useMa2MaterialReadStore } from '../stores/ma2-material-read-store';
import { SaxesParser } from 'saxes';
import { MA2_SONG_FOREIGN_SEQUENCE, MA2_SONG_NATIVE_ACTION, MA2_SONG_TIMECODE_SLOT, readSongMtcStart, songDurationMs } from '@tb/core/link';
import { ma2CatalogSchema, type LightingDocument, type RundownItem, type Ma2Catalog, type Ma2CatalogRequest, type Ma2NetworkTarget, type Ma2ReadRequest, type Ma2TimecodePreview } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { updateMa2Song, type SongSync } from '../stores/ma2-sync-store';
import { songDestination } from './ma2-edit-times';
import { reportCoordinatorError } from './runtime-action-log';

type SongClock = Pick<Ma2CatalogRequest, 'otherClockBindings' | 'songPlayback'>;

/** The confirmed binding survives a directory refresh. Read just the native header,
 * including on older projects without a separate slot field. */
export function songClockBindings(item?: RundownItem): SongClock {
  const lighting = item?.lighting;
  const slots = new Map<number, string>();
  for (const binding of lighting?.ma2Bindings ?? []) {
    const parser = new SaxesParser({ xmlns: true });
    let found = false;
    parser.on('opentag', tag => {
      if (tag.local === 'Timecode' && Number(tag.attributes.index?.value ?? 0) === binding.timecode - 1) {
        found = true;
        slots.set(binding.timecode, tag.attributes.slot?.value ?? '');
      }
    });
    for (let offset = 0; !found && offset < binding.sourceXml.length; offset += 512) {
      parser.write(binding.sourceXml.slice(offset, offset + 512));
    }
  }
  const owned = lighting?.consoleSong?.timecode;
  if (owned) slots.set(owned.number, owned.slot);
  const otherClockBindings = Array.from(slots, ([target, slot]) => ({ target, slot })).filter(binding => binding.slot !== MA2_SONG_TIMECODE_SLOT);
  const start = item && readSongMtcStart(item);
  return { ...(otherClockBindings.length ? { otherClockBindings } : {}),
    ...(item?.referenceAudio && start?.state === 'set' ? { songPlayback: { startMs: start.startMs, durationMs: songDurationMs(item.referenceAudio) } } : {}) };
}

export async function readSongClockCatalog(network: Ma2NetworkTarget, targets: number[], clock: SongClock, expectedSource?: Ma2CatalogRequest['expectedSource']): Promise<Ma2Catalog> {
  return ma2CatalogSchema.parse(await window.tbLink.readMa2Catalog({ dataDirectory: '', network, targets: [], checkMtcFor: targets, ...clock, expectedSource }));
}

/** Only repair a shared selector after this manual read finds a problem. Confirm the actual result in the same Show. */
export async function confirmSongSelection(times: Ma2Catalog, network: Ma2NetworkTarget, targets: number[], clock: SongClock, current: () => boolean, onPrepare?: () => void): Promise<Ma2Catalog> {
  if (times.playbackConflict || !times.needsPlaybackPreparation) return times;
  const { show, generation, version } = times.directory;
  const expectedSource = { show, generation, version };
  if (!current()) return times;
  onPrepare?.();
  await window.tbLink.prepareMa2Playback({ network, progressId: crypto.randomUUID(), expectedSource, ...(times.songSettingsTargets ? { songSettingsTargets: times.songSettingsTargets } : {}), ...(times.songTriggerTargets ? { songTriggerTargets: times.songTriggerTargets } : {}), ...(times.selectorTriggerTarget ? { selectorTriggerTarget: times.selectorTriggerTarget } : {}), ...(times.selectorCommandTarget ? { selectorCommandTarget: times.selectorCommandTarget } : {}), ...(times.selectorSettingsTarget ? { selectorSettingsTarget: times.selectorSettingsTarget } : {}) });
  if (!current()) return times;
  const checked = await readSongClockCatalog(network, targets, clock, expectedSource);
  if (!current()) return checked;
  if (checked.directory.show !== show || checked.directory.generation !== generation || checked.directory.version !== version
    || times.songOffsets?.some(value => !checked.songOffsets?.some(entry => entry.target === value.target && entry.offset === value.offset))
    || checked.sourceUnverified || checked.incomplete || targets.some(target => !checked.directory.entries.some(entry => entry.target === target))) {
    throw new Error('控台的节目目录刚有变化，请重新核对当前节目');
  }
  if (checked.needsPlaybackPreparation && !checked.playbackConflict) checked.playbackConflict = '控台没有确认按时间码选歌的设置，请检查控台时间线后再同步';
  return checked;
}

/** A foreground read or playback preparation owns the console until it releases its read job. */
export function ma2ConsoleReading(): boolean {
  return useMa2ReadStore.getState().busy || useMa2MaterialReadStore.getState().busy;
}

export class Ma2TimecodeSourceError extends Error {
  constructor(readonly target: number, message: string, options?: ErrorOptions) { super(message, options); }
}

/** Both the initial preview and Apply's pre-write snapshot can lose the requested Timecode. */
export function throwMa2ReadFailure(target: number, cause: unknown): never {
  if (cause instanceof Error && /(?:^|[:：]\s*)Timecode does not exist\s*$/i.test(cause.message)) throw new Ma2TimecodeSourceError(target, `控台上找不到 Timecode ${target}。工程里的灯光已保留，请核对 onPC 打开的 Show，再点同步。`, { cause });
  throw cause;
}

async function readSongSnapshot(request: Ma2ReadRequest): Promise<Ma2TimecodePreview> {
  try { return await window.tbLink.previewMa2(request); }
  catch (cause) { throwMa2ReadFailure(request.target, cause); }
}

/** A passive comparison yields its remaining reads as soon as this song changes. */
export async function readMa2SongPreview(entry: SongSync, request: Ma2ReadRequest): Promise<Ma2TimecodePreview> {
  if (entry.state !== 'verified' || request.syncSequences) return readSongSnapshot(request);
  const progressId = crypto.randomUUID();
  const currentLighting = () => {
    const state = useDocumentStore.getState();
    return state.documentId === entry.documentId ? state.project?.rundown.find(item => item.id === entry.itemId)?.lighting : undefined;
  };
  const before = currentLighting();
  const unsubscribe = useDocumentStore.subscribe(() => {
    if (currentLighting() === before) return;
    unsubscribe();
    void window.tbLink.cancelMa2Read(progressId).catch((cause: unknown) => {
      reportCoordinatorError(`中止旧时间线检查时控台没有确认：${String(cause)}`, message => updateMa2Song(entry, { message }));
    });
  });
  try { return await readSongSnapshot({ ...request, progressId }); }
  finally { unsubscribe(); }
}

export function settleTimecodeSourceError(entry: SongSync, cause: unknown, current: boolean, requested: LightingDocument | undefined): boolean {
  if (!(cause instanceof Error)) return false;
  const nativeAction = cause.message.indexOf(MA2_SONG_NATIVE_ACTION);
  const sourceError = Math.max(nativeAction, cause.message.indexOf(MA2_SONG_FOREIGN_SEQUENCE));
  if (!(cause instanceof Ma2TimecodeSourceError) && sourceError < 0) return false;
  const item = useDocumentStore.getState().project?.rundown.find(song => song.id === entry.itemId);
  const matches = cause instanceof Ma2TimecodeSourceError ? item?.lighting?.ma2Bindings?.some(binding => binding.timecode === cause.target)
    : requested?.consoleSong && songDestination(requested) === songDestination(item?.lighting);
  if (!current || !item || !matches) {
    updateMa2Song(entry, { state: 'pending', checking: false, writing: false, nextCheckAt: 0, message: '等待核对当前选择的时间线' });
    return true;
  }
  const message = sourceError < 0 ? cause.message : cause.message.slice(sourceError);
  updateMa2Song(entry, { state: 'blocked', requestId: null, progress: null, failedItem: item, needsSourceCheck: true, needsConflictChoice: false, checking: false, writing: false,
    consoleChangesOnce: undefined, conflictChoice: undefined, message });
  reportCoordinatorError(`「${item.title}」${message}`, message => updateMa2Song(entry, { message }));
  return true;
}
