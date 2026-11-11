import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { convertMa2Timecode } from './ma2-timecode-conversion';
import { compareMa2LightingReadback } from './ma2-comparison';
import { editMa2TimecodeEvents, inspectMa2TimecodeXml } from './ma2-timecode-xml';

const xml = await readFile(new URL('./fixtures/ma2-timecode-fractional-3.3.xml', import.meta.url), 'utf8');
const sequence = await readFile(new URL('./fixtures/ma2-sequence-fractional-3.3.xml', import.meta.url), 'utf8');
const masterXml = await readFile(new URL('./fixtures/ma2-timecode-master-3.3.xml', import.meta.url), 'utf8');
function fixture(source = xml) {
  const preview = convertMa2Timecode(source, [sequence], 9902);
  const document = structuredClone(preview.document);
  document.ma2Bindings = [{ id: 'binding', timecode: preview.target, name: preview.name, readAt: preview.readAt, sourceXml: preview.sourceXml, baselineTracks: structuredClone(preview.document.tracks), mappings: structuredClone(preview.mappings) }];
  return { preview, document };
}
describe('MA2 主进程比较入口', () => {
  it('Master 时间与百分比独立修改可合并，双方改值或删除与修改会冲突', () => {
    const { document } = fixture(masterXml);
    const clip = document.tracks[0]!.clips[0]!;
    const event = clip.events.find((entry) => entry.kind === 'ma2-fader' && entry.level === 0.755);
    if (event?.kind !== 'ma2-fader') throw new Error('缺少 Master 样例');
    event.at = 1000;
    const remote = convertMa2Timecode(masterXml.replace('fader_level="0.755"', 'fader_level="0.625"'), [sequence], 9902);
    const result = compareMa2LightingReadback(document, 'binding', remote);
    expect(result.conflicts).toEqual([]);
    expect(result.merged.find((entry) => entry.id === event.id)?.properties).toMatchObject({ time: '1000', action: 'master', fader: 'Master', level: '0.625' });
    event.level = 0.5;
    const conflict = compareMa2LightingReadback(document, 'binding', remote).conflicts;
    expect(conflict).toHaveLength(1);
    expect(conflict[0]).toMatchObject({ id: event.id, base: { properties: { level: '0.755' } }, local: { properties: { level: '0.5' } }, remote: { properties: { level: '0.625' } } });
    clip.events = clip.events.filter((entry) => entry.id !== event.id);
    expect(compareMa2LightingReadback(document, 'binding', remote).conflicts[0]).toMatchObject({ id: event.id, local: null });
  });
  it('Master 快照必须与原 XML 数值、类型、执行器和映射相符', () => {
    const { document, preview } = fixture(masterXml);
    for (const field of ['level', 'executor', 'at', 'action'] as const) {
      const invalid = structuredClone(preview);
      const event = invalid.document.tracks[0]!.clips[0]!.events.find((entry) => entry.kind === 'ma2-fader');
      if (event?.kind !== 'ma2-fader') throw new Error('缺少 Master 样例');
      if (field === 'level') event.level = 0.6;
      if (field === 'executor') event.executor = '99.220';
      if (field === 'at') event.at = 100;
      if (field === 'action') invalid.mappings.find((entry) => entry.eventId === event.id)!.action = 'go';
      expect(() => compareMa2LightingReadback(document, 'binding', invalid)).toThrow('原始 XML');
    }
  });
  it('控台清空轨道只产生事件删除，拒绝错误或不完整的轨道映射', () => {
    const { document } = fixture();
    const report = inspectMa2TimecodeXml(xml);
    const emptyXml = editMa2TimecodeEvents(xml, report.sha256, 9902, report.timecodes[0]!.tracks[0]!.subtracks[0]!.events.map((event) => ({ kind: 'delete', path: event.path })));
    const empty = convertMa2Timecode(emptyXml, [], 9902);
    const result = compareMa2LightingReadback(document, 'binding', empty);
    expect(result.remote.objects.filter((object) => object.kind === 'track').map((object) => object.id)).toEqual([document.tracks[0]!.id]);
    expect(result.remote.objects.filter((object) => object.kind === 'event')).toEqual([]);
    for (const field of ['executor', 'path', 'subtracks'] as const) {
      const invalid = structuredClone(empty);
      if (field === 'subtracks') invalid.trackMappings![0]!.subtracks = [];
      else invalid.trackMappings![0]![field] = field === 'executor' ? '99.220' : 'Timecode:9901/Track:9';
      expect(() => compareMa2LightingReadback(document, 'binding', invalid)).toThrow('轨道映射');
    }
    expect(() => compareMa2LightingReadback(document, 'binding', { ...empty, trackMappings: [] })).toThrow('全部轨道');
  });
  it('从原始导出取得版本与摘要，回读内容改变对应不同版本摘要', () => {
    const { document } = fixture();
    document.tracks[0]!.clips[0]!.events[0]!.at = 500;
    const remote = convertMa2Timecode(xml.replace('time="45"', 'time="60"'), [sequence], 9902);
    const result = compareMa2LightingReadback(document, 'binding', remote);
    expect(result.base.consoleVersion).toBe('3.3.4');
    expect(result.base.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(result.remote.revision).not.toBe(result.base.revision);
    expect(result.local.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(result.conflicts).toEqual([]);
    expect(result.merged.filter((event) => event.kind === 'event').map((event) => event.properties.time)).toEqual(expect.arrayContaining(['500', '2000']));
  });
  it('拒绝与原 XML 时间、绑定目标和引用不一致的预览', () => {
    const { preview, document } = fixture();
    const invalid = structuredClone(preview); invalid.document.tracks[0]!.clips[0]!.events[0]!.at = 100;
    expect(() => compareMa2LightingReadback(document, 'binding', invalid)).toThrow('原始 XML');
    expect(() => compareMa2LightingReadback(document, 'binding', { ...preview, target: 1 })).toThrow('Timecode');
    expect(() => compareMa2LightingReadback(document, 'binding', { ...preview, mappings: [] })).toThrow('全部事件');
    document.ma2Bindings![0]!.baselineTracks[0]!.clips[0]!.events[0]!.at = 100;
    expect(() => compareMa2LightingReadback(document, 'binding', preview)).toThrow('原始 XML');
  });
});
