import { beforeEach, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, type Ma2Catalog } from '@tb/schema';
import { useDocumentStore } from './document-store';
import { importCachedMa2, useMa2ReadStore } from './ma2-read-store';

const saveProject = vi.hoisted(() => vi.fn().mockResolvedValue('cached.tblink'));
vi.mock('../view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: { saveProject } }));

beforeEach(() => {
  vi.clearAllMocks();
  useMa2ReadStore.setState({ busy: false });
});

it('单条缓存配对失败保留具体原因，其余时间线仍关联并保存；一次撤销恢复整批', async () => {
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
  expect(saveProject).toHaveBeenCalledOnce();
  useDocumentStore.getState().undo();
  expect(useDocumentStore.getState().project?.rundown.every(item => !item.lighting)).toBe(true);
});
