import { expect, it } from 'vitest';
import { createLightingDocument, type LightingTrack } from '@tb/schema';
import { placeConsoleCue } from './lighting-cue-placement';
import { ma2PoolSequencesToRoute, routeMa2Tracks, unboundMa2Tracks } from './ma2-track-routing';

function fixture() {
  const document = createLightingDocument();
  const track: LightingTrack = { id: 'new', name: '新加灯光', kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false, channel: 1, controller: 7, portProfileId: '', noteNames: {},
    clips: [{ id: 'clip', name: 'Cue', start: 0, duration: 10000, timeLock: 'time', muted: false, events: [{ id: 'event', kind: 'ma2', action: 'goto', sequence: 10, cue: '1', executor: '1.101', at: 1000, label: '开场' }] }] };
  document.tracks = [track];
  document.ma2Bindings = [{ id: 'binding', timecode: 8, name: '原时间线', sourceXml: '<MA/>', readAt: '2026-11-16T00:00:00Z', baselineTracks: [], mappings: [] }];
  return document;
}
it('新增轨道有明确执行器就写入原时间线，反复编辑不重复登记', () => {
  const document = fixture();
  const routed = routeMa2Tracks(document);
  expect(routed.ma2Bindings![0]!.pendingTracks).toEqual([{ trackId: 'new', executor: '1.101', executorName: '执行器 1.101' }]);
  expect(unboundMa2Tracks(routed)).toEqual([]);
  expect(routeMa2Tracks(routed)).toEqual(routed);
  expect(document.ma2Bindings![0]!.pendingTracks).toBeUndefined();
});
it('混合执行器、空 Cue 和多条目标都不猜去向，仍能列出遗漏轨道', () => {
  const document = fixture();
  document.tracks[0]!.clips[0]!.events.push({ id: 'empty', kind: 'empty-cue', at: 2000, label: '待编灯' });
  expect(unboundMa2Tracks(routeMa2Tracks(document)).map(track => track.id)).toEqual(['new']);
  const multiple = fixture(); multiple.ma2Bindings!.push({ ...multiple.ma2Bindings![0]!, id: 'second', timecode: 9 });
  expect(routeMa2Tracks(multiple)).toEqual(multiple);
});

it('旧工程六条素材轨道按各自的序列找到执行器；同一素材再次拖入沿用已确认轨道', () => {
  const document = fixture();
  document.tracks = [];
  const cue = (n: number) => ({ sequence: n, cue: '1.000', executor: '', name: '亮灯' });
  const sequences = [1, 303, 990, 3001, 9000, 9999];
  const edited = sequences.reduce((doc, n, i) => placeConsoleCue(doc, cue(n), i * 200, 10000), document);
  expect(ma2PoolSequencesToRoute(edited)).toEqual(sequences);
  const routes = sequences.map((sequence, i) => ({ sequence, executor: `999.${101 + i}`, executorName: `控台序列 ${sequence}` }));
  const routed = routeMa2Tracks(edited, routes);
  expect(routed.ma2Bindings![0]!.pendingTracks?.map(track => track.executorName)).toEqual(routes.map(route => route.executorName));
  const twice = placeConsoleCue(routed, cue(9999), 2000, 10000);
  expect(twice.tracks).toHaveLength(6);
  expect(twice.tracks.at(-1)!.clips[0]!.events.at(-1)).toMatchObject({ executor: '999.106', cue: '1.000' });
  expect(ma2PoolSequencesToRoute(twice)).toEqual([]);
  expect(unboundMa2Tracks(edited)).toHaveLength(6);
});
