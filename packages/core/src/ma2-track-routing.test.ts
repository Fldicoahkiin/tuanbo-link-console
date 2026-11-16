import { expect, it } from 'vitest';
import { createLightingDocument, type LightingTrack } from '@tb/schema';
import { routeMa2Tracks, unboundMa2Tracks } from './ma2-track-routing';

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
