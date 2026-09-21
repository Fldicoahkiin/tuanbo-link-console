import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createEmptyLinkProject } from '@tb/schema';
import { importMa2TimecodeCommand, parseP1TimeOrigin } from '@tb/core/link';
import { convertMa2Timecode, convertMa2Snapshot } from './ma2-timecode-conversion';
import { prepareMa2MergedEvents, confirmMa2MergedEvents } from './ma2-event-write';
import { inspectMa2TimecodeXml, sameMa2XmlObjects } from './ma2-timecode-xml';
import { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { Ma2ApplyService } from './ma2-apply-service';

const xml = await readFile(new URL('./fixtures/ma2-timecode-fractional-3.3.xml', import.meta.url), 'utf8');
const sequence = await readFile(new URL('./fixtures/ma2-sequence-fractional-3.3.xml', import.meta.url), 'utf8');
function bind(preview: ReturnType<typeof convertMa2Timecode>) {
  const project = createEmptyLinkProject('偏移测试');
  project.rundown = [{ id: 'song', title: '歌曲', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [] }];
  return importMa2TimecodeCommand('song', preview).execute(project).rundown[0]!.lighting!;
}
it('P1 秒数和明确时分秒格式转换，拒绝不完整或超范围时间', () => {
  expect(parseP1TimeOrigin('3600.125')).toBe(3600125);
  expect(parseP1TimeOrigin('01:00:00.125')).toBe(3600125);
  for (const value of ['1:00', '24:00:00', '-1', 'NaN', '1e3']) expect(() => parseP1TimeOrigin(value)).toThrow();
});
it('一小时偏移导入为歌曲零点，编辑后写回保留原偏移并回读', () => {
  const source = xml.replace('<Timecode ', '<Timecode offset="108000" ');
  const preview = convertMa2Timecode(source, [sequence], 9902, 3600000);
  expect(preview.document.tracks[0]!.clips[0]!.events.map(event => event.at)).toEqual([0, 1500]);
  const document = bind(preview); document.tracks[0]!.clips[0]!.events[0]!.at = 500;
  const prepared = prepareMa2MergedEvents(document, document.ma2Bindings![0]!.id, preview, new Map(), new Map(), [sequence]);
  expect(inspectMa2TimecodeXml(prepared.desiredXml).timecodes[0]!.attributes.offset).toBe('108000');
  const confirmed = confirmMa2MergedEvents(prepared, prepared.desiredXml, [sequence]);
  expect(confirmed.document.tracks[0]!.clips[0]!.events[0]!.at).toBe(500);
  expect(confirmed.timeOriginMs).toBe(3600000);
});
it('跨歌曲的早期事件不静默删除', () => {
  expect(() => convertMa2Timecode(xml, [sequence], 9902, 60000)).toThrow('起点之前');
});
it.skipIf(!process.env.MA2_ONPC_ORIGIN_ACCEPTANCE)('真实 onPC 一小时偏移修改及回读，最后恢复原测试对象', async () => {
  const bridge = new Ma2OnpcBridge(process.env.MA2_ONPC_DATA_DIRECTORY ?? '', () => false);
  const original = await bridge.request('READ', 9902);
  expect(inspectMa2TimecodeXml(original).timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
  try {
    const desired = original.replace(/(<Timecode\b[^>]*?)\s+offset="[^"]*"/, '$1').replace('<Timecode ', '<Timecode offset="108000" ');
    await bridge.exchange('APPLY', 9902, original, desired);
    const snapshot = await bridge.request('SNAPSHOT', 9902);
    const preview = convertMa2Snapshot(snapshot, 9902, [], 3600000);
    const document = bind(preview); document.tracks[0]!.clips[0]!.events[0]!.at = 500;
    const result = await new Ma2ApplyService(bridge, () => false).apply({ dataDirectory: process.env.MA2_ONPC_DATA_DIRECTORY ?? '', document, bindingId: document.ma2Bindings![0]!.id, readback: preview, choices: [], conflicts: [] });
    if (result.status !== 'verified') throw new Error(result.message);
    expect(result.confirmed.document.tracks[0]!.clips[0]!.events[0]!.at).toBe(500);
    expect(inspectMa2TimecodeXml(result.confirmed.sourceXml).timecodes[0]?.attributes.offset).toBe('108000');
  } finally {
    const current = await bridge.request('READ', 9902);
    if (!sameMa2XmlObjects(current, original)) await bridge.exchange('APPLY', 9902, current, original);
    expect(sameMa2XmlObjects(await bridge.request('READ', 9902), original)).toBe(true);
  }
}, 120000);
