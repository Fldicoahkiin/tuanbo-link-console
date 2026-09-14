import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { editMa2TimecodeEvents, extendMa2TimecodeLength, inspectMa2SequenceXml, inspectMa2TimecodeXml, patchMa2EventTimes, prepareMa2TimecodeEvents, resolveMa2CueNumber, sameMa2XmlObjects, validateMa2TimecodeSnapshot } from './ma2-timecode-xml';
import { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { convertMa2Timecode } from './ma2-timecode-conversion';

const source = readFileSync(fileURLToPath(new URL('./fixtures/ma2-timecode-3.7.xml', import.meta.url)), 'utf8');
const native = readFileSync(fileURLToPath(new URL('./fixtures/ma2-timecode-fractional-3.3.xml', import.meta.url)), 'utf8');
const sequence = readFileSync(fileURLToPath(new URL('./fixtures/ma2-sequence-fractional-3.3.xml', import.meta.url)), 'utf8');

describe('MA2 原生 Cue 写回编辑', () => {
  const path = 'Timecode:9901/Track:0/SubTrack:0';
  const cue = { sequence: 9901, cueIndex: 1, name: 'Cue 1.25' };
  it('播放长度覆盖最后一点后的一帧，保留更长结尾并在回读时检查长度', () => {
    const extended = extendMa2TimecodeLength(native, 9902);
    expect(inspectMa2TimecodeXml(extended).timecodes[0]?.attributes.lenght).toBe('46');
    const longer = extended.replace('lenght="46"', 'lenght="3000"');
    expect(extendMa2TimecodeLength(longer, 9902)).toBe(longer);
    expect(sameMa2XmlObjects(extended, extended.replace('lenght="46"', 'lenght="45"'))).toBe(false);
    expect(() => extendMa2TimecodeLength(extended.replace('lenght="46"', 'lenght="bad"'), 9902)).toThrow('播放长度无效');
    expect(() => extendMa2TimecodeLength(native, 9901)).toThrow('目标');
    expect(() => extendMa2TimecodeLength(source, 1)).toThrow();
  });
  it('推杆轨道也参与长度计算，删除末点不会缩短既有结束位置', () => {
    const sparse = readFileSync(fileURLToPath(new URL('./fixtures/ma2-master-sparse-3.3.xml', import.meta.url)), 'utf8');
    const extended = extendMa2TimecodeLength(sparse, 9904);
    expect(inspectMa2TimecodeXml(extended).timecodes[0]?.attributes.lenght).toBe('601');
    const shorter = editMa2TimecodeEvents(extended, inspectMa2TimecodeXml(extended).sha256, 9904, [{ kind: 'delete', path: 'Timecode:9903/Track:0/SubTrack:1/Event:2' }]);
    expect(extendMa2TimecodeLength(shorter, 9904)).toBe(shorter);
    const empty = editMa2TimecodeEvents(native, inspectMa2TimecodeXml(native).sha256, 9902, [{ kind: 'delete', path: `${path}/Event:0` }, { kind: 'delete', path: `${path}/Event:1` }]);
    expect(extendMa2TimecodeLength(empty, 9902)).toBe(empty);
  });
  it('额外序列必须与请求范围完全一致，普通快照不能带入无关序列', () => {
    const empty = editMa2TimecodeEvents(native, inspectMa2TimecodeXml(native).sha256, 9902, [{ kind: 'delete', path: `${path}/Event:0` }, { kind: 'delete', path: `${path}/Event:1` }]);
    const object = sequence.match(/<Sequ\s[\s\S]*?<\/Sequ>/)?.[0];
    if (!object) throw new Error('测试序列缺失');
    const scoped = empty.replace('</MA>', `${object}</MA>`);
    expect(() => validateMa2TimecodeSnapshot(scoped, [9901])).not.toThrow();
    expect(() => validateMa2TimecodeSnapshot(scoped)).toThrow('范围');
    expect(() => validateMa2TimecodeSnapshot(scoped, [9902])).toThrow('缺失');
    expect(() => validateMa2TimecodeSnapshot(empty, [9901])).toThrow('缺失');
    expect(() => validateMa2TimecodeSnapshot(empty, [-1])).toThrow('编号');
  });
  it('执行器动作不伪造 Cue 引用，排序后保留身份并可改回指定 Cue', () => {
    const result = prepareMa2TimecodeEvents(native, inspectMa2TimecodeXml(native).sha256, 9902, [
      { kind: 'update', path: `${path}/Event:1`, executorAction: 'off' },
      { kind: 'add', subtrackPath: path, rawTime: '30', executorAction: 'go' }
    ]);
    const events = inspectMa2TimecodeXml(result.xml).timecodes[0]?.tracks[0]?.subtracks[0]?.events;
    expect(events?.map((event) => [event.attributes.command, event.cueAddress])).toEqual([
      ['Goto', ['1', '9901', '1']], ['Go', []], ['Off', []]
    ]);
    expect(result.originalPaths.get(`${path}/Event:1`)).toBe(`${path}/Event:2`);
    expect(result.addedPaths.get(1)).toBe(`${path}/Event:1`);
    const restored = editMa2TimecodeEvents(result.xml, inspectMa2TimecodeXml(result.xml).sha256, 9902, [
      { kind: 'update', path: `${path}/Event:2`, cue }
    ]);
    expect(inspectMa2TimecodeXml(restored).timecodes[0]?.tracks[0]?.subtracks[0]?.events[2]).toMatchObject({ attributes: { command: 'Goto', step: '1' }, cueAddress: ['1', '9901', '1'] });
  });
  it('只忽略 Go/Off 的派生步骤编号，不忽略动作、时间、Cue 与扩展信息', () => {
    const result = editMa2TimecodeEvents(native, inspectMa2TimecodeXml(native).sha256, 9902, [{ kind: 'update', path: `${path}/Event:1`, executorAction: 'go' }]);
    expect(sameMa2XmlObjects(result, result.replace('command="Go"', 'command="Go" step="2"'))).toBe(true);
    expect(sameMa2XmlObjects(result, result.replace('command="Go"', 'command="Off"'))).toBe(false);
    expect(sameMa2XmlObjects(result, result.replace('time="45"', 'time="46"'))).toBe(false);
    expect(sameMa2XmlObjects(result, result.replace('command="Go"', 'command="Go" custom="1"'))).toBe(false);
    expect(sameMa2XmlObjects(native, native.replace('step="2"', 'step="1"'))).toBe(false);
  });
  it('拒绝同时指定 Cue 和执行器动作，以及转换时丢失未知 Cue 信息', () => {
    const edit = { kind: 'update' as const, path: `${path}/Event:0`, executorAction: 'off' as const };
    expect(() => editMa2TimecodeEvents(native, inspectMa2TimecodeXml(native).sha256, 9902, [{ ...edit, cue }])).toThrow('同时');
    expect(() => editMa2TimecodeEvents(native, inspectMa2TimecodeXml(native).sha256, 9902, [{ kind: 'add', subtrackPath: path, rawTime: '0' }])).toThrow('必须');
    for (const xml of [native.replace('<Cue ', '<Cue custom="1" '), native.replace('</Cue>', '<Extension/></Cue>'), native.replace('<No>9901</No>', '<No custom="1">9901</No>')]) {
      expect(() => editMa2TimecodeEvents(xml, inspectMa2TimecodeXml(xml).sha256, 9902, [edit])).toThrow('未知');
    }
  });
  it('重排、删除及同一时刻重复 Cue 保留精确写回映射', () => {
    const result = prepareMa2TimecodeEvents(native, inspectMa2TimecodeXml(native).sha256, 9902, [
      { kind: 'update', path: `${path}/Event:0`, rawTime: '90' },
      { kind: 'delete', path: `${path}/Event:1` },
      { kind: 'add', subtrackPath: path, rawTime: '90', cue },
      { kind: 'add', subtrackPath: path, rawTime: '0', cue }
    ]);
    expect([...result.originalPaths]).toEqual([[`${path}/Event:0`, `${path}/Event:1`]]);
    expect([...result.addedPaths]).toEqual([[2, `${path}/Event:2`], [3, `${path}/Event:0`]]);
    const unchanged = prepareMa2TimecodeEvents(native, inspectMa2TimecodeXml(native).sha256, 9902, []);
    expect(unchanged.originalPaths.size).toBe(2);
    expect(unchanged.xml).toBe(native);
  });
  it('写入前按实际序列解析小数 Cue，拒绝不存在的编号和重复序列', () => {
    const reports = [inspectMa2SequenceXml(sequence)];
    expect(resolveMa2CueNumber(9901, '1.25', reports)).toMatchObject({ cueIndex: 1, cueNumber: '1.250' });
    expect(resolveMa2CueNumber(9901, '7.500', reports)).toMatchObject({ cueIndex: 2, cueNumber: '7.500' });
    expect(() => resolveMa2CueNumber(9901, '2', reports)).toThrow('不存在');
    expect(() => resolveMa2CueNumber(9901, '1.2501', reports)).toThrow('无效');
    expect(() => resolveMa2CueNumber(9901, '0', reports)).toThrow('零');
    expect(() => resolveMa2CueNumber(9901, '1.25', [...reports, ...reports])).toThrow('不唯一');
  });
  it('修改、新增、删除后排序重建索引，实际 Cue 编号与时间可重新转换', () => {
    const result = editMa2TimecodeEvents(native, inspectMa2TimecodeXml(native).sha256, 9902, [
      { kind: 'update', path: `${path}/Event:1`, rawTime: '90', cue },
      { kind: 'delete', path: `${path}/Event:0` },
      { kind: 'add', subtrackPath: path, rawTime: '0', cue: { ...cue, cueIndex: 2, name: 'Cue 7.5' } },
      { kind: 'add', subtrackPath: path, rawTime: '45', cue }
    ]);
    const report = inspectMa2TimecodeXml(result);
    const events = report.timecodes[0]?.tracks[0]?.subtracks[0]?.events;
    expect(events?.map((event) => [event.attributes.index, event.attributes.time, event.attributes.step])).toEqual([
      ['0', undefined, '2'], ['1', '45', '1'], ['2', '90', '1']
    ]);
    const converted = convertMa2Timecode(result, [sequence], 9902);
    expect(converted.unconverted).toEqual([]);
    expect(converted.document.tracks[0]?.clips[0]?.events).toMatchObject([
      { at: 0, cue: '7.500' }, { at: 1500, cue: '1.250' }, { at: 3000, cue: '1.250' }
    ]);
  });
  it('事件重排保留扩展节点的位置、Cue 引用的属性和其他对象信息', () => {
    const extended = native.replace('<Event index="1"', '<FutureData test="keep"/><Event index="1"')
      .replace('<No>9901</No>', '<No origin="keep">9901</No><CueExtension value="keep"/>')
      .replace('</Timecode>', '<TimecodeExtension value="keep"/></Timecode>');
    const result = editMa2TimecodeEvents(extended, inspectMa2TimecodeXml(extended).sha256, 9902, [
      { kind: 'update', path: `${path}/Event:0`, rawTime: '60', cue: { ...cue, cueIndex: 2, name: 'Cue 7.5' } }
    ]);
    expect(result).toMatch(/<Event index="0"[\s\S]*<FutureData test="keep"\/>[\s\S]*<Event index="1"/);
    expect(result).toContain('<No origin="keep">9901</No><CueExtension value="keep"/>');
    expect(result).toContain('<TimecodeExtension value="keep"/>');
  });
  it('无修改字节不变，拒绝过期 XML、错误目标、重复修改与无效时间', () => {
    const hash = inspectMa2TimecodeXml(native).sha256;
    const update = { kind: 'update' as const, path: `${path}/Event:0`, rawTime: '30' };
    expect(editMa2TimecodeEvents(native, hash, 9902, [])).toBe(native);
    expect(() => editMa2TimecodeEvents(native + ' ', hash, 9902, [update])).toThrow('改变');
    expect(() => editMa2TimecodeEvents(native, hash, 9901, [update])).toThrow('目标');
    expect(() => editMa2TimecodeEvents(native, hash, 9902, [update, update])).toThrow('重复');
    expect(() => editMa2TimecodeEvents(native, hash, 9902, [{ ...update, rawTime: '-1' }])).toThrow();
    expect(() => editMa2TimecodeEvents(native, hash, 9902, [{ ...update, path: 'missing' }])).toThrow('不存在');
    expect(() => editMa2TimecodeEvents(native, hash, 9902, [{ kind: 'add', subtrackPath: 'missing', rawTime: '30', cue }])).toThrow('不存在');
  });
});

describe('MA2 3.7 历史导出文件探针', () => {
  it('回读确认包含未知节点与引用属性，不把数据丢失当作同步成功', () => {
    const extended = source.replace('</Timecode>', '<FutureData enabled="true"><Value>未知参数</Value></FutureData></Timecode>');
    expect(sameMa2XmlObjects(extended, source)).toBe(false);
    expect(sameMa2XmlObjects(extended, extended.replace('未知参数', '不同参数'))).toBe(false);
    expect(sameMa2XmlObjects(extended, extended.replace('enabled="true"', 'enabled="false"'))).toBe(false);
    const cueExtension = source.replace('<Cue ', '<Cue tracking="preserve" ');
    expect(sameMa2XmlObjects(cueExtension, source)).toBe(false);
  });
  it('回读确认忽略对象外信息、排版和属性排列，但保留子节点次序', () => {
    const extended = source.replace('</Timecode>', '<FutureData a="1" b="2"><Value>甲</Value><Value>乙</Value></FutureData></Timecode>');
    expect(sameMa2XmlObjects(extended, extended.replace('a="1" b="2"', 'b="2" a="1"').replace(/>\s+</g, '>\n  <'))).toBe(true);
    expect(sameMa2XmlObjects(extended, extended.replace('<Value>甲</Value><Value>乙</Value>', '<Value>乙</Value><Value>甲</Value>'))).toBe(false);
    expect(sameMa2XmlObjects(source, source.replace('</MA>', '<Info changed="export-time" /></MA>'))).toBe(true);
  });
  it('读取实际 Timecode、执行器地址与 Cue 引用', () => {
    const report = inspectMa2TimecodeXml(source);
    expect(report.version).toBe('3.7.0');
    const timecode = report.timecodes[0];
    expect(timecode?.index).toBe(903);
    expect(timecode?.attributes.frame_format).toBe('30 FPS');
    expect(timecode?.tracks[0]?.executorAddress).toEqual(['30', '1', '99', '204']);
    const events = timecode?.tracks[0]?.subtracks[0]?.events;
    expect(events).toHaveLength(3);
    expect(events?.[0]?.cueAddress).toEqual(['1', '9004', '1']);
    expect(events?.[1]?.attributes.time).toBe('12');
  });
  it('只修改指定事件时间并保留其他字段与 XML 扩展节点', () => {
    const original = source.replace('</Timecode>', '<FutureData test="keep"><Value>未知</Value></FutureData></Timecode>');
    const before = inspectMa2TimecodeXml(original);
    const path = before.timecodes[0]?.tracks[0]?.subtracks[0]?.events[1]?.path;
    if (!path) throw new Error('样例缺少第二个事件');
    const edited = patchMa2EventTimes(original, before.sha256, [{ path, rawTime: '42.5' }]);
    expect(edited).toContain('<FutureData test="keep"><Value>未知</Value></FutureData>');
    const after = inspectMa2TimecodeXml(edited);
    const expected = structuredClone(before.timecodes);
    const changed = expected[0]?.tracks[0]?.subtracks[0]?.events[1];
    if (!changed) throw new Error('样例事件缺失');
    changed.attributes.time = '42.5';
    expect(after.timecodes).toEqual(expected);
  });
  it('无修改时返回原始文件，不重排 XML', () => {
    expect(patchMa2EventTimes(source, inspectMa2TimecodeXml(source).sha256, [])).toBe(source);
  });
  it('拒绝过期预览、无效时间和不存在的事件', () => {
    const report = inspectMa2TimecodeXml(source);
    const path = report.timecodes[0]?.tracks[0]?.subtracks[0]?.events[0]?.path ?? '';
    expect(() => patchMa2EventTimes(source + ' ', report.sha256, [])).toThrow('改变');
    expect(() => patchMa2EventTimes(source, report.sha256, [{ path, rawTime: '-1' }])).toThrow('时间');
    expect(() => patchMa2EventTimes(source, report.sha256, [{ path: 'missing', rawTime: '0' }])).toThrow('不存在');
  });
  it('未验证的版本可检查但不可修改', () => {
    const xml = source.replace('minor_vers="7"', 'minor_vers="9"');
    const report = inspectMa2TimecodeXml(xml);
    expect(report.warnings).toContain('尚未验证的 MA2 XML 版本：3.9.0');
    expect(() => patchMa2EventTimes(xml, report.sha256, [])).toThrow('禁止修改');
  });
  it('拒绝 DTD、错误命名空间、畸形 XML 和重复索引', () => {
    expect(() => inspectMa2TimecodeXml('<!DOCTYPE MA>' + source)).toThrow('DTD');
    expect(() => inspectMa2TimecodeXml(source.replace('xmlns="http://schemas.malighting.de/grandma2/xml/MA"', 'xmlns="wrong"'))).toThrow('不是');
    expect(() => inspectMa2TimecodeXml(source.replace('</Timecode>', ''))).toThrow();
    expect(() => inspectMa2TimecodeXml(source.replace('<Event index="1"', '<Event index="0"'))).toThrow('重复');
  });
  it('时间缺省时保留缺省语义，不擅自补成秒', () => {
    const report = inspectMa2TimecodeXml(source.replace(' time="0"', ''));
    expect(report.timecodes[0]?.tracks[0]?.subtracks[0]?.events[0]?.attributes.time).toBeUndefined();
  });
});


describe('本机 3.3.4 Master 推杆真实样例', () => {
  const master = readFileSync(fileURLToPath(new URL('./fixtures/ma2-timecode-master-3.3.xml', import.meta.url)), 'utf8');
  const path = 'Timecode:9901/Track:0/SubTrack:1';
  it('新增、修改和删除推杆点保留 Cue 与排序后的身份映射', () => {
    const before = inspectMa2TimecodeXml(master);
    const result = prepareMa2TimecodeEvents(master, before.sha256, 9902, [
      { kind: 'update', path: `${path}/Event:0`, rawTime: '30', faderLevel: '0.625' },
      { kind: 'delete', path: `${path}/Event:1` },
      { kind: 'add', subtrackPath: path, rawTime: '10', faderLevel: '0.125' }
    ]);
    const report = inspectMa2TimecodeXml(result.xml);
    expect(report.timecodes[0]?.tracks[0]?.subtracks[0]).toEqual(before.timecodes[0]?.tracks[0]?.subtracks[0]);
    expect(report.timecodes[0]?.tracks[0]?.subtracks[1]?.events.map((event) => event.attributes)).toEqual([
      { index: '0', time: '10', fader_level: '0.125' }, { index: '1', time: '30', fader_level: '0.625' }
    ]);
    expect(result.originalPaths.get(`${path}/Event:0`)).toBe(`${path}/Event:1`);
    expect(result.originalPaths.has(`${path}/Event:1`)).toBe(false);
    expect(result.addedPaths.get(2)).toBe(`${path}/Event:0`);
  });
  it('拒绝越界推杆值、混合动作和写错子轨道', () => {
    const sha = inspectMa2TimecodeXml(master).sha256;
    for (const faderLevel of ['-0.1', '1.01', 'NaN', '1e-1', '']) {
      expect(() => prepareMa2TimecodeEvents(master, sha, 9902, [{ kind: 'update', path: `${path}/Event:0`, faderLevel }])).toThrow();
    }
    expect(() => prepareMa2TimecodeEvents(master, sha, 9902, [{ kind: 'update', path: `${path}/Event:0`, executorAction: 'go' }])).toThrow('推杆');
    expect(() => prepareMa2TimecodeEvents(master, sha, 9902, [{ kind: 'add', subtrackPath: path, rawTime: '1', executorAction: 'go' }])).toThrow('推杆');
    expect(() => prepareMa2TimecodeEvents(master, sha, 9902, [{ kind: 'update', path: 'Timecode:9901/Track:0/SubTrack:0/Event:0', faderLevel: '0.5' }])).toThrow('推杆');
    const other = master.replace('fader_command="Master"', 'fader_command="Speed"');
    expect(() => prepareMa2TimecodeEvents(other, inspectMa2TimecodeXml(other).sha256, 9902, [{ kind: 'update', path: `${path}/Event:0`, faderLevel: '0.5' }])).toThrow('尚未验证');
  });
  it.skipIf(!process.env.MA2_ONPC_FADER_ACCEPTANCE)('本机 Master 点修改与新增经导入回读确认后还原测试对象', async () => {
    const bridge = new Ma2OnpcBridge(process.env.MA2_ONPC_DATA_DIRECTORY ?? '', () => false);
    const original = await bridge.request('READ', 9902);
    const before = inspectMa2TimecodeXml(original);
    expect(before.timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
    try {
      const seeded = await bridge.request('APPLY', 9902, original, master);
      const seed = inspectMa2TimecodeXml(seeded);
      const edited = prepareMa2TimecodeEvents(seeded, seed.sha256, 9902, [
        { kind: 'update', path: `${path}/Event:1`, rawTime: '30', faderLevel: '0.625' },
        { kind: 'add', subtrackPath: path, rawTime: '15', faderLevel: '0.125' }
      ]);
      const written = await bridge.request('APPLY', 9902, seeded, edited.xml);
      const readback = inspectMa2TimecodeXml(await bridge.request('READ', 9902));
      expect(readback.timecodes).toEqual(inspectMa2TimecodeXml(written).timecodes);
      expect(readback.timecodes[0]?.tracks[0]?.subtracks[0]).toEqual(seed.timecodes[0]?.tracks[0]?.subtracks[0]);
      expect(readback.timecodes[0]?.tracks[0]?.subtracks[1]?.events.map((event) => [event.attributes.time ?? '0', event.attributes.fader_level])).toEqual([
        ['0', '0.25'], ['15', '0.125'], ['30', '0.625']
      ]);
      const removed = editMa2TimecodeEvents(written, inspectMa2TimecodeXml(written).sha256, 9902, [{ kind: 'delete', path: `${path}/Event:1` }]);
      const afterDelete = inspectMa2TimecodeXml(await bridge.request('APPLY', 9902, written, removed));
      expect(afterDelete.timecodes[0]?.tracks[0]?.subtracks[1]?.events.map((event) => [event.attributes.time ?? '0', event.attributes.fader_level])).toEqual([
        ['0', '0.25'], ['30', '0.625']
      ]);
      expect(afterDelete.timecodes[0]?.tracks[0]?.subtracks[0]).toEqual(seed.timecodes[0]?.tracks[0]?.subtracks[0]);
    } finally {
      const current = await bridge.request('READ', 9902);
      expect(inspectMa2TimecodeXml(current).timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
      expect(inspectMa2TimecodeXml(await bridge.request('APPLY', 9902, current, original)).timecodes).toEqual(before.timecodes);
    }
  }, 60000);
  it('保留百分比原始精度、帧时间和子轨道目标', () => {
    const report = inspectMa2TimecodeXml(master);
    expect(report.timecodes[0]?.tracks[0]?.subtracks[1]).toMatchObject({
      index: 1, attributes: { fader_command: 'Master' }, events: [
        { attributes: { index: '0', fader_level: '0.25' }, cueAddress: [] },
        { attributes: { index: '1', time: '16', fader_level: '0.755' }, cueAddress: [] }
      ]
    });
    expect(sameMa2XmlObjects(master, master.replace('fader_level="0.755"', 'fader_level="0.75"'))).toBe(false);
  });
  it('修改 Cue 时间不改变推杆子轨道，转换保留全部原生点', () => {
    const before = inspectMa2TimecodeXml(master);
    const patched = editMa2TimecodeEvents(master, before.sha256, 9902, [
      { kind: 'update', path: 'Timecode:9901/Track:0/SubTrack:0/Event:1', rawTime: '60' }
    ]);
    expect(inspectMa2TimecodeXml(patched).timecodes[0]?.tracks[0]?.subtracks[1]).toEqual(before.timecodes[0]?.tracks[0]?.subtracks[1]);
    const preview = convertMa2Timecode(master, [sequence], 9902);
    expect(preview.unconverted).toEqual([]);
    expect(preview.document.tracks[0]?.clips[0]?.events.filter((event) => event.kind === 'ma2-fader')).toMatchObject([
      { level: 0.25, at: 0, executor: '99.219' }, { level: 0.755, at: 16000 / 30, executor: '99.219' }
    ]);
    expect(preview.sourceXml).toBe(master);
  });
});
