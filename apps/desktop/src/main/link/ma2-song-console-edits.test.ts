import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { Ma2SongBinding, Ma2SongSyncRequest } from '@tb/schema';
import { mergeMa2SongConsoleEdits } from './ma2-song-console-edits';
import { ma2SongTimecodeXml } from './ma2-song-timecode';
import { editMa2SongSequence, emptyMa2SequenceXml, inspectMa2SequenceXml } from './ma2-timecode-xml';

const existing = readFileSync(new URL('./fixtures/ma2-timecode-onpc-3.7-100.xml', import.meta.url), 'utf8');
const revision = (xml: string): string => createHash('sha256').update(xml.replace(/<Info\b[^>]*\/>/g, '').replace(/>\s+</g, '><').trim()).digest('hex');
const sequence = (cues: Array<[string, string]>): string => editMa2SongSequence(emptyMa2SequenceXml(9950, '3.7.0.5'), 'GeQu', cues.map(([cue, name]) => ({ cue, name, sources: [] })), []);
/** The song's show as the console holds it: one Goto per [cue, time in ms]. */
function show(sequenceXml: string, fired: Array<[string, number]>): string {
  const cues = inspectMa2SequenceXml(sequenceXml).sequences[0]!.cues;
  return ma2SongTimecodeXml(existing, 9907, { name: 'GeQu', startMs: 480000, executor: '1000.101', executorName: 'GeQu 1000.101', sequence: 9950,
    cues: fired.map(([number, atMs]) => { const cue = cues.find(value => Number(value.number) === Number(number))!; return { atMs, cueIndex: cue.index, number: cue.number, name: cue.name }; }) });
}
const baseXml = sequence([['1.000', 'KaiChang'], ['2.000', 'FuGe'], ['3.000', 'JieWei']]);
const written = show(baseXml, [['1', 0], ['2', 1000], ['3', 2000]]);
const binding: Ma2SongBinding = { endpoint: '192.0.2.1:30000', show: 'test', layout: null, executor: '1000.101', sequence: 9950, name: 'GeQu', baselineXml: baseXml,
  points: [{ id: 'a', cue: '1.000', atMs: 0 }, { id: 'b', cue: '2.000', atMs: 1000 }, { id: 'c', cue: '3.000', atMs: 2000 }],
  timecode: { number: 9907, offset: 14400, slot: 'TC Slot 2', revision: revision(written) } };
const local = (): Ma2SongSyncRequest['points'] => [
  { id: 'a', name: '开场', atMs: 0, cues: [{ sequence: 9950, cue: '1.000', delayMs: 0 }] },
  { id: 'b', name: '副歌', atMs: 1000, cues: [{ sequence: 9950, cue: '2.000', delayMs: 0 }] },
  { id: 'c', name: '结尾', atMs: 2000, cues: [{ sequence: 9950, cue: '3.000', delayMs: 0 }] }
];

it('控台上没改：什么都不读回', () => {
  const merged = mergeMa2SongConsoleEdits(binding, local(), baseXml, written);
  expect(merged.edits).toEqual({ moved: [], removed: [], added: [] });
  expect(merged.points).toEqual(local());
});

it('控台上挪了时间、删了触发、给控台新录的 Cue 加了触发：联动台跟着挪、删、加；只删触发的 Cue 留在序列里', () => {
  const remote = sequence([['1.000', 'KaiChang'], ['2.000', 'FuGe'], ['3.000', 'JieWei'], ['4.000', 'XinDeng']]);
  const merged = mergeMa2SongConsoleEdits(binding, local(), remote, show(remote, [['1', 0], ['2', 1500], ['4', 3000]]), () => 'new');
  expect(merged.edits).toEqual({ moved: [{ id: 'b', atMs: 1500 }], removed: ['c'], added: [{ id: 'new', name: 'XinDeng', atMs: 3000, cue: '4.000' }] });
  expect(merged.points.map(point => [point.id, point.atMs, point.cues[0]!.cue])).toEqual([['a', 0, '1.000'], ['b', 1500, '2.000'], ['new', 3000, '4.000']]);
  // The removed point leaves the base, so planning never frees (deletes) Cue 3; the added one is taken over as it is.
  expect(merged.binding.points).toEqual([{ id: 'a', cue: '1.000', atMs: 0 }, { id: 'b', cue: '2.000', atMs: 1500 }]);
});

it('控台上删了 Cue：联动台没动过这个点就跟着删；联动台改过名字、时间或内容的点以联动台为准，下次写回', () => {
  const remote = sequence([['1.000', 'KaiChang'], ['3.000', 'JieWei']]);
  expect(mergeMa2SongConsoleEdits(binding, local(), remote, null).edits.removed).toEqual(['b']);
  for (const change of [{ name: '副歌二' }, { atMs: 1200 }, { cues: [{ sequence: 12, cue: '1.000', delayMs: 0 }] }]) {
    const points = local().map(point => point.id === 'b' ? { ...point, ...change } : point);
    const merged = mergeMa2SongConsoleEdits(binding, points, remote, null);
    expect(merged.edits.removed).toEqual([]); expect(merged.points).toEqual(points);
  }
});

it('两边都挪了同一个点：以联动台为准；只改了名字的点仍然接受控台挪的时间；同一个 Cue 在节目里触发两次时不猜', () => {
  const moved = show(baseXml, [['1', 0], ['2', 1500], ['3', 2600]]);
  const points = local().map(point => point.id === 'b' ? { ...point, atMs: 1200 } : point.id === 'c' ? { ...point, name: '尾声' } : point);
  const merged = mergeMa2SongConsoleEdits(binding, points, baseXml, moved);
  expect(merged.edits.moved).toEqual([{ id: 'c', atMs: 2600 }]);
  expect(merged.points.find(point => point.id === 'b')!.atMs).toBe(1200);
  expect(mergeMa2SongConsoleEdits(binding, local(), baseXml, show(baseXml, [['1', 0], ['2', 1500], ['2', 1800], ['3', 2000]])).edits).toEqual({ moved: [], removed: [], added: [] });
});

it('不到一帧的差别不算挪动；控台上的时间按帧换算成毫秒', () => {
  const points = local().map(point => point.id === 'b' ? { ...point, atMs: 1010 } : point);
  const merged = mergeMa2SongConsoleEdits(binding, points, baseXml, show(baseXml, [['1', 0], ['2', 1001], ['3', 2033.4]]));
  expect(merged.edits.moved).toEqual([{ id: 'c', atMs: 61 * 1000 / 30 }]);
});
