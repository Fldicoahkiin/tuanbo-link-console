import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type Ma2SongSyncRequest } from '@tb/schema';
import { planMa2SongSync } from './ma2-song-plan';
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
  expect(report.cues).toHaveLength(40); expect(report.cues[39]).toMatchObject({ number: '40.000', name: '段落 40' });
  const next = planMa2SongSync(input, xml); expect(next.changes).toEqual([]); expect(next.points).toEqual(input.binding?.points);
});
it('软件重命名写出，控台重命名回读，同一 Cue 双方修改明确冲突', () => {
  const { input, xml } = linked(); input.points[0]!.name = '电脑修改';
  expect(planMa2SongSync(input, xml).changes).toEqual([{ cue: '1.000', name: '电脑修改' }]);
  const remote = editMa2SongSequence(xml, '控台歌名', [{ cue: '1.000', name: '控台修改' }], []);
  expect(() => planMa2SongSync(input, remote)).toThrow('两边同时修改');
  input.points[0]!.name = '段落 1'; expect(planMa2SongSync(input, remote)).toMatchObject({ name: '控台歌名', changes: [] });
});
it('控台删除回传对应点位，软件删除必须核对清单；远端修改后旧删除清单失效', () => {
  const { input, xml } = linked(); const remote = editMa2SongSequence(xml, '歌曲', [], ['1.000']);
  expect(planMa2SongSync(input, remote).removed).toEqual(['point-0']);
  input.points.shift(); expect(() => planMa2SongSync(input, xml)).toThrow('待核对删除清单');
  input.confirmedDeletions = ['1.000']; expect(planMa2SongSync(input, xml).deletions).toEqual(['1.000']);
  expect(() => planMa2SongSync(input, editMa2SongSequence(xml,'歌曲',[{cue:'1.000',name:'新改'}],[]))).toThrow('不能按旧清单删除');
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
  expect(() => planMa2SongSync(input, changedAgain)).toThrow('两边同时修改');
});
