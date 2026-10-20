import { expect, it } from 'vitest';
import { createLightingDocument, type Ma2SongSyncResult } from '@tb/schema';
import { applyMa2SongReadback, ma2SongPoints } from './ma2-song-sequence';

function sample() {
  const document = createLightingDocument();
  document.outputMode = 'network';
  document.tracks = [{ id: 'track', name: '灯光', kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false, channel: 1, controller: 7, portProfileId: '', noteNames: {}, clips: [{
    id: 'clip', name: '编排', start: 0, duration: 10000, timeLock: 'time', muted: false, events: [
      { id: 'first', kind: 'ma2', at: 0, label: '软件名称', action: 'goto', executor: '', sequence: 2, cue: '1', runMode: 'independent' },
      { id: 'second', kind: 'ma2', at: 1000, label: '第二步', action: 'goto', executor: '', sequence: 2, cue: '2', runMode: 'independent' }
    ]
  }] }];
  const binding = { endpoint: '192.0.2.1:30000', show: 'Show', layout: null, executor: '1000.101', sequence: 9000, name: '歌曲', baselineXml: '<MA/>', points: [{ id: 'first', cue: '1.000' }, { id: 'second', cue: '2.000' }] };
  const result: Ma2SongSyncResult = { binding, library: { directory: { show: 'Show', generation: 'g', version: '3.7.0.5', entries: [] }, readAt: '2026-10-20T00:00:00.000Z',
    sequences: [{ sequence: 9000, name: '歌曲', cues: [{ index: 1, number: '1.000', name: '控台名称' }, { index: 2, number: '2.000', name: '第二步' }] }], fixtureUsage: [], errors: [] },
    layout: null, removed: [], backupFile: '', changed: false };
  return { document, result };
}
it('名称冲突只保留软件名称，已回读内容仍关联控台原 Cue', () => {
  const { document, result } = sample();
  result.conflicts = [{ key: 'first:cue-name', field: 'cue-name', pointId: 'first', cue: '1.000', baseline: '旧名称', local: '软件名称', console: '控台名称', token: '0'.repeat(64) }];
  const merged = ma2SongPoints(applyMa2SongReadback(document, ma2SongPoints(document), result));
  expect(merged[0]).toMatchObject({ name: '软件名称', cues: [{ sequence: 9000, cue: '1.000' }] });
  expect(merged[1]?.cues).toEqual([{ sequence: 9000, cue: '2.000', delayMs: 0 }]);
});
it('内容冲突保留软件来源组合，已解决的名称可回读且其他步继续同步', () => {
  const { document, result } = sample();
  result.conflicts = [{ key: 'first:cue-content', field: 'cue-content', pointId: 'first', cue: '1.000', baseline: '原内容', local: '软件新来源', console: '控台新内容', token: '0'.repeat(64) }];
  const merged = ma2SongPoints(applyMa2SongReadback(document, ma2SongPoints(document), result));
  expect(merged[0]).toMatchObject({ name: '控台名称', cues: [{ sequence: 2, cue: '1' }] });
  expect(merged[1]?.cues).toEqual([{ sequence: 9000, cue: '2.000', delayMs: 0 }]);
});
it('等待回读期间的新编辑保留，不被旧请求覆盖', () => {
  const { document, result } = sample();
  const observed = ma2SongPoints(document);
  const event = document.tracks[0]!.clips[0]!.events[0]!;
  if (event.kind !== 'ma2') throw new Error('fixture is not an MA2 event');
  event.label = '刚刚编辑';
  const merged = ma2SongPoints(applyMa2SongReadback(document, observed, result));
  expect(merged[0]).toMatchObject({ name: '刚刚编辑', cues: [{ sequence: 2, cue: '1' }] });
});
