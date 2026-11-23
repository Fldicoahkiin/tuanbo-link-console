import { ma2ApplyRequestSchema, ma2ApplyResultSchema, type Ma2ApplyRequest, type Ma2ApplyResult, type Ma2TimecodePreview } from '@tb/schema';
import { MA2_BRIDGE_BUSY_BEFORE_REQUEST, holdForShow, ma2EditedCueHold, MA2_SONG_COLLISION, MA2_SONG_TIMECODE_SLOT, resolveMa2Sync, type ShowGateReader } from '@tb/core/link';
import { Ma2BridgeFailure, ma2TimecodeChangedBeforeWrite, waitForMa2Admission, type Ma2OnpcBridge } from './ma2-onpc-bridge';
import { confirmMa2MergedEvents, prepareMa2MergedEvents } from './ma2-event-write';
import { convertMa2Snapshot } from './ma2-timecode-conversion';
import { readMa2MtcRanges } from './ma2-timeline-edit';
import { extendMa2TimecodeLength, inspectMa2TimecodeXml, ma2GoSequencesInSnapshot, ma2MtcPlaybackSettings, referencedMa2Sequences, sameMa2XmlObjects } from './ma2-timecode-xml';
import { compareMa2LightingReadback } from './ma2-comparison';
import type { Ma2ShowSource } from './ma2-show-probe';
import type { Ma2ConfirmedTimecode } from './ma2-mtc-selection';

type PlaybackPreparation = {
  source: () => Promise<Ma2ShowSource>;
  verify: (source: Ma2ShowSource) => Promise<void>;
  prepare: (timecode: Ma2ConfirmedTimecode, onConsoleCheck: (mayWrite?: boolean) => void) => Promise<boolean>;
};

/** One complete read/validate/write/verify session. No automatic retries. */
export class Ma2ApplyService {
  private busy = false;
  constructor(private readonly bridge: Pick<Ma2OnpcBridge, 'request' | 'exchange'> & Partial<Pick<Ma2OnpcBridge, 'hasSnapshot'>>, private readonly show: ShowGateReader, private readonly playback?: PlaybackPreparation) {}

  private confirmedRead?: { preview: Ma2TimecodePreview; snapshot: string } | undefined;
  private editRead?: { preview: Ma2TimecodePreview; snapshot: string; sequences: string; at: number } | undefined;

  private readSnapshot(target: number, additional: readonly number[]): Promise<string> {
    return additional.length ? this.bridge.request('SCOPE', target, additional.join(',')) : this.bridge.request('SNAPSHOT', target);
  }

  /** Keep the accepted write and its backup while the separate verification read waits for admission. */
  private readConfirmation(target: number, source: Ma2ShowSource | undefined): Promise<string> {
    return waitForMa2Admission(() => this.bridge.request('SNAPSHOT', target), async () => {
      if (source) await this.playback?.verify(source);
    });
  }

  /** Read once for three-way comparison and the following native compare-and-write. */
  async previewEdit(target: number, origin: number | undefined, additional: readonly number[], readLive?: () => Promise<Ma2TimecodePreview>, verifyOnApply = false): Promise<Ma2TimecodePreview> {
    this.editRead = undefined;
    holdForShow(this.show, 'ma2.sync.read');
    const last = this.confirmedRead;
    if (!additional.length && last?.preview.target === target && (last.preview.timeOriginMs ?? 0) === (origin ?? 0) && readLive && this.bridge.hasSnapshot?.(target, last.snapshot)) {
      const fresh = await readLive();
      if (sameMa2XmlObjects(fresh.sourceXml, last.preview.sourceXml) && previewContent(fresh) === previewContent(last.preview)
        && JSON.stringify(fresh.cueCatalog) === JSON.stringify(last.preview.cueCatalog)) {
        this.editRead = { preview: fresh, snapshot: last.snapshot, sequences: '', at: Date.now() };
        return fresh;
      }
    }
    // The next apply re-exports every referenced Sequence before Import. A no-op pass
    // requests an ordinary verified snapshot before it can report success.
    const snapshot = verifyOnApply ? await this.bridge.request('SCOPE', target, 'edit:' + additional.join(',')) : await this.readSnapshot(target, additional);
    const preview = convertMa2Snapshot(snapshot, target, additional, origin);
    const included = new Set(referencedMa2Sequences(preview.sourceXml));
    this.editRead = { preview, snapshot, sequences: additional.filter(number => !included.has(number)).join(','), at: Date.now() };
    return preview;
  }

  async apply(input: Ma2ApplyRequest): Promise<Ma2ApplyResult> {
    if (this.busy) return { status: 'incomplete', stage: 'preflight', message: MA2_BRIDGE_BUSY_BEFORE_REQUEST, mayHaveWritten: false, backupFile: null };
    this.busy = true;
    this.confirmedRead = undefined;
    let stage: 'preflight' | 'read' | 'write' | 'verify' = 'preflight';
    let mayHaveWritten = false; let backupFile: string | null = null;
    try {
      const request = ma2ApplyRequestSchema.parse(input);
      this.requireStopped();
      const binding = request.document.ma2Bindings?.find((entry) => entry.id === request.bindingId);
      if (!binding || binding.timecode !== request.readback.target) throw new Error('节目与 MA2 绑定不一致');
      stage = 'read';
      // A live edit belongs to the Show that supplied its binding. Identical Timecode
      // and Sequence numbers can exist in a different Show after the preview.
      const source = request.expectedSource ?? await this.playback?.source();
      stage = 'preflight';
      const merged = resolveMa2Sync(compareMa2LightingReadback(request.document, request.bindingId, request.readback, request.consoleChanges), new Map(request.conflicts));
      const desiredSequences = new Set<number>();
      for (const event of merged.objects.filter((object) => object.kind === 'event' && object.properties.action === 'goto')) {
        const value = event.properties.sequence ?? '';
        if (!/^[1-9]\d*$/.test(value) || Number(value) > 99999) throw new Error('调用指定 Cue 必须填写有效序列');
        desiredSequences.add(Number(value));
      }
      const existing = new Set(referencedMa2Sequences(request.readback.sourceXml));
      const additional = [...desiredSequences].filter(number => !existing.has(number)).sort((a, b) => a - b);
      stage = 'read';
      const saved = this.editRead;
      this.editRead = undefined;
      const cached = saved && Date.now() - saved.at < 10000 && saved.sequences === additional.join(',') && saved.preview.target === binding.timecode
        && saved.preview.timeOriginMs === request.readback.timeOriginMs && saved.preview.readAt === request.readback.readAt && saved.preview.sourceXml === request.readback.sourceXml ? saved : undefined;
      let snapshot = cached?.snapshot ?? await this.readSnapshot(binding.timecode, additional);
      const current = cached?.preview ?? convertMa2Snapshot(snapshot, binding.timecode, additional, binding.timeOriginMs);
      if (!sameMa2XmlObjects(request.readback.sourceXml, current.sourceXml) || previewContent(request.readback) !== previewContent(current)) throw new Error(`${MA2_SONG_COLLISION}：预览之后控台的 Timecode ${binding.timecode} 或它用的序列变了，这次没有写入；重新读取控台后再同步`);
      stage = 'preflight';
      const prepared = prepareMa2MergedEvents(request.document, request.bindingId, request.readback, new Map(request.conflicts), [snapshot], request.timeAlignment ?? 'exact', request.consoleChanges);
      const usesSongClock = this.playback && inspectMa2TimecodeXml(current.sourceXml).timecodes[0]?.attributes.slot === MA2_SONG_TIMECODE_SLOT;
      if (usesSongClock) {
        if (prepared.editedEndCueTick !== undefined && request.songEndTick !== undefined && source) {
          const ranges = await readMa2MtcRanges(this.bridge);
          if (ranges.show !== source.show || ranges.generation !== source.generation) throw new Error('控台或 Show 已改变，请重新核对当前节目');
          const offset = Number(inspectMa2TimecodeXml(current.sourceXml).timecodes[0]?.attributes.offset ?? 0);
          const hold = ma2EditedCueHold(ranges.entries, binding.timecode, offset, prepared.editedEndCueTick, request.songEndTick, ranges.afterRollSeconds);
          prepared.desiredXml = extendMa2TimecodeLength(prepared.desiredXml, binding.timecode, hold);
        }
        prepared.desiredXml = ma2MtcPlaybackSettings(prepared.desiredXml, false);
      }
      this.requireStopped();
      let verified = current;
      if (!sameMa2XmlObjects(prepared.desiredXml, current.sourceXml)) {
        if (source) await this.playback?.verify(source);
        this.requireStopped();
        stage = 'write'; mayHaveWritten = true;
        const receipt = await this.bridge.exchange('SYNC', binding.timecode, snapshot, prepared.desiredXml);
        backupFile = `tblink_backup_${receipt.requestId}.xml`;
        stage = 'verify';
        snapshot = receipt.snapshot ?? await this.readConfirmation(binding.timecode, source);
        verified = convertMa2Snapshot(snapshot, binding.timecode, [], binding.timeOriginMs);
      } else if (cached) {
        // SYNC normally checks the native snapshot immediately before Import. A read-only merge
        // has no such operation, so only a new console read can confirm it.
        snapshot = await this.bridge.request('SNAPSHOT', binding.timecode);
        verified = convertMa2Snapshot(snapshot, binding.timecode, [], binding.timeOriginMs);
        if (previewContent(current) !== previewContent(verified) || !sameMa2XmlObjects(current.sourceXml, verified.sourceXml)) throw new Error(`${MA2_SONG_COLLISION}：控台在核对期间有变化，请重新同步`);
      }
      stage = 'verify';
      if (source && this.playback) await this.playback.verify(source);
      // Moving a previously managed song out of the MIDI slot still changes the selector.
      const leftSongClock = this.playback && !usesSongClock && binding.sourceXml !== current.sourceXml
        && inspectMa2TimecodeXml(binding.sourceXml).timecodes[0]?.attributes.slot === MA2_SONG_TIMECODE_SLOT;
      if (source && this.playback && (usesSongClock || leftSongClock)) {
        let checkedConsole = false;
        const wroteTimecode = mayHaveWritten;
        const changed = await this.playback.prepare({ ...source, number: binding.timecode, xml: verified.sourceXml, previousXml: binding.sourceXml, goSequences: ma2GoSequencesInSnapshot(snapshot) }, (mayWrite = true) => {
          checkedConsole = true;
          if (mayWrite) mayHaveWritten = true;
        });
        mayHaveWritten = wroteTimecode || changed;
        if (checkedConsole || changed) {
          snapshot = await this.readConfirmation(binding.timecode, source);
          verified = convertMa2Snapshot(snapshot, binding.timecode, [], binding.timeOriginMs);
          await this.playback.verify(source);
          const go = new Set(ma2GoSequencesInSnapshot(snapshot));
          if (referencedMa2Sequences(verified.sourceXml).some(number => !go.has(number))) throw new Error(`${MA2_SONG_COLLISION}：检查选曲期间序列的触发方式变了，请重新核对`);
        }
      }
      const confirmed = confirmMa2MergedEvents(prepared, verified.sourceXml, [snapshot]);
      if (this.bridge.hasSnapshot?.(binding.timecode, snapshot)) this.confirmedRead = { preview: verified, snapshot };
      return ma2ApplyResultSchema.parse({ status: 'verified', confirmed, backupFile });
    } catch (error) {
      if (stage === 'write' && error instanceof Ma2BridgeFailure) {
        mayHaveWritten = error.sent;
        backupFile = error.backupFile;
        if (error.writeAcknowledged) stage = 'verify';
      }
      const message = error instanceof Error ? error.message : String(error);
      // The native bridge explicitly rejected the compare, before Import. Its lane may already
      // have accepted the request, so transport-level 'sent' alone cannot classify these cases.
      if (stage === 'write' && ma2TimecodeChangedBeforeWrite(error)) {
        return { status: 'incomplete', stage: 'preflight', message: `${MA2_SONG_COLLISION}：写入前控台已有改动，正在重新核对`, mayHaveWritten: false, backupFile };
      }
      return { status: 'incomplete', stage, message, mayHaveWritten, backupFile };
    } finally { this.busy = false; }
  }

  /** A paused or held show syncs; a moving program waits (2026-11-10 第 3 题). */
  private requireStopped(): void { holdForShow(this.show, 'ma2.sync.write'); }
}

/** Console-only actions are part of the content: they stay as they are and are compared by path. */
function previewContent(preview: Ma2TimecodePreview): string {
  const mappings = new Map(preview.mappings.map((mapping) => [mapping.eventId, mapping]));
  const events = preview.document.tracks.flatMap((track) => track.clips.flatMap((clip) => clip.events.map((event) => {
    const mapping = mappings.get(event.id);
    if (!mapping || clip.timeLock !== 'time' || (event.kind !== 'ma2' && event.kind !== 'ma2-fader')) throw new Error('MA2 预览身份或时间基准无效');
    return { path: mapping.path, track: track.name, muted: track.muted, event: { ...event, id: undefined, at: clip.start + event.at } };
  })));
  if (events.length !== preview.mappings.length) throw new Error('MA2 预览映射不完整');
  events.sort((a, b) => a.path.localeCompare(b.path));
  return JSON.stringify({ name: preview.name, trackCount: preview.document.tracks.length, events, consoleOnly: preview.unconverted.map((entry) => entry.path).sort() });
}
