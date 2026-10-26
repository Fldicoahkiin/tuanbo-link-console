import { ma2ApplyRequestSchema, ma2ApplyResultSchema, type Ma2ApplyRequest, type Ma2ApplyResult, type Ma2TimecodePreview } from '@tb/schema';
import { resolveMa2Sync } from '@tb/core/link';
import { Ma2BridgeFailure, type Ma2OnpcBridge } from './ma2-onpc-bridge';
import { confirmMa2MergedEvents, prepareMa2MergedEvents } from './ma2-event-write';
import { convertMa2Snapshot } from './ma2-timecode-conversion';
import { referencedMa2Sequences, sameMa2XmlObjects } from './ma2-timecode-xml';
import { compareMa2LightingReadback } from './ma2-comparison';

/** One complete read/validate/write/verify session. No automatic retries. */
export class Ma2ApplyService {
  private busy = false;
  constructor(private readonly bridge: Pick<Ma2OnpcBridge, 'request' | 'exchange'>, private readonly isPlaying: () => boolean) {}

  async apply(input: Ma2ApplyRequest): Promise<Ma2ApplyResult> {
    if (this.busy) return { status: 'incomplete', stage: 'preflight', message: '已有 MA2 同步正在进行', mayHaveWritten: false, backupFile: null };
    this.busy = true;
    let stage: 'preflight' | 'read' | 'write' | 'verify' = 'preflight';
    let mayHaveWritten = false; let backupFile: string | null = null;
    try {
      const request = ma2ApplyRequestSchema.parse(input);
      this.requireStopped();
      const binding = request.document.ma2Bindings?.find((entry) => entry.id === request.bindingId);
      if (!binding || binding.timecode !== request.readback.target) throw new Error('节目与 MA2 绑定不一致');
      stage = 'read';
      let snapshot = await this.bridge.request('SNAPSHOT', binding.timecode);
      const current = convertMa2Snapshot(snapshot, binding.timecode, [], binding.timeOriginMs);
      if (!sameMa2XmlObjects(request.readback.sourceXml, current.sourceXml) || previewContent(request.readback) !== previewContent(current)) throw new Error('控台 Timecode 或序列在预览后已改变，请重新读取比较');
      stage = 'preflight';
      const merged = resolveMa2Sync(compareMa2LightingReadback(request.document, request.bindingId, request.readback, new Map(request.choices)), new Map(request.conflicts));
      const desiredSequences = new Set<number>();
      for (const event of merged.objects.filter((object) => object.kind === 'event' && object.properties.action === 'goto')) {
        const value = event.properties.sequence ?? '';
        if (!/^[1-9]\d*$/.test(value) || Number(value) > 99999) throw new Error('调用指定 Cue 必须填写有效序列');
        desiredSequences.add(Number(value));
      }
      const existing = new Set(referencedMa2Sequences(snapshot));
      const additional = [...desiredSequences].filter((number) => !existing.has(number)).sort((a, b) => a - b);
      if (additional.length) {
        stage = 'read';
        snapshot = await this.bridge.request('SCOPE', binding.timecode, additional.join(','));
        const scoped = convertMa2Snapshot(snapshot, binding.timecode, additional, binding.timeOriginMs);
        if (!sameMa2XmlObjects(current.sourceXml, scoped.sourceXml) || previewContent(current) !== previewContent(scoped)) throw new Error('控台在读取新增 Cue 序列期间已改变，请重新读取比较');
        stage = 'preflight';
      }
      const prepared = prepareMa2MergedEvents(request.document, request.bindingId, request.readback, new Map(request.choices), new Map(request.conflicts), [snapshot], request.timeAlignment ?? 'exact');
      this.requireStopped();
      if (sameMa2XmlObjects(prepared.desiredXml, current.sourceXml)) return ma2ApplyResultSchema.parse({ status: 'verified', confirmed: confirmMa2MergedEvents(prepared, current.sourceXml, [snapshot]), backupFile: null });
      stage = 'write'; mayHaveWritten = true;
      const receipt = await this.bridge.exchange('SYNC', binding.timecode, snapshot, prepared.desiredXml);
      backupFile = `tblink_backup_${receipt.requestId}.xml`;
      stage = 'verify';
      const after = await this.bridge.request('SNAPSHOT', binding.timecode);
      const verified = convertMa2Snapshot(after, binding.timecode, [], binding.timeOriginMs);
      const confirmed = confirmMa2MergedEvents(prepared, verified.sourceXml, [after]);
      return ma2ApplyResultSchema.parse({ status: 'verified', confirmed, backupFile });
    } catch (error) {
      if (stage === 'write' && error instanceof Ma2BridgeFailure) { mayHaveWritten = error.sent; backupFile = error.backupFile; }
      return { status: 'incomplete', stage, message: error instanceof Error ? error.message : String(error), mayHaveWritten, backupFile };
    } finally { this.busy = false; }
  }

  private requireStopped(): void { if (this.isPlaying()) throw new Error('播放期间不能同步 MA2 工程'); }
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
