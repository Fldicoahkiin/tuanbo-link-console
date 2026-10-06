import { ma2CatalogSchema, ma2ObjectDirectorySchema, type Ma2Catalog, type Ma2CatalogRequest, type Ma2ReadProgressUpdate } from '@tb/schema';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { inspectMa2SequenceXml, inspectMa2TimecodeXml, resolveMa2CueReference, type Ma2SequenceReport } from './ma2-timecode-xml';
import { referencedMa2Sequences } from './ma2-timecode-xml';
import { convertMa2TimecodeReferences } from './ma2-timecode-conversion';

/** Read-only inventory. Failed objects remain visible; no writes or retry. */
export async function readMa2Catalog(bridge: Pick<Ma2OnpcBridge, 'request'>, isPlaying: () => boolean, cueDirectory?: Ma2SequenceReport, onProgress?: (progress: Ma2ReadProgressUpdate) => void, signal?: AbortSignal, options?: { targets?: readonly number[] | undefined; expectedSource?: Ma2CatalogRequest['expectedSource']; metadata?: (targets: readonly number[]) => Promise<Ma2SequenceReport>; metrics?: NonNullable<Ma2Catalog['metrics']>; checkpoint?: ((catalog: Ma2Catalog, entry?: Ma2Catalog['entries'][number]) => Promise<void>) | undefined }): Promise<Ma2Catalog> {
  const started = performance.now();
  const metrics = options?.metrics ?? { elapsedMs: 0, requests: 0, bytes: 0, phases: {} };
  const request: Ma2OnpcBridge['request'] = async (...args) => {
    const start = performance.now(); metrics.requests += 1;
    try { const result = await bridge.request(...args); metrics.bytes += Buffer.byteLength(result, 'utf8'); return result; }
    finally { metrics.phases[args[0]] = (metrics.phases[args[0]] ?? 0) + performance.now() - start; }
  };
  if (signal?.aborted) throw new Error('扫描已取消');
  const directory = ma2ObjectDirectorySchema.parse(JSON.parse(await request('LIST', 1)));
  if (options?.expectedSource && Object.entries(options.expectedSource).some(([key, value]) => Reflect.get(directory, key) !== value)) throw new Error('Show 或控台会话已改变，保留旧缓存，请读取新目录');
  const readAt = new Date().toISOString();
  const checkpointCatalog = (): Ma2Catalog => ({ directory, readAt, entries: [], sourceUnverified: false, incomplete: '读取尚未完成' });
  await options?.checkpoint?.(checkpointCatalog());
  if (signal?.aborted) throw new Error('扫描已取消');
  const objects = directory.entries.filter(entry => !options?.targets || options.targets.includes(entry.target));
  onProgress?.({ phase: 'timecodes', completed: 0, total: objects.length + 1, detail: '读取控台时间线' });
  const entries: Ma2Catalog['entries'] = [];
  let totalEvents = 0;
  let incomplete: string | undefined;
  let sourceUnverified = false;
  for (const object of objects) {
    if (signal?.aborted || isPlaying()) { incomplete = '读取已停止，保留已读取对象，可继续处理未完成项'; break; }
    const entry: Ma2Catalog['entries'][number] = { ...object, eventCount: null, frameFormat: null, offset: null, slot: null, events: [], error: null, warnings: [] };
    try {
      const xml = await request('READ', object.target);
      entry.sourceXml = xml; entry.readAt = new Date().toISOString();
      const report = inspectMa2TimecodeXml(xml);
      const tc = report.timecodes[0];
      if (!tc || tc.index !== object.target - 1 || report.timecodes.length !== 1) throw new Error('读取对象与目录不一致');
      entry.name = tc.attributes.name ?? object.name;
      entry.frameFormat = tc.attributes.frame_format ?? null;
      entry.offset = tc.attributes.offset ?? '0'; entry.slot = tc.attributes.slot ?? null;
      entry.warnings = report.warnings;
      entry.eventCount = tc.tracks.reduce((sum, track) => sum + track.subtracks.reduce((count, subtrack) => count + subtrack.events.length, 0), 0);
      totalEvents += entry.eventCount;
      if (totalEvents > 100000) throw new Error('扫描事件超过十万，请缩小现场 Show 后重新扫描');
      for (const track of tc.tracks) for (const subtrack of track.subtracks) for (const event of subtrack.events) {
        const address = track.executorAddress;
        entry.events.push({ path: event.path, time: event.attributes.time ?? '0', action: event.attributes.command ?? subtrack.attributes.fader_command ?? '未知动作', executor: address.length === 4 ? `${address[2]}.${address[3]}` : address.join('/'), cue: null, name: event.cueName });
      }
      let sequences: Ma2SequenceReport = cueDirectory ?? { version: report.version, sequences: [] };
      if (tc.tracks.some(track => track.subtracks.some(subtrack => subtrack.events.some(event => event.cueAddress.length)))) {
        if (options?.metadata) sequences = await options.metadata(referencedMa2Sequences(xml));
        const snapshot = await request(cueDirectory || options?.metadata ? 'READ' : 'SNAPSHOT', object.target);
        if (signal?.aborted) throw new Error('扫描已取消');
        const current = inspectMa2TimecodeXml(snapshot);
        if (JSON.stringify(current.timecodes) !== JSON.stringify(report.timecodes)) throw new Error('扫描期间时间线发生变化，请重新扫描');
        if (!cueDirectory && !options?.metadata) sequences = inspectMa2SequenceXml(snapshot);
        const byPath = new Map(entry.events.map(event => [event.path, event]));
        for (const track of tc.tracks) for (const subtrack of track.subtracks) for (const event of subtrack.events) {
          if (!event.cueAddress.length) continue;
          const row = byPath.get(event.path);
          if (!row) throw new Error('扫描事件身份缺失');
          try { const cue = resolveMa2CueReference(event.cueAddress, [sequences]); row.cue = `${cue.sequence} / ${cue.cueNumber}`; row.name = cue.cueName; }
          catch (error) { entry.warnings.push(`${event.path}：${error instanceof Error ? error.message : String(error)}`); }
        }
      }
      try { entry.preview = convertMa2TimecodeReferences(xml, [sequences], object.target); }
      catch (error) { entry.conversionError = error instanceof Error ? error.message : String(error); }
    } catch (error) { entry.error = error instanceof Error ? error.message : String(error); }
    entries.push(entry);
    await options?.checkpoint?.(checkpointCatalog(), entry);
    onProgress?.({ phase: 'timecodes', completed: entries.length, total: objects.length + 1, detail: `已读取 Timecode ${object.target}`, ...(options?.checkpoint ? { checkpoint: { directory, readAt, entry } } : {}) });
    if (totalEvents > 100000) { incomplete = '扫描事件超过十万，已保留完成条目与原始 XML，请缩小读取范围'; break; }
  }
  if (!incomplete && !signal?.aborted && !isPlaying()) {
    onProgress?.({ phase: 'timecodes', completed: entries.length, total: objects.length + 1, detail: '核对控台时间线目录' });
    try {
      const verified = ma2ObjectDirectorySchema.parse(JSON.parse(await request('LIST', 1)));
      if (JSON.stringify(directory) !== JSON.stringify(verified)) { sourceUnverified = true; incomplete = '控台 Show、插件或目录已变化；以下为读取时缓存，需重新核对来源'; }
    } catch (error) { sourceUnverified = true; incomplete = `目录复核未完成：${error instanceof Error ? error.message : String(error)}`; }
  } else incomplete ??= '读取已取消，保留已读取对象';
  metrics.elapsedMs = performance.now() - started;
  const result = ma2CatalogSchema.parse({ directory, readAt, entries, metrics, incomplete, sourceUnverified });
  await options?.checkpoint?.(result);
  onProgress?.({ phase: 'timecodes', completed: incomplete ? entries.length : objects.length + 1, total: objects.length + 1, detail: incomplete ? '已保留部分读取结果' : '时间线目录已核对' });
  return result;
}
