import { expect, it } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, type Ma2Catalog } from '@tb/schema';
import { matchMa2Programs, sameMtcStart } from './ma2-program-matching';

type Show = { target: number; offset: string; times?: string[]; error?: string };
function setup(songs: Array<{ id: string; startMs?: number; durationMs?: number }>, shows: Show[]) {
  const project = createEmptyLinkProject('起始码');
  project.rundown = songs.map(song => ({ id: song.id, title: `歌曲${song.id}`, enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [],
    referenceAudio: { assetId: song.id, relativePath: `${song.id}.wav`, sha256: 'a'.repeat(64), durationMs: song.durationMs ?? 10000 },
    ...(song.startMs === undefined ? {} : { playback: { volume: 100, endAction: 'stop' as const, startMs: 0, endMs: 0, mtcOffsetMs: song.startMs, shortcut: '' } }) }));
  const catalog: Ma2Catalog = { directory: { show: 'show', version: '3.3.4', generation: '1', entries: [] }, readAt: new Date().toISOString(),
    entries: shows.map(show => ({ target: show.target, name: `灯光 ${show.target}`, eventCount: (show.times ?? ['30']).length, frameFormat: '30 FPS', offset: show.offset, slot: 'TC Slot 1',
      events: (show.times ?? ['30']).map(time => ({ path: time, time, action: 'Goto', executor: '1.1', cue: '1', name: 'Cue' })), error: show.error ?? null, warnings: [] })) };
  return { project, catalog };
}

it('只按 MTC 起始码对上：起点相同就配对，名字、事件位置、区间重叠都不参与（2026-10-26）', () => {
  const { project, catalog } = setup([{ id: 'A', startMs: 60000 }, { id: 'B', startMs: 55000, durationMs: 20000 }], [{ target: 1, offset: '1800' }, { target: 2, offset: '9000' }]);
  const match = matchMa2Programs(project, catalog);
  expect(match.pairs).toEqual({ 1: 'A' });
  expect(match.unresolved).toEqual([]);
});

it('差不到一帧算同一个起点，差一帧以上不算', () => {
  expect(sameMtcStart(11820020, 354600)).toBe(true);
  expect(sameMtcStart(60010, 1800)).toBe(true);
  expect(sameMtcStart(60034, 1800)).toBe(false);
  const { project, catalog } = setup([{ id: 'A', startMs: 60034 }], [{ target: 1, offset: '1800' }]);
  expect(matchMa2Programs(project, catalog).pairs).toEqual({});
});

it('控台事件在歌曲结束之后：照样对上，只提示', () => {
  const { project, catalog } = setup([{ id: 'A', startMs: 60000, durationMs: 10000 }], [{ target: 1, offset: '1800', times: ['30', '400'] }]);
  const match = matchMa2Programs(project, catalog);
  expect(match.pairs).toEqual({ 1: 'A' });
  expect(match.notes).toEqual([{ target: 1, text: expect.stringContaining('1 个事件在歌曲结束之后') as string }]);
});

it('两首歌起始码相同：不猜，列出两首歌', () => {
  const { project, catalog } = setup([{ id: 'A', startMs: 60000 }, { id: 'B', startMs: 60000 }], [{ target: 7, offset: '1800' }]);
  const match = matchMa2Programs(project, catalog);
  expect(match.pairs).toEqual({});
  expect(match.unresolved[0]?.reason).toContain('歌曲A'); expect(match.unresolved[0]?.reason).toContain('歌曲B');
});

it('控台上两个节目起点相同：这首歌标起点重复，哪个都不对上', () => {
  const { project, catalog } = setup([{ id: 'A', startMs: 60000 }], [{ target: 3, offset: '1800' }, { target: 1, offset: '1800' }]);
  const match = matchMa2Programs(project, catalog);
  expect(match.pairs).toEqual({});
  expect(match.duplicateStarts).toEqual({ A: [1, 3] });
});

it('没有起始码、缺文件、空节目和读取出错的条目不参与；自有时间码节目只属于它自己的歌', () => {
  const { project, catalog } = setup([{ id: 'A' }, { id: 'B', startMs: 60000 }, { id: 'C', startMs: 0 }], [{ target: 1, offset: '0' }, { target: 2, offset: '1800' }, { target: 3, offset: '0', error: '读取超时' }]);
  project.rundown[1]!.p1UnavailableSourceKey = 'missing';
  catalog.entries.push({ ...catalog.entries[0]!, target: 4, eventCount: 0, events: [] });
  project.rundown[2]!.lighting = { ...createLightingDocument(), consoleSong: { endpoint: '192.0.2.1:30000', show: 'show', layout: null, executor: '1000.101', sequence: 9000, name: 'C', baselineXml: '<MA/>', points: [],
    timecode: { number: 1, offset: 0, slot: 'TC Slot 2', revision: 'a'.repeat(64) } } };
  const match = matchMa2Programs(project, catalog);
  expect(match.pairs).toEqual({});
  expect(match.unresolved).toEqual([{ target: 3, reason: '读取超时' }]);
});

it('已放进 Cue 的节目：起点仍和歌曲、放 Cue 时的起点一致才对上；对不上时 Cue 保留并说明；另一个同起点的节目没读完整时先不换（2026-11-04 起读完整就自动换）', () => {
  const { project, catalog } = setup([{ id: 'A', startMs: 60000 }], [{ target: 1, offset: '1800' }, { target: 2, offset: '2100' }]);
  project.rundown[0]!.lighting = { ...createLightingDocument(), ma2Bindings: [{ id: 'binding', name: '灯光 1', timecode: 1, readAt: catalog.readAt, sourceXml: '<MA/>', baselineTracks: [], mappings: [], playback: 'editable', timeOriginMs: 60000 }] };
  expect(matchMa2Programs(project, catalog).pairs).toEqual({ 1: 'A' });
  project.rundown[0]!.lighting.ma2Bindings![0]!.timeOriginMs = 0;
  expect(matchMa2Programs(project, catalog).unresolved[0]?.reason).toContain('刷新');
  project.rundown[0]!.lighting.ma2Bindings![0]!.timeOriginMs = 60000;
  project.rundown[0]!.playback!.mtcOffsetMs = 70000;
  const moved = matchMa2Programs(project, catalog);
  expect(moved.pairs).toEqual({});
  expect(moved.unresolved.map(value => value.target)).toEqual([1, 2]);
  expect(moved.unresolved[1]?.reason).toContain('读完后自动换过去');
  expect(moved.switches).toEqual([]);
  const missing = matchMa2Programs(project, { ...catalog, entries: [] });
  expect(missing.unresolved).toEqual([{ target: 1, reason: expect.stringContaining('新读取的控台里没有 Timecode 1') as string }]);
});
