import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, type Ma2Catalog } from '@tb/schema';
import { useDocumentStore } from './document-store';
import { importCachedMa2, useMa2ReadStore } from './ma2-read-store';

const saveProjectDocument = vi.hoisted(() => vi.fn());
vi.mock('../view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: {} }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('window', { tbLink: { saveProjectDocument } });
  useMa2ReadStore.setState({ busy: false });
});
afterEach(() => { vi.unstubAllGlobals(); });

it('单条缓存配对失败保留具体原因，其余时间线仍关联并留待保存；一次撤销恢复整批', async () => {
  const project = createEmptyLinkProject('现场缓存');
  project.schemaVersion = 2;
  project.rundown = ['错误歌曲', '可用歌曲'].map(id => ({ id, title: id, enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [], referenceAudio: { assetId: id, relativePath: `${id}.wav`, sha256: 'a'.repeat(64), durationMs: 10000 }, playback: { volume: 100, startMs: 0, endMs: 0, mtcOffsetMs: 0, endAction: 'stop' as const, shortcut: '' } }));
  const readAt = new Date().toISOString();
  const catalog: Ma2Catalog = { directory: { show: 'Show', generation: 'session', version: '3.7.0.5', entries: [{ target: 1, name: '错误时间线' }, { target: 2, name: '可用时间线' }] }, readAt, entries: [1, 2].map(target => ({
    target, name: `时间线 ${target}`, eventCount: 1, frameFormat: target === 1 ? '25 FPS' : '30 FPS', offset: '0', slot: 'TC Slot 1', error: null, warnings: [],
    events: [{ path: '0/0/0', time: '30', action: 'Goto', executor: '1.1', cue: '1', name: '开场' }],
    preview: { target, name: `时间线 ${target}`, sourceXml: '<MA/>', readAt, document: createLightingDocument(), mappings: [], warnings: [], unconverted: [] }
  })) };
  project.ma2ReadState = { source: 'console', catalog, pairs: { 1: '错误歌曲', 2: '可用歌曲' }, failures: [], message: '', selectedTarget: null, query: '', filter: 'all' };
  useDocumentStore.getState().setProject(project, 'cached.tblink');
  await importCachedMa2();
  const current = useDocumentStore.getState().project!;
  expect(current.rundown[0]?.lighting).toBeUndefined();
  expect(current.rundown[1]?.lighting?.ma2Bindings?.map(binding => binding.timecode)).toEqual([2]);
  expect(current.ma2ReadState?.pairings?.[2]?.status).toBe('confirmed');
  expect(current.ma2ReadState?.failures).toHaveLength(1);
  expect(current.ma2ReadState?.failures[0]?.target).toBe(1);
  expect(current.ma2ReadState?.failures[0]?.message).toContain('25 FPS');
  expect(current.ma2ReadState?.message).toContain('1 条已关联');
  // The association is an unsaved edit: the recovery copy and the operator's save keep it.
  expect(saveProjectDocument).not.toHaveBeenCalled();
  expect(useDocumentStore.getState().dirty).toBe(true);
  useDocumentStore.getState().undo();
  expect(useDocumentStore.getState().project?.rundown.every(item => !item.lighting)).toBe(true);
});

it('选歌即配对：Cue 一步放到这首歌的时间线；歌还没有 MTC 起点时用控台节目的起点；一次撤销恢复', async () => {
  const project = createEmptyLinkProject('选歌配对');
  project.schemaVersion = 2;
  project.rundown = [{ id: '新歌', title: '新歌', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [], referenceAudio: { assetId: 'a', relativePath: 'a.wav', sha256: 'a'.repeat(64), durationMs: 60000 } }];
  const readAt = new Date().toISOString();
  // Offset 9000 (1/30 s) = 300 s; the Cue fires 1 s into the song.
  const catalog: Ma2Catalog = { directory: { show: 'Show', generation: 'session', version: '3.7.0.5', entries: [{ target: 3, name: '新歌时间线' }] }, readAt, entries: [{
    target: 3, name: '新歌时间线', eventCount: 1, frameFormat: '30 FPS', offset: '9000', slot: 'TC Slot 1', error: null, warnings: [],
    events: [{ path: '0/0/0', time: '30', action: 'Goto', executor: '1.1', cue: '1', name: '开场' }],
    preview: { target: 3, name: '新歌时间线', sourceXml: '<MA/>', readAt, document: createLightingDocument(), mappings: [], warnings: [], unconverted: [] }
  }] };
  project.ma2ReadState = { source: 'console', catalog, pairs: {}, failures: [], message: '', selectedTarget: 3, query: '', filter: 'all' };
  useDocumentStore.getState().setProject(project, 'pair.tblink');
  expect(await importCachedMa2(3, '新歌')).toEqual({ imported: ['新歌'], failures: [] });
  const song = useDocumentStore.getState().project!.rundown[0]!;
  expect(song.playback?.mtcOffsetMs).toBe(300_000);
  expect(song.lighting?.ma2Bindings?.map(binding => [binding.timecode, binding.timeOriginMs])).toEqual([[3, 300_000]]);
  expect(useDocumentStore.getState().project?.ma2ReadState?.pairings?.[3]?.status).toBe('confirmed');
  useDocumentStore.getState().undo();
  const restored = useDocumentStore.getState().project!;
  expect(restored.rundown[0]?.playback).toBeUndefined(); expect(restored.rundown[0]?.lighting).toBeUndefined();
  expect(restored.ma2ReadState?.pairs).toEqual({});
  // A Timecode already on a song is not paired a second time.
  await importCachedMa2(3, '新歌');
  await expect(importCachedMa2(3, '新歌')).rejects.toThrow('已关联歌曲');
});

it('选歌配对失败时不改歌曲起点，并带回具体原因', async () => {
  const project = createEmptyLinkProject('配对失败');
  project.schemaVersion = 2;
  project.rundown = [{ id: '短歌', title: '短歌', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [], referenceAudio: { assetId: 'a', relativePath: 'a.wav', sha256: 'a'.repeat(64), durationMs: 500 } }];
  const readAt = new Date().toISOString();
  const catalog: Ma2Catalog = { directory: { show: 'Show', generation: 'session', version: '3.7.0.5', entries: [{ target: 4, name: '长时间线' }] }, readAt, entries: [{
    target: 4, name: '长时间线', eventCount: 1, frameFormat: '30 FPS', offset: '0', slot: 'TC Slot 1', error: null, warnings: [],
    events: [{ path: '0/0/0', time: '300', action: 'Goto', executor: '1.1', cue: '1', name: '开场' }],
    preview: { target: 4, name: '长时间线', sourceXml: '<MA/>', readAt, document: createLightingDocument(), mappings: [], warnings: [], unconverted: [] }
  }] };
  project.ma2ReadState = { source: 'console', catalog, pairs: {}, failures: [], message: '', selectedTarget: 4, query: '', filter: 'all' };
  useDocumentStore.getState().setProject(project, 'fail.tblink');
  const result = await importCachedMa2(4, '短歌');
  expect(result.imported).toEqual([]);
  expect(result.failures[0]?.message).toContain('超出');
  const song = useDocumentStore.getState().project!.rundown[0]!;
  expect(song.playback).toBeUndefined(); expect(song.lighting).toBeUndefined();
  expect(useDocumentStore.getState().project?.ma2ReadState?.failures.map(failure => failure.target)).toEqual([4]);
});
