import { expect, it } from 'vitest';
import { createEmptyLinkProject, type Ma2Catalog } from '@tb/schema';
import { matchMa2Programs } from './ma2-program-matching';

it('按完整歌曲时间区间匹配；重叠区间不按名称硬配，跨歌事件不截断', () => {
  const project = createEmptyLinkProject('匹配');
  project.rundown = ['A', 'B'].map((title, index) => ({ id: title, title, enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [], referenceAudio: { assetId: title, relativePath: `${title}.wav`, sha256: 'a'.repeat(64), durationMs: 10000 }, playback: { volume: 100, endAction: 'stop', startMs: 0, endMs: 0, mtcOffsetMs: 60000 + index * 20000, shortcut: '' } }));
  const catalog: Ma2Catalog = { directory: { show: 'show', version: '3.3.4', generation: '1', entries: [] }, readAt: new Date().toISOString(), entries: [{ target: 1, name: '灯光', eventCount: 1, frameFormat: '30 FPS', offset: '1800', slot: 'TC Slot 1', events: [{ path: 'event', time: '30', action: 'Goto', executor: '1.1', cue: '1', name: 'Cue' }], error: null, warnings: [] }] };
  expect(matchMa2Programs(project, catalog).pairs).toEqual({ 1: 'A' });
  project.rundown[1]!.playback!.mtcOffsetMs = 60000;
  expect(matchMa2Programs(project, catalog).unresolved).toHaveLength(1);
  catalog.entries[0]!.name = 'B.wav';
  expect(matchMa2Programs(project, catalog).pairs).toEqual({});
  catalog.entries[0]!.events.push({ ...catalog.entries[0]!.events[0]!, time: '900' });
  expect(matchMa2Programs(project, catalog).unresolved).toHaveLength(1);
  expect(matchMa2Programs(project, catalog).pairs).toEqual({});
});

it('缺原始起点时不因同名硬配；缺文件占位不参与匹配', () => {
  const project = createEmptyLinkProject('MP4 配对');
  project.rundown = ['挖空.mp4', '另一首.mp4'].map((title, index) => ({ id: String(index), title, enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [], referenceAudio: { assetId: title, relativePath: `${index}.wav`, sha256: 'a'.repeat(64), durationMs: 40000 } }));
  const catalog: Ma2Catalog = { directory: { show: 'show', version: '3.3.4', generation: '1', entries: [] }, readAt: new Date().toISOString(), entries: [{ target: 1, name: '挖空', eventCount: 1, frameFormat: '30 FPS', offset: '0', slot: 'TC Slot 2', events: [{ path: 'event', time: '30', action: 'Goto', executor: '1.1', cue: '1', name: 'Cue' }], error: null, warnings: [] }] };
  expect(matchMa2Programs(project, catalog).pairs).toEqual({});
  project.rundown[0]!.title = 'shake+it+off.mp3'; catalog.entries[0]!.name = 'shake it off';
  expect(matchMa2Programs(project, catalog).pairs).toEqual({});
  project.rundown[1]!.title = 'shake-it-off.wav';
  expect(matchMa2Programs(project, catalog).pairs).toEqual({});
  project.rundown[1]!.title = '另一首';
  project.rundown[0]!.p1UnavailableSourceKey = 'missing';
  expect(matchMa2Programs(project, catalog).pairs).toEqual({});
});

function matchStartCode(songs: Array<{ id: string; startMs: number; durationMs: number }>, offset: string, times: string[], length?: string): ReturnType<typeof matchMa2Programs> {
  const project = createEmptyLinkProject('起始码');
  project.rundown = songs.map(song => ({ id: song.id, title: `歌曲${song.id}`, enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [], referenceAudio: { assetId: song.id, relativePath: `${song.id}.wav`, sha256: 'a'.repeat(64), durationMs: song.durationMs }, playback: { volume: 100, endAction: 'stop' as const, startMs: 0, endMs: 0, mtcOffsetMs: song.startMs, shortcut: '' } }));
  const catalog: Ma2Catalog = { directory: { show: 'show', version: '3.7.0.5', generation: '1', entries: [] }, readAt: new Date().toISOString(), entries: [{ target: 7, name: '灯光', eventCount: times.length, frameFormat: '30 FPS', offset, slot: 'TC Slot 1', ...(length ? { length } : {}), events: times.map(time => ({ path: time, time, action: 'Goto', executor: '1.1', cue: '1', name: 'Cue' })), error: null, warnings: [] }] };
  return matchMa2Programs(project, catalog);
}

it('起始码与歌曲起点（按 30 帧）精确相等时优先配对，区间重叠的另一首不再造成歧义', () => {
  expect(matchStartCode([{ id: 'A', startMs: 60000, durationMs: 10000 }, { id: 'B', startMs: 55000, durationMs: 20000 }], '1800', ['30']).pairs).toEqual({ 7: 'A' });
});

it('多首歌起始码相同时先按事件区间、再按控台节目长度区分；仍分不出时列出候选，不猜', () => {
  const songs = [{ id: 'A', startMs: 0, durationMs: 10000 }, { id: 'B', startMs: 0, durationMs: 5000 }];
  expect(matchStartCode(songs, '0', ['30', '200']).pairs).toEqual({ 7: 'A' });
  expect(matchStartCode(songs, '0', ['30'], '270').pairs).toEqual({ 7: 'A' });
  const ambiguous = matchStartCode(songs, '0', ['30']);
  expect(ambiguous.pairs).toEqual({});
  expect(ambiguous.unresolved[0]?.reason).toContain('歌曲A'); expect(ambiguous.unresolved[0]?.reason).toContain('歌曲B');
});

it('起始码相同但事件超出这首歌的时长：不配对并说明原因', () => {
  const result = matchStartCode([{ id: 'A', startMs: 60000, durationMs: 10000 }, { id: 'B', startMs: 50000, durationMs: 30000 }], '1800', ['30', '600']);
  expect(result.pairs).toEqual({});
  expect(result.unresolved[0]?.reason).toContain('超出');
});
