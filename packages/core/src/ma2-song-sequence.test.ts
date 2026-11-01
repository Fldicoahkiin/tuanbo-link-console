import { expect, it } from 'vitest';
import { createLightingDocument, type Ma2SongSyncResult } from '@tb/schema';
import { applyMa2SongReadback, ma2SongPoints } from './ma2-song-sequence';

function sample() {
  const document = createLightingDocument();
  document.tracks = [{ id: 'track', name: '灯光', kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false, channel: 1, controller: 7, portProfileId: '', noteNames: {}, clips: [{
    id: 'clip', name: '编排', start: 0, duration: 10000, timeLock: 'time', muted: false, events: [
      { id: 'first', kind: 'ma2', at: 0, label: '软件名称', action: 'goto', executor: '', sequence: 2, cue: '1', runMode: 'independent' },
      { id: 'second', kind: 'ma2', at: 1000, label: '第二步', action: 'goto', executor: '', sequence: 2, cue: '2', runMode: 'independent' }
    ]
  }] }];
  const binding = { endpoint: '192.0.2.1:30000', show: 'Show', layout: null, executor: '1000.101', sequence: 9000, name: '歌曲', baselineXml: '<MA/>', points: [{ id: 'first', cue: '1.000' }, { id: 'second', cue: '2.000' }] };
  const result: Ma2SongSyncResult = { binding, library: { directory: { show: 'Show', generation: 'g', version: '3.7.0.5', entries: [] }, readAt: '2026-10-20T00:00:00.000Z',
    sequences: [{ sequence: 9000, name: '歌曲', cues: [{ index: 1, number: '1.000', name: '控台名称' }, { index: 2, number: '2.000', name: '第二步' }] }], fixtureUsage: [], errors: [] },
    layout: null, backupFile: '', changed: false };
  return { document, result };
}
it('回读后每步都关联本曲控台序列的 Cue；控台上改过的名称回到软件', () => {
  const { document, result } = sample();
  const merged = ma2SongPoints(applyMa2SongReadback(document, ma2SongPoints(document), result));
  expect(merged[0]).toMatchObject({ name: '控台名称', cues: [{ sequence: 9000, cue: '1.000' }] });
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
it('控台保存的是中文转成的拼音时保留本地中文标签，控台上改过的名称才回读到软件', () => {
  const { document, result } = sample();
  result.library.sequences[0]!.cues = [{ index: 1, number: '1.000', name: 'RuanJianMingCheng' }, { index: 2, number: '2.000', name: 'NewOnConsole' }];
  const merged = ma2SongPoints(applyMa2SongReadback(document, ma2SongPoints(document), result));
  expect(merged.map(point => point.name)).toEqual(['软件名称', 'NewOnConsole']);
});
it('控台上挪的时间、删的 Cue、加的触发回到软件（2026-10-26 双向）；等待期间本地刚改的点不被覆盖', () => {
  const { document, result } = sample();
  const observed = ma2SongPoints(document);
  result.binding.points = [{ id: 'first', cue: '1.000' }, { id: 'added', cue: '3.000' }];
  result.library.sequences[0]!.cues.push({ index: 3, number: '3.000', name: 'XinDeng' });
  result.consoleEdits = { moved: [{ id: 'first', atMs: 500 }], removed: ['second'], added: [{ id: 'added', name: 'XinDeng', atMs: 4000, cue: '3.000' }] };
  const merged = ma2SongPoints(applyMa2SongReadback(document, observed, result));
  expect(merged.map(point => [point.id, point.atMs, point.cues[0]?.sequence, point.cues[0]?.cue])).toEqual([['first', 500, 9000, '1.000'], ['added', 4000, 9000, '3.000']]);
  // Applied twice (the command runs on the same document again), nothing doubles.
  const again = applyMa2SongReadback(applyMa2SongReadback(document, observed, result), observed, result);
  expect(ma2SongPoints(again).map(point => point.id)).toEqual(['first', 'added']);
  // A point edited here while the console was read keeps the local edit; the next sync writes it.
  const edited = sample().document; const first = edited.tracks[0]!.clips[0]!.events[0]!; first.at = 200;
  const kept = ma2SongPoints(applyMa2SongReadback(edited, observed, result));
  expect(kept.find(point => point.id === 'first')!.atMs).toBe(200);
  expect(kept.map(point => point.id)).toEqual(['first', 'added']);
});
it('控台上把点挪到片段起点之前：片段跟着提前，其他点时间不变', () => {
  const { document, result } = sample();
  const clip = document.tracks[0]!.clips[0]!; clip.start = 1000; clip.events[1]!.at = 500;
  const observed = ma2SongPoints(document);
  result.consoleEdits = { moved: [{ id: 'second', atMs: 200 }], removed: [], added: [] };
  const merged = ma2SongPoints(applyMa2SongReadback(document, observed, result));
  expect(merged.map(point => [point.id, point.atMs])).toEqual([['second', 200], ['first', 1000]]);
});
