import { expect, it } from 'vitest';
import { createLightingDocument, lightingDocumentSchema, type LightingTrack } from '@tb/schema';
import { placeConsoleCue } from './lighting-cue-placement';
import { applyFirstTrackCues, firstTrackCuePlan, boundEmptyCuePoints, ma2PoolSequencesToRoute, routeBoundEmptyCues, routeMa2Tracks, unboundMa2Tracks } from './ma2-track-routing';
import { placeEmptyLightingCue } from './lighting-empty-cue';

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

it('外来素材、空点、旧版独立点回原第一轨，保留控台自己并行的轨道、Cue 身份和绝对时间', () => {
  const doc = fixture();
  const primary = doc.tracks[0]!;
  const parallel = { ...structuredClone(primary), id: 'parallel', clips: [{ ...structuredClone(primary.clips[0]!), id: 'pc', events: [{ id: 'p', kind: 'ma2' as const, action: 'goto' as const, at: 500, label: '现场', executor: '2.101', sequence: 55, cue: '2' }] }] };
  const binding = doc.ma2Bindings![0]!;
  doc.tracks.push(parallel);
  binding.baselineTracks = structuredClone(doc.tracks);
  binding.trackMappings = [primary, parallel].map((track, i) => ({ trackId: track.id, path: `Timecode:7/Track:${i}`, executor: `${i + 1}.101`, subtracks: [] }));
  binding.mappings = [{ eventId: 'event', trackId: primary.id, clipId: 'clip', path: 'Timecode:7/Track:0/SubTrack:0/Event:0', sequence: 10, cueIndex: 1, executor: '1.101' },
    { eventId: 'p', trackId: parallel.id, clipId: 'pc', path: 'Timecode:7/Track:1/SubTrack:0/Event:0', sequence: 55, cueIndex: 2, executor: '2.101' }];
  const source = placeConsoleCue(doc, { sequence: 55, cue: '2', executor: '2.101', name: '素材' }, 3100, 10000);
  const edited = placeEmptyLightingCue(source, 'empty', 4200, 10000);
  const plan = firstTrackCuePlan(edited)!;
  expect(plan).toMatchObject({ trackId: primary.id, executor: '1.101', expectedSequence: 10, points: [{ sources: [{ sequence: 55, cue: '2' }] }, { id: 'empty', sources: [] }] });
  const routed = applyFirstTrackCues(edited, plan, { sequence: 10, executor: '1.101', cues: ['7', '8'], backupFile: null });
  expect(routed.tracks.map(track => track.id)).toEqual([primary.id, parallel.id]);
  expect(routed.tracks[1]).toEqual(parallel);
  expect(routed.tracks[0]!.clips.flatMap(clip => clip.events)).toMatchObject([{ id: 'event' },
    { id: plan.points[0]!.id, executor: '1.101', sequence: 10, cue: '7', at: 3100 }, { id: 'empty', executor: '1.101', sequence: 10, cue: '8', at: 4200 }]);
  const oldTrack = source.tracks.at(-1)!;
  source.ma2Bindings![0]!.baselineTracks.push(structuredClone(oldTrack));
  source.ma2Bindings![0]!.mappings.push({ ...binding.mappings[1]!, eventId: oldTrack.clips[0]!.events[0]!.id, trackId: oldTrack.id, clipId: oldTrack.clips[0]!.id });
  expect(firstTrackCuePlan(source)?.points).toEqual([plan.points[0]]);
});
it('同一点的两份素材只写一个原生 Cue，延迟的下一步单独触发，重开仍保留源素材', () => {
  const doc = fixture();
  const first = doc.tracks[0]!;
  const binding = doc.ma2Bindings![0]!;
  binding.baselineTracks = [structuredClone(first)];
  binding.trackMappings = [{ trackId: first.id, path: 'Timecode:7/Track:0', executor: '1.101', subtracks: [] }];
  const parts = [{ id: 'secondary', sequence: 30, includeTracking: false, at: 3100, ingredientOrder: 1 }, { id: 'root', sequence: 20, includeTracking: true, at: 3100, ingredientOrder: 0 }, { id: 'later', sequence: 40, at: 4100, ingredientOrder: 2 }];
  for (const part of parts) {
    doc.tracks.push({ ...first, id: 'track-' + part.id, group: 'effect-canvas', clips: [{ ...first.clips[0]!, id: 'clip-' + part.id,
      events: [{ ...part, kind: 'ma2', action: 'goto', cue: '2', label: part.id, executor: '', effectGroupId: 'root' }] }] });
  }
  const plan = firstTrackCuePlan(doc)!;
  expect(plan.points).toEqual([{ id: 'root', sources: [{ sequence: 20, cue: '2', includeTracking: true }, { sequence: 30, cue: '2', includeTracking: false }] }, { id: 'later', sources: [{ sequence: 40, cue: '2' }] }]);
  const result = applyFirstTrackCues(doc, plan, { executor: '1.101', sequence: 10, cues: ['7', '8'], backupFile: null });
  const reopened = lightingDocumentSchema.parse(JSON.parse(JSON.stringify(result)));
  expect(reopened.tracks).toHaveLength(1);
  const events = reopened.tracks[0]!.clips.flatMap(clip => clip.events);
  expect(events.map(event => event.id)).toEqual(['event', 'root', 'later']);
  expect(events[1]).toMatchObject({ at: 3100, sequence: 10, cue: '7', sourceIngredients: [{ sequence: 20, cue: '2', includeTracking: true }, { sequence: 30, cue: '2', includeTracking: false }] });
  expect(events[2]).toMatchObject({ at: 4100, sequence: 10, cue: '8' });
});
it('混合执行器、空 Cue 和多条目标都不猜去向，仍能列出遗漏轨道', () => {
  const document = fixture();
  document.tracks[0]!.clips[0]!.events.push({ id: 'empty', kind: 'empty-cue', at: 2000, label: '待编灯' });
  expect(unboundMa2Tracks(routeMa2Tracks(document)).map(track => track.id)).toEqual(['new']);
  const multiple = fixture(); multiple.ma2Bindings!.push({ ...multiple.ma2Bindings![0]!, id: 'second', timecode: 9 });
  expect(routeMa2Tracks(multiple)).toEqual(multiple);
});

it('第二个空 Cue 沿用本曲序列，原 Cue 引用控台实际内容，素材照原目标运行', () => {
  const first = placeEmptyLightingCue(fixture(), 'a', 2400, 10000);
  expect(boundEmptyCuePoints(first)).toEqual([{ id: 'a', name: '', atMs: 2400, cues: [] }]);
  const sequence = { endpoint: 'console:30000', show: 'Show', name: 'TC 8 Cue', layout: null, sequence: 9510, executor: '1000.102',
    baselineXml: '<MA/>', points: [{ id: 'a', cue: '1.500' }] };
  const routed = routeBoundEmptyCues(first, sequence);
  const second = placeEmptyLightingCue(routed, 'b', 3300, 10000);
  expect(boundEmptyCuePoints(second)).toEqual([
    { id: 'a', name: '', atMs: 2400, cues: [{ sequence: 9510, cue: '1.500', delayMs: 0 }] },
    { id: 'b', name: '', atMs: 3300, cues: [] }
  ]);
  expect(() => routeBoundEmptyCues(second, sequence)).toThrow('没有读回');
  const done = routeBoundEmptyCues(second, { ...sequence, points: [...sequence.points, { id: 'b', cue: '2' }] });
  expect(done.tracks[0]).toEqual(first.tracks[0]);
  expect(boundEmptyCuePoints(done)).toEqual([]);
  expect(done.ma2Bindings?.[0]?.timecode).toBe(8);
  expect(done.tracks.at(-1)?.clips[0]?.events.at(-1)).toMatchObject({ id: 'b', at: 3300, executor: '1000.102', sequence: 9510, cue: '2' });
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
