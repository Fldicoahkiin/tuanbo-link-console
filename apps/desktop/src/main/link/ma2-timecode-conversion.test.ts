import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { importMa2TimecodeCommand, matchMa2Readback } from '@tb/core/link';
import { createEmptyLinkProject, parseLinkProject, serializeLinkProject } from '@tb/schema';
import { convertMa2Snapshot, convertMa2Timecode } from './ma2-timecode-conversion';
import { editMa2TimecodeEvents, inspectMa2TimecodeXml, inspectMa2SequenceXml, resolveMa2CueReference, validateMa2TimecodeWrite } from './ma2-timecode-xml';

const timecode = await readFile(new URL('./fixtures/ma2-timecode-fractional-3.3.xml', import.meta.url), 'utf8');
const sequence = await readFile(new URL('./fixtures/ma2-sequence-fractional-3.3.xml', import.meta.url), 'utf8');

describe('MA2 本机实测小数 Cue 引用转换', () => {
  it('原生省略 active 表示静音，未知状态不得按启用读取', () => {
    for (const attribute of ['', ' active="false"']) {
      const preview = convertMa2Timecode(timecode.replace(' active="true"', attribute), [sequence], 9902);
      expect(preview.document.tracks[0]!.muted).toBe(true);
      expect(preview.document.tracks[0]!.clips[0]!.events).toHaveLength(2);
    }
    expect(convertMa2Timecode(timecode, [sequence], 9902).document.tracks[0]!.muted).toBe(false);
    expect(() => convertMa2Timecode(timecode.replace('active="true"', 'active="unknown"'), [sequence], 9902)).toThrow('状态格式');
  });
  it('导出完整 Cue 目录，包含 Timecode 尚未使用的 Cue', () => {
    const expanded = sequence.replace('</Sequ>', '<Cue index="3"><Number number="12" sub_number="125" /><CuePart index="0" name="结束" /></Cue></Sequ>');
    const preview = convertMa2Timecode(timecode, [expanded], 9902);
    expect(preview.cueCatalog?.[0]).toMatchObject({ sequence: 9901, cues: [{ index: 1, number: '1.250' }, { index: 2, number: '7.500' }, { index: 3, number: '12.125', name: '结束' }] });
    expect(preview.mappings).toHaveLength(2);
  });
  it('全执行器动作快照无序列也可导入，Go 与 Off 不匹配成同一事件', () => {
    const path = 'Timecode:9901/Track:0/SubTrack:0';
    const xml = editMa2TimecodeEvents(timecode, inspectMa2TimecodeXml(timecode).sha256, 9902, [
      { kind: 'update', path: `${path}/Event:0`, executorAction: 'go' },
      { kind: 'update', path: `${path}/Event:1`, executorAction: 'off' }
    ]);
    const before = convertMa2Snapshot(xml, 9902);
    expect(before.unconverted).toEqual([]);
    for (const event of before.document.tracks[0]!.clips[0]!.events) {
      expect(event).not.toHaveProperty('cue'); expect(event).not.toHaveProperty('sequence');
    }
    const after = convertMa2Snapshot(xml.replace('time="45"', 'time="90"'), 9902);
    const result = matchMa2Readback({ id: 'binding', timecode: 9902, name: before.name, readAt: before.readAt, sourceXml: xml, baselineTracks: before.document.tracks, mappings: before.mappings }, after);
    expect(result.ambiguous).toEqual([]);
    expect(result.matches).toEqual(before.mappings.map((mapping, index) => ({ baselineEventId: mapping.eventId, remoteEventId: after.mappings[index]!.eventId })));
  });
  it('本机导出样例改变事件索引、时间及 Cue 编号后仍通过内部引用匹配', () => {
    const before = convertMa2Timecode(timecode, [sequence], 9902);
    const changed = timecode.replace('<Event index="0"', '<Event index="5"').replace('<Event index="1" time="45"', '<Event index="3" time="90"');
    const after = convertMa2Timecode(changed, [sequence.replace('number="7" sub_number="500"', 'number="10" sub_number="125"')], 9902);
    const result = matchMa2Readback({ id: 'binding', timecode: before.target, name: before.name, readAt: before.readAt, sourceXml: before.sourceXml, baselineTracks: before.document.tracks, mappings: before.mappings }, after);
    expect(result.ambiguous).toEqual([]);
    expect(result.added).toEqual([]); expect(result.deleted).toEqual([]);
    expect(result.matches).toEqual(before.mappings.map((mapping, index) => ({ baselineEventId: mapping.eventId, remoteEventId: after.mappings[index]!.eventId })));
    expect(after.document.tracks[0]!.clips[0]!.events[1]).toMatchObject({ at: 3000, cue: '10.125' });
  });
  it('用户预览保留 Timecode 基线但不把序列内部灯具数据写进节目', () => {
    const object = sequence.match(/<Sequ\s[\s\S]*?<\/Sequ>/)?.[0];
    if (!object) throw new Error('测试序列缺失');
    const result = convertMa2Snapshot(timecode.replace('</MA>', `${object}</MA>`), 9902);
    expect(result.sourceXml).not.toContain('<Sequ');
    expect(result.sourceXml).not.toContain('<Info');
    expect(() => validateMa2TimecodeWrite(result.sourceXml)).not.toThrow();
    expect(result.mappings[0]?.trackId).toBe(result.document.tracks[0]?.id);
    expect(result.mappings[0]?.clipId).toBe(result.document.tracks[0]?.clips[0]?.id);
  });
  it('将内部索引 1、2 解析为实际 Cue 1.250、7.500，而不是 Cue 1、2', () => {
    const report = inspectMa2SequenceXml(sequence);
    expect(report.sequences[0]).toMatchObject({ number: 9901, cues: [{ index: 1, number: '1.250' }, { index: 2, number: '7.500' }] });
    expect(resolveMa2CueReference(['1', '9901', '2'], [report])).toEqual({ sequence: 9901, cueIndex: 2, cueNumber: '7.500', cueName: null });
    const result = convertMa2Timecode(timecode, [sequence], 9902);
    expect(result.unconverted).toEqual([]);
    expect(result.document.tracks[0]).toMatchObject({ kind: 'ma2', muted: false, clips: [{ timeLock: 'time', events: [
      { at: 0, sequence: 9901, executor: '99.219', cue: '1.250', label: 'Cue 1.25', action: 'goto' },
      { at: 1500, sequence: 9901, executor: '99.219', cue: '7.500', label: 'Cue 7.5', action: 'goto' }
    ] }] });
    expect(result.mappings).toHaveLength(2);
    expect(result.mappings[1]).toMatchObject({ path: 'Timecode:9901/Track:0/SubTrack:0/Event:1', cueIndex: 2, executor: '99.219' });
    expect(result.sourceXml).toBe(timecode);
  });
  it('控台重新编号时使用序列数据，不从 Cue 名称猜测', () => {
    const renamed = sequence.replace('number="7" sub_number="500"', 'number="10" sub_number="125"');
    const result = convertMa2Timecode(timecode, [renamed], 9902);
    expect(result.document.tracks[0]?.clips[0]?.events[1]).toMatchObject({ cue: '10.125', label: 'Cue 7.5' });
  });
  it('未知动作、丢失执行器与丢失序列均列出未转换事件并保留 XML', () => {
    const unsupported = timecode.replace('command="Goto"', 'command="Fader" fader_level="64"');
    const result = convertMa2Timecode(unsupported, [sequence], 9902);
    expect(result.unconverted).toHaveLength(1);
    expect(result.document.tracks[0]?.clips[0]?.events).toHaveLength(1);
    expect(result.sourceXml).toBe(unsupported);
    const missingExecutor = timecode.replace(/<Object[^>]*>[\s\S]*?<\/Object>/, '<Object />');
    expect(convertMa2Timecode(missingExecutor, [sequence], 9902).unconverted).toHaveLength(2);
    expect(convertMa2Timecode(timecode, [], 9902).unconverted).toHaveLength(2);
    expect(convertMa2Timecode(timecode.replace('pressed="true"', 'pressed="false"'), [sequence], 9902).unconverted).toHaveLength(1);
  });
  it('拒绝不明确的索引、序列映射和未验证的时间基准', () => {
    const report = inspectMa2SequenceXml(sequence);
    expect(() => resolveMa2CueReference(['1', '9901', '7'], [report])).toThrow('无法解析');
    expect(() => resolveMa2CueReference(['1', '9901', '1'], [report, report])).toThrow('不唯一');
    expect(() => resolveMa2CueReference(['25', '9901', '1'], [report])).toThrow('结构');
    expect(() => inspectMa2SequenceXml(sequence.replace('sub_number="250"', 'sub_number="1250"'))).toThrow('编号无效');
    expect(() => inspectMa2SequenceXml(sequence.replace('index="2"', 'index="1"'))).toThrow('重复');
    expect(() => convertMa2Timecode(timecode.replace('30 FPS', '25 FPS'), [sequence], 9902)).toThrow('30 FPS');
    expect(() => convertMa2Timecode(timecode.replace('slot="TC Slot 1"', 'slot="TC Slot 1" offset="30"'), [sequence], 9902)).toThrow('偏移');
    expect(() => convertMa2Timecode(timecode, [sequence], 9901)).toThrow('没有绑定');
  });
});


describe('原生 Master 推杆导入与身份对应', () => {
  it('同一执行器的 Cue 和 Master 分别建立映射，比例变化保留身份', async () => {
    const xml = await readFile(new URL('./fixtures/ma2-timecode-master-3.3.xml', import.meta.url), 'utf8');
    const before = convertMa2Timecode(xml, [sequence], 9902);
    expect(before.unconverted).toEqual([]);
    expect(before.mappings.map((mapping) => mapping.action ?? 'goto')).toEqual(['goto', 'goto', 'master', 'master']);
    const project = createEmptyLinkProject('推杆导入');
    project.rundown.push({ id: 'song', title: '节目', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [] });
    const imported = importMa2TimecodeCommand('song', before).execute(project);
    const saved = parseLinkProject(JSON.parse(serializeLinkProject(imported)));
    const binding = saved.rundown[0]?.lighting?.ma2Bindings?.[0];
    if (!binding) throw new Error('推杆导入没有保存绑定');
    const remote = convertMa2Timecode(xml.replace('fader_level="0.755"', 'fader_level="0.625"'), [sequence], 9902);
    const matches = matchMa2Readback(binding, remote);
    expect(matches.ambiguous).toEqual([]);
    expect(matches.added).toEqual([]); expect(matches.deleted).toEqual([]);
    expect(matches.matches).toHaveLength(4);
    expect(binding.baselineTracks[0]?.clips[0]?.events.filter((event) => event.kind === 'ma2-fader').map((event) => event.level)).toEqual([0.25, 0.755]);
  });
  it('未知目标、越界值和额外参数明确留在未转换报告中', async () => {
    const xml = await readFile(new URL('./fixtures/ma2-timecode-master-3.3.xml', import.meta.url), 'utf8');
    for (const changed of [xml.replace('fader_command="Master"', 'fader_command="Speed"'), xml.replace('fader_level="0.755"', 'fader_level="1.5"'), xml.replace('fader_level="0.755"', 'fader_level="0.755" unknown="1"')]) {
      const preview = convertMa2Timecode(changed, [sequence], 9902);
      expect(preview.unconverted.length).toBeGreaterThan(0);
      expect(preview.sourceXml).toBe(changed);
      expect(preview.document.tracks[0]?.clips[0]?.events.filter((event) => event.kind === 'ma2')).toHaveLength(2);
    }
  });
});
