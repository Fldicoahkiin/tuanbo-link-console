import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { Ma2SongBinding, Ma2SongPoint } from '@tb/schema';
import { ma2SongCreationStages, recoverMa2SongCreation } from './ma2-song-recovery';
import { editMa2SongSequence, emptyMa2SequenceXml, inspectMa2SequenceXml } from './ma2-timecode-xml';
import { planMa2SongSync } from './ma2-song-plan';
import { randomUUID } from 'node:crypto';

const source = readFileSync(new URL('./fixtures/ma2-cue-attributes-3.7.xml', import.meta.url), 'utf8');
const cues = [1, 2, 3].map(number => ({ cue: `${number}.000`, name: `步骤 ${number}` }));
const skeleton = editMa2SongSequence(emptyMa2SequenceXml(9000, '3.7.0.5'), '歌曲', cues.map(cue => ({ ...cue, sources: [] })), []);
const desired = editMa2SongSequence(skeleton, '歌曲', cues.map(cue => ({ ...cue, sources: [{ xml: source, cue: '1.000' }] })), []);
const points: Ma2SongPoint[] = cues.map((cue, index) => ({ id: `p${index}`, name: cue.name, atMs: index * 1000, cues: [{ sequence: 2, cue: '1.000', delayMs: 0 }] }));
const binding: Ma2SongBinding = { endpoint: '192.0.2.1:30000', show: 'test', layout: null, executor: '1000.101', sequence: 9000, name: '歌曲', baselineXml: desired, points: cues.map((cue, index) => ({ id: `p${index}`, cue: cue.cue })) };

it('中断后回读已完成步骤，只续写未完成步骤，沿用原序列与 Cue 位置', () => {
  const partial = editMa2SongSequence(skeleton, '歌曲', [{ ...cues[0]!, sources: [{ xml: source, cue: '1.000' }] }], []);
  const recovered = recoverMa2SongCreation(binding, skeleton, partial, points);
  expect(recovered.points[0]?.cues).toEqual([{ sequence: 9000, cue: '1.000', delayMs: 0 }]);
  expect(recovered.points.slice(1)).toEqual(points.slice(1));
  expect(recoverMa2SongCreation(binding, skeleton, desired, points).points.every(point => point.cues[0]?.sequence === 9000)).toBe(true);
});
it('中断后控台另删 Cue 时交给三方合并核对，额外 Cue 原样保留', () => {
  const changed = editMa2SongSequence(skeleton, '歌曲', [], ['1.000']);
  const recovered = recoverMa2SongCreation(binding, skeleton, changed, points);
  const request = { network: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' }, expectedSource: { show: 'test', generation: 'g', version: '3.7.0.5' }, projectId: randomUUID(), itemId: 'song', requestId: randomUUID(), settings: { layout: 1000, name: '歌曲', nextSequence: 9000, columns: 8 }, name: '歌曲', ...recovered };
  expect(planMa2SongSync(request, changed).removed).toEqual(['p0']);
  const extra = editMa2SongSequence(skeleton, '歌曲', [{ cue: '100.000', name: '控台新编', sources: [{ xml: source, cue: '1.000' }] }], []);
  expect(inspectMa2SequenceXml(recoverMa2SongCreation(binding, skeleton, extra, points).binding.baselineXml).sequences[0]?.cues.at(-1)).toMatchObject({ number: '100.000', name: '控台新编' });
});
it('中断后软件新增、改名、清空及换内容均保持原有点位编号', () => {
  const partial = editMa2SongSequence(skeleton, '歌曲', [{ ...cues[0]!, sources: [{ xml: source, cue: '1.000' }] }], []);
  const edited = structuredClone(points);
  edited[0]!.name = '离线新名称'; edited[0]!.cues = [];
  edited[1]!.cues = [{ sequence: 2, cue: '2.000', delayMs: 0 }];
  edited.push({ id: 'new', name: '新增', atMs: 5000, cues: [] });
  const recovered = recoverMa2SongCreation(binding, skeleton, partial, edited, points);
  expect(recovered.points).toEqual(edited);
  const plan = planMa2SongSync({ network: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' }, expectedSource: { show: 'test', generation: 'g', version: '3.7.0.5' }, projectId: randomUUID(), itemId: 'song', requestId: randomUUID(), settings: { layout: 1000, name: '歌曲', nextSequence: 9000, columns: 8 }, name: '歌曲', ...recovered }, partial);
  expect(plan.points).toEqual([...binding.points, { id: 'new', cue: '4.000' }]);
  expect(plan.changes[0]).toEqual({ cue: '1.000', name: 'LiXianXinMingCheng', refs: [] });
});
it('多来源 Cue 在第一笔 Copy 后断开，通过事先保存的阶段指纹核对后继续', () => {
  const simple = `<MA xmlns="http://schemas.malighting.de/grandma2/xml/MA" major_vers="3" minor_vers="7" stream_vers="0"><Sequ index="1"><Cue index="1"><Number number="1" sub_number="0"/><CuePart index="0"/><CueDatas><CueData><Channel fixture_id="1" attribute_name="DIM"/><Value>70</Value></CueData></CueDatas></Cue><Cue index="2"><Number number="2" sub_number="0"/><CuePart index="0"/><CueDatas><CueData><Channel fixture_id="1" attribute_name="PAN"/><Value>40</Value></CueData></CueDatas></Cue></Sequ></MA>`;
  const merged = editMa2SongSequence(skeleton, '歌曲', [{ ...cues[0]!, sources: [{ xml: simple, cue: '1.000' }, { xml: simple, cue: '2.000' }] }], []);
  const original = [{ ...points[0]!, cues: [{ sequence: 2, cue: '1.000', delayMs: 0 }, { sequence: 2, cue: '2.000', delayMs: 0 }] }, ...points.slice(1)];
  const partial = editMa2SongSequence(skeleton, '歌曲', [{ ...cues[0]!, sources: [{ xml: simple, cue: '1.000' }] }], []);
  const stages = ma2SongCreationStages(skeleton, [{ ...cues[0]!, sources: [{ xml: simple, cue: '1.000' }, { xml: simple, cue: '2.000' }] }]);
  expect(recoverMa2SongCreation({ ...binding, baselineXml: merged }, skeleton, partial, original, original, stages).points[0]?.cues).toEqual(original[0]!.cues);
});
it('已有绑定替换内容后丢回包，回读确认后不把自己的写入误报成双方冲突', () => {
  const original: Ma2SongPoint[] = points.map(point => ({ ...point, cues: [] }));
  const pending = structuredClone(original); pending[0]!.cues = [{ sequence: 2, cue: '1.000', delayMs: 0 }];
  const intended = editMa2SongSequence(skeleton, '歌曲', [{ ...cues[0]!, sources: [{ xml: source, cue: '1.000' }] }], []);
  const draft = { ...binding, baselineXml: intended };
  const beforeWrite = recoverMa2SongCreation(draft, skeleton, skeleton, pending, pending);
  expect(beforeWrite.points[0]?.cues).toEqual(pending[0]!.cues);
  const afterWrite = recoverMa2SongCreation(draft, skeleton, intended, pending, pending);
  expect(afterWrite.points[0]?.cues).toEqual([{ sequence: 9000, cue: '1.000', delayMs: 0 }]);
});
it('批量改名中途丢回包只续未送达名称，不撤销已完成改名', () => {
  const original = points.map((point, index) => ({ ...point, cues: [{ sequence: 9000, cue: `${index + 1}.000`, delayMs: 0 }] }));
  const pending = original.map(point => ({ ...point, name: `${point.name} 新名称` }));
  const intended = editMa2SongSequence(desired, '歌曲', pending.map((point, index) => ({ cue: `${index + 1}.000`, name: point.name })), []);
  const partial = editMa2SongSequence(desired, '歌曲', [{ cue: '1.000', name: pending[0]!.name }], []);
  const recovered = recoverMa2SongCreation({ ...binding, baselineXml: intended }, desired, partial, pending, pending);
  const names = inspectMa2SequenceXml(recovered.binding.baselineXml).sequences[0]!.cues.map(cue => cue.name);
  expect(names).toEqual([pending[0]!.name, original[1]!.name, original[2]!.name]);
  expect(recovered.points.map(point => point.name)).toEqual(pending.map(point => point.name));
});
it('写入后丢回包再撤销替换，self 引用恢复写前内容，不能采纳刚写入的新内容', () => {
  const pending = structuredClone(points);
  pending[0]!.cues = [];
  const intended = editMa2SongSequence(desired, '歌曲', [{ cue: '1.000', name: pending[0]!.name, sources: [] }], []);
  const undone = structuredClone(pending);
  undone[0]!.cues = [{ sequence: binding.sequence, cue: '1.000', delayMs: 0 }];
  const recovered = recoverMa2SongCreation({ ...binding, baselineXml: intended }, desired, intended, undone, pending);
  expect(recovered.restores).toEqual([{ cue: '1.000', xml: desired }]);
  const request = { network: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' }, expectedSource: { show: 'test', generation: 'g', version: '3.7.0.5' }, projectId: randomUUID(), itemId: 'song', requestId: randomUUID(), settings: { layout: 1000, name: '歌曲', nextSequence: 9000, columns: 8 }, name: '歌曲', binding: recovered.binding, points: recovered.points };
  const plan = planMa2SongSync(request, intended, recovered.restores.map(value => value.cue));
  expect(plan.conflicts).toEqual([]);
  expect(plan.changes[0]).toMatchObject({ cue: '1.000', refs: undone[0]!.cues, restore: true });
});
it('已核对冲突在另一步写入中断后仍保留，不能把控台现值当成软件已确认值', () => {
  const remote = editMa2SongSequence(skeleton, '歌曲', [{ cue: '1.000', name: '控台改名', sources: [] }], []);
  const pending = structuredClone(points); pending[0]!.name = '软件改名';
  const recovered = recoverMa2SongCreation(binding, remote, remote, pending, pending, {}, ['1.000'], ['1.000']);
  const actual = inspectMa2SequenceXml(recovered.binding.baselineXml).sequences[0]!.cues[0];
  expect(actual?.name).toBe('步骤 1');
  expect(recovered.points[0]?.cues).toEqual(pending[0]!.cues);
});
