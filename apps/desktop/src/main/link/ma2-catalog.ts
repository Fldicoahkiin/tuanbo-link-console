import { ma2CatalogSchema, ma2ObjectDirectorySchema, type Ma2Catalog } from '@tb/schema';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { inspectMa2SequenceXml, inspectMa2TimecodeXml, resolveMa2CueReference } from './ma2-timecode-xml';

/** Read-only inventory. Failed objects remain visible; no writes or retry. */
export async function readMa2Catalog(bridge: Pick<Ma2OnpcBridge, 'request'>, isPlaying: () => boolean): Promise<Ma2Catalog> {
  const directory = ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request('LIST', 1)));
  const entries: Ma2Catalog['entries'] = [];
  let totalEvents = 0;
  for (const object of directory.entries) {
    if (isPlaying()) throw new Error('播放已开始，控台扫描已停止');
    const entry: Ma2Catalog['entries'][number] = { ...object, eventCount: null, frameFormat: null, offset: null, slot: null, events: [], error: null, warnings: [] };
    try {
      const xml = await bridge.request('READ', object.target);
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
      if (tc.tracks.some(track => track.subtracks.some(subtrack => subtrack.events.some(event => event.cueAddress.length)))) {
        const snapshot = await bridge.request('SNAPSHOT', object.target);
        const current = inspectMa2TimecodeXml(snapshot);
        if (JSON.stringify(current.timecodes) !== JSON.stringify(report.timecodes)) throw new Error('扫描期间时间线发生变化，请重新扫描');
        const sequences = inspectMa2SequenceXml(snapshot);
        const byPath = new Map(entry.events.map(event => [event.path, event]));
        for (const track of tc.tracks) for (const subtrack of track.subtracks) for (const event of subtrack.events) {
          if (!event.cueAddress.length) continue;
          const cue = resolveMa2CueReference(event.cueAddress, [sequences]);
          const row = byPath.get(event.path);
          if (!row) throw new Error('扫描事件身份缺失');
          row.cue = `${cue.sequence} / ${cue.cueNumber}`; row.name = cue.cueName;
        }
      }
    } catch (error) { entry.error = error instanceof Error ? error.message : String(error); }
    entries.push(entry);
    if (totalEvents > 100000) throw new Error('扫描事件超过十万，结果未提交');
  }
  if (isPlaying()) throw new Error('播放已开始，控台扫描已停止');
  const verified = ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request('LIST', 1)));
  if (JSON.stringify(directory) !== JSON.stringify(verified)) throw new Error('控台 Show、插件或时间线目录已变化，请重新扫描');
  return ma2CatalogSchema.parse({ directory, readAt: new Date().toISOString(), entries });
}
