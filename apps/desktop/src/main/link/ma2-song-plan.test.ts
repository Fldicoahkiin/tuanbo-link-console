import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ma2SongSyncRequestSchema, type Ma2SongSyncRequest } from '@tb/schema';
import { ma2SongSyncBaseline, planMa2SongSync } from './ma2-song-plan';
import { editMa2SongSequence, emptyMa2SequenceXml, inspectMa2SequenceXml, inspectMa2CueData, ma2SequenceCueFingerprints } from './ma2-timecode-xml';

function request(): Ma2SongSyncRequest { return { network: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' }, expectedSource: { show: 'test', generation: 'g', version: '3.7.0.5' }, projectId: randomUUID(), itemId: 'song', requestId: randomUUID(), settings: { layout: 1000, name: '歌曲', nextSequence: 9000, columns: 8 }, name: '歌曲', points: Array.from({ length: 40 }, (_, i) => ({ id: `point-${i}`, name: `段落 ${i + 1}`, atMs: i * 1000, cues: [] })) }; }
function linked() {
  const input = request(); const plan = planMa2SongSync(input, null);
  const xml = editMa2SongSequence(emptyMa2SequenceXml(9000, '3.7.0.5'), input.name, plan.changes.map(value => ({ ...value, sources: [] })), []);
  input.binding = { endpoint: '192.0.2.1:30000', show: 'test', layout: 1000, sequence: 9000, name: '歌曲', baselineXml: xml, points: plan.points };
  input.points = input.points.map((point, index) => ({ ...point, cues: [{ sequence: 9000, cue: plan.points[index]!.cue, delayMs: 0 }] }));
  return { input, xml };
}
it('灯具属性复制与改名保留其他步，改名不清除本步灯光数据', () => {
  const source = readFileSync(new URL('./fixtures/ma2-cue-attributes-3.7.xml', import.meta.url), 'utf8');
  const { xml } = linked();
  const changed = editMa2SongSequence(xml, '歌曲', [{ cue: '3.000', name: '位置颜色', sources: [{ xml: source, cue: '1.000' }] }], []);
  expect(inspectMa2CueData(changed, 3)).toEqual(inspectMa2CueData(source, 1));
  const renamed = editMa2SongSequence(changed, '歌曲', [{ cue: '3.000', name: '新名称' }], []);
  expect(inspectMa2CueData(renamed, 3)).toEqual(inspectMa2CueData(source, 1));
  expect(ma2SequenceCueFingerprints(renamed).get('4.000')).toBe(ma2SequenceCueFingerprints(xml).get('4.000'));
});
it('40 个时间线点位生成同一序列的 40 个 Cue，保存后稳定且不重复创建', () => {
  const { input, xml } = linked(); const report = inspectMa2SequenceXml(xml).sequences[0]!;
  expect(report.cues).toHaveLength(40); expect(report.cues[39]).toMatchObject({ number: '40.000', name: 'DuanLuo 40' });
  const next = planMa2SongSync(input, xml); expect(next.changes).toEqual([]); expect(next.points).toEqual(input.binding?.points);
});
it('控台编灯和软件改名可以合并，名称变化不覆盖控台刚编的灯光', () => {
  const { input, xml } = linked();
  const source = readFileSync(new URL('./fixtures/ma2-cue-attributes-3.7.xml', import.meta.url), 'utf8');
  const remote = editMa2SongSequence(xml, '歌曲', [{ cue: '1.000', name: 'DuanLuo 1', sources: [{ xml: source, cue: '1.000' }] }], []);
  input.points[0]!.name = '电脑新名称';
  const plan = planMa2SongSync(input, remote);
  expect(plan.changes).toEqual([{ cue: '1.000', name: 'DianNaoXinMingCheng' }]);
  const merged = editMa2SongSequence(remote, plan.name, plan.changes, []);
  expect(inspectMa2CueData(merged, 1)).toEqual(inspectMa2CueData(source, 1));
});
it('控台改名和软件更换内容可以合并，内容指纹不误含名称', () => {
  const { input, xml } = linked();
  input.points[0]!.cues = [{ sequence: 2, cue: '1.000', delayMs: 0 }];
  const remote = editMa2SongSequence(xml, '歌曲', [{ cue: '1.000', name: '控台新名称' }], []);
  expect(planMa2SongSync(input, remote).changes).toEqual([{ cue: '1.000', name: '控台新名称', refs: input.points[0]!.cues }]);
});
it('软件重命名写出，控台重命名回读，同一 Cue 双方修改明确冲突', () => {
  const { input, xml } = linked(); input.points[0]!.name = '电脑修改';
  expect(planMa2SongSync(input, xml).changes).toEqual([{ cue: '1.000', name: 'DianNaoXiuGai' }]);
  const remote = editMa2SongSequence(xml, '控台歌名', [{ cue: '1.000', name: '控台修改' }], []);
  expect(planMa2SongSync(input, remote).conflicts).toMatchObject([{ field: 'cue-name', cue: '1.000', local: '电脑修改', console: '控台修改' }]);
  input.points[0]!.name = '段落 1'; expect(planMa2SongSync(input, remote)).toMatchObject({ name: '控台歌名', changes: [] });
});
it('控台删除回传对应点位，软件删除必须核对清单；远端修改后旧删除清单失效', () => {
  const { input, xml } = linked(); const remote = editMa2SongSequence(xml, '歌曲', [], ['1.000']);
  expect(planMa2SongSync(input, remote).removed).toEqual(['point-0']);
  input.points.shift(); expect(planMa2SongSync(input, xml).conflicts).toMatchObject([{ field: 'cue-deletion', cue: '1.000' }]);
  input.confirmedDeletions = ['1.000']; expect(planMa2SongSync(input, xml).deletions).toEqual(['1.000']);
  expect(planMa2SongSync(input, editMa2SongSequence(xml,'歌曲',[{cue:'1.000',name:'新改'}],[])).conflicts).toMatchObject([{ field: 'cue-deletion', console: '新改' }]);
});
it('缺失序列拒绝重建，延迟组合不能静默压平，控台新增 Cue 保留原时间未猜测', () => {
  const { input, xml } = linked(); expect(() => planMa2SongSync(input, null)).toThrow('已消失');
  input.points[0]!.cues[0]!.delayMs = 100; expect(() => planMa2SongSync(input, xml)).toThrow('包含延迟');
  input.points[0]!.cues[0]!.delayMs = 0;
  const added = editMa2SongSequence(xml, '歌曲', [{cue:'41.000',name:'控台新建',sources:[]}],[]);
  expect(planMa2SongSync(input, added)).toMatchObject({ changes: [], deletions: [] });
  expect(inspectMa2SequenceXml(added).sequences[0]?.cues).toHaveLength(41);
  input.points.push({ id: 'adopted', name: '控台新建', atMs: 41000, cues: [{ sequence: 9000, cue: '41', delayMs: 0 }] });
  const adopted = planMa2SongSync(input, added);
  expect(adopted.points.at(-1)).toEqual({ id: 'adopted', cue: '41.000' });
  input.binding = { ...input.binding!, baselineXml: added, points: adopted.points };
  input.points.at(-1)!.name = '电脑修改';
  const changedAgain = editMa2SongSequence(added, '歌曲', [{ cue: '41.000', name: '控台再修改' }], []);
  expect(planMa2SongSync(input, changedAgain).conflicts).toMatchObject([{ field: 'cue-name', cue: '41.000' }]);
});
it('冲突只保留对应字段，其他 Cue 继续同步，选择核对后的版本再写入', () => {
  const { input, xml } = linked();
  input.points[0]!.name = '软件名称'; input.points[1]!.name = '其他正常修改';
  const remote = editMa2SongSequence(xml, '歌曲', [{ cue: '1.000', name: '控台名称' }], []);
  const plan = planMa2SongSync(input, remote);
  expect(plan.changes).toEqual([{ cue: '2.000', name: 'QiTaZhengChangXiuGai' }]);
  const issue = plan.conflicts[0]!;
  input.conflictResolutions = [{ key: issue.key, token: issue.token, choice: 'local' }];
  expect(planMa2SongSync(input, remote).changes[0]).toEqual({ cue: '1.000', name: 'RuanJianMingCheng' });
  input.conflictResolutions[0]!.choice = 'console';
  expect(planMa2SongSync(input, remote).conflicts).toEqual([]);
  const changedAgain = editMa2SongSequence(remote, '歌曲', [{ cue: '1.000', name: '控台第三个名称' }], []);
  expect(planMa2SongSync(input, changedAgain).conflicts[0]?.token).not.toBe(issue.token);
});
it('保存重开后仍保留未解决字段的旧基线，控台实际修改不会被吞掉', () => {
  const { input, xml } = linked();
  input.points[0]!.name = '软件名称'; input.points[1]!.name = '另一改名';
  const remote = editMa2SongSequence(xml, '歌曲', [{ cue: '1.000', name: '控台名称' }], []);
  const plan = planMa2SongSync(input, remote);
  const verified = editMa2SongSequence(remote, plan.name, plan.changes, []);
  const baseline = ma2SongSyncBaseline(input, verified, plan.conflicts);
  expect(inspectMa2SequenceXml(baseline).sequences[0]?.cues.slice(0, 2).map(cue => cue.name)).toEqual(['DuanLuo 1', 'LingYiGaiMing']);
  input.binding = { ...input.binding!, baselineXml: baseline };
  const reopened = planMa2SongSync(input, verified);
  expect(reopened.changes).toEqual([]);
  expect(reopened.conflicts).toMatchObject([{ field: 'cue-name', local: '软件名称', console: '控台名称' }]);
});
it('软件删除经当前清单核对可以删除；采用控台则保留对象并解除本地时间线关联', () => {
  const { input, xml } = linked(); input.points.shift();
  const remote = editMa2SongSequence(xml, '歌曲', [{ cue: '1.000', name: '控台新灯光' }], []);
  const issue = planMa2SongSync(input, remote).conflicts[0]!;
  input.conflictResolutions = [{ key: issue.key, token: issue.token, choice: 'local' }];
  expect(planMa2SongSync(input, remote).deletions).toEqual(['1.000']);
  input.conflictResolutions[0]!.choice = 'console';
  const kept = planMa2SongSync(input, remote);
  expect(kept.deletions).toEqual([]); expect(kept.points.some(point => point.id === 'point-0')).toBe(false);
});
it('native Import 的节点顺序与空默认时间不影响内容指纹，实际 timing 修改仍可检测', () => {
  const base = '<MA xmlns="http://schemas.malighting.de/grandma2/xml/MA" major_vers="3" minor_vers="7" stream_vers="0"><Sequ index="0"><Cue index="1" name="原名"><Number number="1" sub_number="0"/><CuePart index="0" name="原名"/><CueDatas><CueData><Channel fixture_id="1" attribute_name="DIM"/><Value>70</Value></CueData></CueDatas></Cue></Sequ></MA>';
  const native = base.replace('<CuePart index="0" name="原名"/>', '').replace('</CueDatas>', '</CueDatas><CuePart index="0" name="新名"><CuePartPresetTiming><PresetTiming/><PresetTiming/></CuePartPresetTiming></CuePart>');
  expect(ma2SequenceCueFingerprints(base, false)).toEqual(ma2SequenceCueFingerprints(native, false));
  expect(ma2SequenceCueFingerprints(base)).not.toEqual(ma2SequenceCueFingerprints(native));
  expect(ma2SequenceCueFingerprints(native.replace('<PresetTiming/>', '<PresetTiming fade="2"/>'), false)).not.toEqual(ma2SequenceCueFingerprints(base, false));
});
it('删除中间步后内部index连续，显示Cue编号与名称保持原对应关系', () => {
  const { xml } = linked();
  const edited = editMa2SongSequence(xml, '歌曲', [], ['3.000']);
  const cues = inspectMa2SequenceXml(edited).sequences[0]!.cues;
  expect(cues[2]).toMatchObject({ index: 3, number: '4.000', name: 'DuanLuo 4' });
  expect(cues.at(-1)).toMatchObject({ index: 39, number: '40.000', name: 'DuanLuo 40' });
});
it('已绑定歌曲清空先逐项核对，全部确认后保留空序列；未绑定空曲不能新建', () => {
  const { input, xml } = linked(); input.points = [];
  expect(ma2SongSyncRequestSchema.parse(input).points).toEqual([]);
  const review = planMa2SongSync(input, xml);
  expect(review.deletions).toEqual([]); expect(review.conflicts).toHaveLength(40);
  input.conflictResolutions = review.conflicts.map(conflict => ({ key: conflict.key, token: conflict.token, choice: 'local' }));
  const cleared = planMa2SongSync(input, xml);
  expect(cleared.conflicts).toEqual([]); expect(cleared.deletions).toHaveLength(40);
  expect(cleared.points).toEqual([]);
  const empty = editMa2SongSequence(xml, input.name, [], cleared.deletions);
  expect(inspectMa2SequenceXml(empty).sequences[0]).toMatchObject({ number: 9000, name: '歌曲', cues: [] });
  expect(ma2SongSyncRequestSchema.safeParse({ ...input, binding: undefined }).success).toBe(false);
});
it('原生 Cue 名称只在 Part 0 时，清空清单回读基线不使删除确认令牌失效', () => {
  const { input, xml } = linked();
  const native = xml.replace(/(<Cue index="\d+") name="[^"]*"/g, '$1');
  input.binding!.baselineXml = native; input.points = [];
  const review = planMa2SongSync(input, native);
  input.binding!.baselineXml = ma2SongSyncBaseline(input, native, review.conflicts);
  input.conflictResolutions = review.conflicts.map(conflict => ({ key: conflict.key, token: conflict.token, choice: 'local' }));
  const confirmed = planMa2SongSync(input, native);
  expect(confirmed.conflicts).toEqual([]);
  expect(confirmed.deletions).toHaveLength(40);
});
