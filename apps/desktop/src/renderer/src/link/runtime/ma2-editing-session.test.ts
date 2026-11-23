import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, type Ma2Catalog, type Ma2CatalogRequest } from '@tb/schema';
import { importMa2TimecodeCommand } from '@tb/core/link';
import { convertMa2Timecode } from '../../../../main/link/ma2-timecode-conversion';
import { useDocumentStore } from '../stores/document-store';
import { importCachedMa2, scanMa2, useMa2ReadStore } from '../stores/ma2-read-store';
import { useMa2SyncStore } from '../stores/ma2-sync-store';
import { prepareMa2Editing } from './ma2-editing-session';
import { scanMa2Materials } from '../stores/ma2-material-read-store';
vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined }); });
vi.mock('../stores/ma2-material-read-store', () => ({ scanMa2Materials: vi.fn() }));
vi.mock('../stores/ma2-mode-store', () => ({ useMa2ModeStore: vi.fn() }));

vi.mock('../stores/ma2-read-store', async importOriginal => ({
  ...await importOriginal<typeof import('../stores/ma2-read-store')>(), scanMa2: vi.fn(), importCachedMa2: vi.fn()
}));
vi.mock('../view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: {} }));
const xml = await readFile(new URL('../../../../main/link/fixtures/ma2-timecode-fractional-3.3.xml', import.meta.url), 'utf8');
const sequence = await readFile(new URL('../../../../main/link/fixtures/ma2-sequence-fractional-3.3.xml', import.meta.url), 'utf8');
const catalog: Ma2Catalog = { directory: { show: 'Test', generation: 'session', version: '3.3.4', entries: [] }, readAt: new Date().toISOString(), entries: [] };
const connection = { dataDirectory: '', network: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' } };
const readCatalog = vi.fn<(request: Ma2CatalogRequest) => Promise<Ma2Catalog>>();
beforeEach(() => {
  vi.resetAllMocks();
  const project = createEmptyLinkProject('连接编排');
  project.rundown = [{ id: 'song', title: '歌曲', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [] }];
  const bound = importMa2TimecodeCommand('song', convertMa2Timecode(xml, [sequence], 9902)).execute(project);
  bound.ma2ReadState = { source: '192.0.2.1:30000', catalog, pairs: {}, failures: [], message: '', selectedTarget: null, query: '', filter: 'all' };
  useDocumentStore.getState().setProject(bound, 'test.tblink');
  useMa2SyncStore.setState({ songs: {} });
  useMa2ReadStore.setState({ busy: false });
  readCatalog.mockResolvedValue(catalog);
  vi.stubGlobal('window', { tbLink: { prepareMa2Playback: vi.fn().mockResolvedValue(false), readMa2Catalog: readCatalog } });
});
afterEach(() => vi.unstubAllGlobals());

it('连到缺少工程时间线的 Show 时保留素材，并在修改控台前结束连接准备', async () => {
  const state = useDocumentStore.getState();
  const project = state.project!;
  const read = project.ma2ReadState!;
  const entry = { target: 9902, name: '节目', eventCount: 3, frameFormat: '30 FPS', slot: 'TC Slot 2', offset: '0', events: [], error: null, warnings: [] };
  state.setProject({ ...project, ma2ReadState: { ...read, catalog: { ...catalog, entries: [entry], directory: { ...catalog.directory, entries: [{ target: 9902, name: '节目' }] } } } }, 'test.tblink');
  const before = useDocumentStore.getState();
  readCatalog.mockResolvedValue({ ...catalog, directory: { ...catalog.directory, show: 'Empty' } });
  await expect(prepareMa2Editing(connection, before.documentId)).rejects.toThrow('当前 Show「Empty」没有工程关联的 Timecode 9902');
  expect(useDocumentStore.getState().project).toBe(before.project);
  expect(window.tbLink.prepareMa2Playback).not.toHaveBeenCalled();
  expect(scanMa2Materials).not.toHaveBeenCalled();
  expect(scanMa2).not.toHaveBeenCalled();
});

it('明确连接的选曲准备期间占用读取任务，失败也释放，不开始缓存读回', async () => {
  vi.mocked(window.tbLink.prepareMa2Playback).mockImplementation(() => {
    expect(useMa2ReadStore.getState().busy).toBe(true);
    return Promise.reject(new Error('控台未确认'));
  });
  await expect(prepareMa2Editing(connection, useDocumentStore.getState().documentId)).rejects.toThrow('控台未确认');
  expect(useMa2ReadStore.getState().busy).toBe(false);
  expect(readCatalog).not.toHaveBeenCalled();
});

it('选曲准备改动原时间线设置后重新读取，不复用旧播放属性', async () => {
  vi.mocked(window.tbLink.prepareMa2Playback).mockResolvedValue(true);
  await prepareMa2Editing(connection, useDocumentStore.getState().documentId);
  expect(scanMa2).toHaveBeenCalledOnce();
  expect(readCatalog).not.toHaveBeenCalled();
});

it('选曲准备传递实际进度，失败清除占用、进度和取消编号，随后可重新连接', async () => {
  vi.mocked(window.tbLink.prepareMa2Playback).mockImplementationOnce((request, progress) => {
    expect(request.network).toEqual(connection.network);
    expect(useMa2ReadStore.getState().activeId).toBe(request.progressId);
    progress?.({ id: request.progressId, phase: 'selection', completed: 4, total: 30, detail: '检查序列 3 的触发方式' });
    expect(useMa2ReadStore.getState().progress).toMatchObject({ completed: 4, total: 30 });
    return Promise.reject(new Error('序列 3 未确认'));
  });
  await expect(prepareMa2Editing(connection, useDocumentStore.getState().documentId)).rejects.toThrow('序列 3');
  expect(useMa2ReadStore.getState()).toMatchObject({ busy: false, activeId: null, progress: null, message: '控台选曲检查未完成：序列 3 未确认' });
  await expect(prepareMa2Editing(connection, useDocumentStore.getState().documentId)).resolves.toContain('已用工程里保存');
});

it('准备选曲期间切换工程会取消旧任务，不向新工程读取或导入', async () => {
  const cancel = vi.fn().mockResolvedValue(undefined);
  window.tbLink.cancelMa2Read = cancel;
  let oldId = '';
  vi.mocked(window.tbLink.prepareMa2Playback).mockImplementationOnce(request => {
    oldId = request.progressId;
    useDocumentStore.getState().setProject(createEmptyLinkProject('新工程'), 'new.tblink');
    return Promise.resolve(false);
  });
  await expect(prepareMa2Editing(connection, useDocumentStore.getState().documentId)).rejects.toThrow('工程已切换');
  expect(cancel).toHaveBeenCalledWith(oldId);
  expect(readCatalog).not.toHaveBeenCalled();
  expect(importCachedMa2).not.toHaveBeenCalled();
  expect(useMa2ReadStore.getState()).toMatchObject({ busy: false, activeId: null });
});

it('重新连接核对目录并复用缓存，等待明确开始同步', async () => {
  const message = await prepareMa2Editing(connection, useDocumentStore.getState().documentId);
  expect(readCatalog).toHaveBeenCalledWith({ ...connection, targets: [] });
  expect(scanMa2).not.toHaveBeenCalled();
  expect(importCachedMa2).toHaveBeenCalledOnce();
  expect(scanMa2Materials).toHaveBeenCalledWith(connection, false);
  expect(useMa2SyncStore.getState().songs).toEqual({});
  expect(message).toContain('同步当前节目');
  expect(message).toContain('工程里保存的控台数据');
});
it('首次连接依次扫描、配对，不依赖设置页面挂载', async () => {
  useDocumentStore.setState(state => ({ project: { ...state.project!, ma2ReadState: undefined } }));
  vi.mocked(scanMa2).mockImplementation(() => { useDocumentStore.setState(state => ({ project: { ...state.project!, ma2ReadState: { source: '192.0.2.1:30000', catalog, pairs: {}, failures: [], message: '', selectedTarget: null, query: '', filter: 'all' } } })); return Promise.resolve(); });
  await prepareMa2Editing(connection, useDocumentStore.getState().documentId);
  expect(scanMa2).toHaveBeenCalledWith(connection, false);
  expect(importCachedMa2).toHaveBeenCalledOnce();
  expect(readCatalog).not.toHaveBeenCalled();
});
it('目录响应晚到时不向新工程导入或启用同步', async () => {
  readCatalog.mockImplementation(() => { useDocumentStore.getState().setProject(createEmptyLinkProject('另一工程'), null); return Promise.resolve(catalog); });
  await expect(prepareMa2Editing(connection, useDocumentStore.getState().documentId)).rejects.toThrow('工程已切换');
  expect(importCachedMa2).not.toHaveBeenCalled(); expect(scanMa2).not.toHaveBeenCalled();
  expect(useMa2SyncStore.getState().songs).toEqual({});
});
it('连接之前的本地修改保留，不能因连接动作自动覆盖控台', async () => {
  const project = structuredClone(useDocumentStore.getState().project!);
  project.rundown[0]!.lighting!.tracks[0]!.clips[0]!.events[0]!.at = 1000;
  useDocumentStore.getState().setProject(project, 'test.tblink');
  expect(await prepareMa2Editing(connection, useDocumentStore.getState().documentId)).toContain('连接前做的本地修改');
  expect(useMa2SyncStore.getState().songs).toEqual({});
});
it('含软件不转换的控台动作的时间线照样可写回，动作原样保留（2026-10-26）', async () => {
  const project = structuredClone(useDocumentStore.getState().project!);
  project.rundown[0]!.lighting!.ma2Bindings![0]!.nativeEvents = [{ path: 'native', reason: '未验证动作' }];
  useDocumentStore.getState().setProject(project, 'test.tblink');
  const summary = await prepareMa2Editing(connection, useDocumentStore.getState().documentId);
  expect(summary).toContain('1 条含控台原样动作'); expect(summary).not.toContain('还没有可以写回控台的时间线');
  expect(importCachedMa2).toHaveBeenCalledOnce(); expect(useMa2SyncStore.getState().songs).toEqual({});
});

it('重新打开工程，插件换代但两份目录仍相同，只核对目录并保留 Cue 的读取时间', async () => {
  const directory = { ...catalog.directory, generation: 'previous', entries: [{ target: 1, name: '步骤' }] };
  const saved = { directory, readAt: catalog.readAt, sequences: [{ sequence: 1, name: '步骤', cues: [] }], fixtureUsage: [], errors: [] };
  const project = useDocumentStore.getState().project!;
  useDocumentStore.getState().setProject({ ...project, ma2MaterialLibrary: { version: 1, source: project.ma2ReadState!.source, library: saved } }, 'test.tblink');
  const changedGeneration = 'new-bridge';
  readCatalog.mockResolvedValue({ ...catalog, directory: { ...catalog.directory, generation: changedGeneration } });
  window.tbLink.readMa2EffectLibrary = vi.fn().mockResolvedValue({ ...saved, directory: { ...directory, generation: changedGeneration }, sequences: [] });
  await prepareMa2Editing(connection, useDocumentStore.getState().documentId);
  expect(readCatalog).toHaveBeenCalledExactlyOnceWith({ ...connection, targets: [] });
  expect(window.tbLink.readMa2EffectLibrary).toHaveBeenCalledExactlyOnceWith({ ...connection, targets: [] });
  expect(scanMa2).not.toHaveBeenCalled();
  expect(scanMa2Materials).not.toHaveBeenCalled();
  expect(useDocumentStore.getState().project?.ma2MaterialLibrary?.library).toMatchObject({ readAt: saved.readAt, sequences: saved.sequences, directory: { generation: changedGeneration } });
});
