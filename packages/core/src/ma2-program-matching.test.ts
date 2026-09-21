import { expect, it } from 'vitest';
import { createEmptyLinkProject, type Ma2Catalog } from '@tb/schema';
import { matchMa2Programs } from './ma2-program-matching';

it('按完整歌曲时间区间匹配；重叠歌曲要求唯一名称，跨歌事件不截断', () => {
  const project = createEmptyLinkProject('匹配');
  project.rundown = ['A', 'B'].map((title, index) => ({ id: title, title, enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [], referenceAudio: { assetId: title, relativePath: `${title}.wav`, sha256: 'a'.repeat(64), durationMs: 10000 }, playback: { volume: 100, endAction: 'stop', startMs: 0, endMs: 0, mtcOffsetMs: 60000 + index * 20000, shortcut: '' } }));
  const catalog: Ma2Catalog = { directory: { show: 'show', version: '3.3.4', generation: '1', entries: [] }, readAt: new Date().toISOString(), entries: [{ target: 1, name: '灯光', eventCount: 1, frameFormat: '30 FPS', offset: '1800', slot: 'TC Slot 1', events: [{ path: 'event', time: '30', action: 'Goto', executor: '1.1', cue: '1', name: 'Cue' }], error: null, warnings: [] }] };
  expect(matchMa2Programs(project, catalog).pairs).toEqual({ 1: 'A' });
  project.rundown[1]!.playback!.mtcOffsetMs = 60000;
  expect(matchMa2Programs(project, catalog).unresolved).toHaveLength(1);
  catalog.entries[0]!.name = 'B.wav';
  expect(matchMa2Programs(project, catalog).pairs).toEqual({ 1: 'B' });
  catalog.entries[0]!.events.push({ ...catalog.entries[0]!.events[0]!, time: '900' });
  expect(matchMa2Programs(project, catalog).unresolved).toHaveLength(1);
  expect(matchMa2Programs(project, catalog).pairs).toEqual({});
});

it('MP4 音乐去除扩展名后唯一匹配控台名称，缺文件占位不参与匹配', () => {
  const project = createEmptyLinkProject('MP4 配对');
  project.rundown = ['挖空.mp4', '另一首.mp4'].map((title, index) => ({ id: String(index), title, enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [], referenceAudio: { assetId: title, relativePath: `${index}.wav`, sha256: 'a'.repeat(64), durationMs: 40000 } }));
  const catalog: Ma2Catalog = { directory: { show: 'show', version: '3.3.4', generation: '1', entries: [] }, readAt: new Date().toISOString(), entries: [{ target: 1, name: '挖空', eventCount: 1, frameFormat: '30 FPS', offset: '0', slot: 'TC Slot 2', events: [{ path: 'event', time: '30', action: 'Goto', executor: '1.1', cue: '1', name: 'Cue' }], error: null, warnings: [] }] };
  expect(matchMa2Programs(project, catalog).pairs).toEqual({ 1: '0' });
  project.rundown[0]!.p1UnavailableSourceKey = 'missing';
  expect(matchMa2Programs(project, catalog).pairs).toEqual({});
});
