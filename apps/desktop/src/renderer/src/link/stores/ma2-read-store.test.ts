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

const song = (id: string, startMs: number | null, durationMs = 10000) => ({ id, title: id, enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [], referenceAudio: { assetId: id, relativePath: `${id}.wav`, sha256: 'a'.repeat(64), durationMs },
  ...(startMs === null ? {} : { playback: { volume: 100, startMs: 0, endMs: 0, mtcOffsetMs: startMs, endAction: 'stop' as const, shortcut: '' } }) });
function show(target: number, offset: string, readAt: string, time = '30', withPreview = true): Ma2Catalog['entries'][number] {
  return { target, name: `时间线 ${target}`, eventCount: 1, frameFormat: '30 FPS', offset, slot: 'TC Slot 1', error: null, warnings: [],
    events: [{ path: '0/0/0', time, action: 'Goto', executor: '1.1', cue: '1', name: '开场' }],
    ...(withPreview ? { preview: { target, name: `时间线 ${target}`, sourceXml: '<MA/>', readAt, document: createLightingDocument(), mappings: [], warnings: [], unconverted: [] } } : {}) };
}
function open(name: string, songs: ReturnType<typeof song>[], entries: (readAt: string) => Ma2Catalog['entries']): void {
  const project = createEmptyLinkProject(name); project.schemaVersion = 2; project.rundown = songs;
  const readAt = new Date().toISOString(), list = entries(readAt);
  const catalog: Ma2Catalog = { directory: { show: 'Show', generation: 'session', version: '3.7.0.5', entries: list.map(entry => ({ target: entry.target, name: entry.name })) }, readAt, entries: list };
  project.ma2ReadState = { source: 'console', catalog, pairs: {}, failures: [], message: '', selectedTarget: null, query: '', filter: 'all' };
  useDocumentStore.getState().setProject(project, `${name}.tblink`);
}

it('按起始码对上的节目一次放进歌曲，不用确认；单条失败保留具体原因，其余照常放进；一次撤销恢复整批', async () => {
  open('现场缓存', [song('错误歌曲', 0), song('可用歌曲', 60000)], readAt => [show(1, '0', readAt, '30', false), show(2, '1800', readAt)]);
  expect(useDocumentStore.getState().project?.ma2ReadState?.pairs).toEqual({ 1: '错误歌曲', 2: '可用歌曲' });
  await importCachedMa2();
  const current = useDocumentStore.getState().project!;
  expect(current.rundown[0]?.lighting).toBeUndefined();
  expect(current.rundown[1]?.lighting?.ma2Bindings?.map(binding => [binding.timecode, binding.timeOriginMs])).toEqual([[2, 60000]]);
  expect(current.ma2ReadState?.pairings?.[2]?.status).toBe('confirmed');
  expect(current.ma2ReadState?.failures).toEqual([{ target: 1, message: expect.stringContaining('还没读取完整') as string }]);
  expect(current.ma2ReadState?.message).toContain('1 条已放进歌曲');
  // The import is an unsaved edit: the recovery copy and the operator's save keep it.
  expect(saveProjectDocument).not.toHaveBeenCalled();
  expect(useDocumentStore.getState().dirty).toBe(true);
  useDocumentStore.getState().undo();
  expect(useDocumentStore.getState().project?.rundown.every(item => !item.lighting)).toBe(true);
});

it('没有 MTC 起始码的歌不对上；指定节目时只放这一条；已放进的不重复放', async () => {
  open('按节目放', [song('没起点', null), song('甲', 300_000, 60000), song('乙', 400_000, 60000)], readAt => [show(3, '9000', readAt), show(4, '12000', readAt)]);
  expect(useDocumentStore.getState().project?.ma2ReadState?.pairs).toEqual({ 3: '甲', 4: '乙' });
  expect(await importCachedMa2(4)).toEqual({ imported: ['乙'], failures: [] });
  expect(useDocumentStore.getState().project!.rundown.map(item => item.lighting?.ma2Bindings?.map(binding => binding.timecode))).toEqual([undefined, undefined, [4]]);
  expect(await importCachedMa2()).toEqual({ imported: ['甲'], failures: [] });
  expect(await importCachedMa2()).toEqual({ imported: [], failures: [] });
});

it('控台事件在歌曲结束之后：照样放进歌曲，不丢事件，也不改歌曲起点', async () => {
  open('结尾之后', [song('短歌', 0, 500)], readAt => [show(4, '0', readAt, '300')]);
  expect(await importCachedMa2()).toEqual({ imported: ['短歌'], failures: [] });
  const item = useDocumentStore.getState().project!.rundown[0]!;
  expect(item.playback?.mtcOffsetMs).toBe(0);
  expect(item.lighting?.ma2Bindings?.map(binding => binding.timecode)).toEqual([4]);
});
