import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, type Ma2Catalog, type Ma2CatalogRequest } from '@tb/schema';
import { importMa2TimecodeCommand } from '@tb/core/link';
import { convertMa2Timecode } from '../../../../main/link/ma2-timecode-conversion';
import { useDocumentStore } from '../stores/document-store';
import { importCachedMa2, scanMa2, useMa2ReadStore } from '../stores/ma2-read-store';
import { useMa2AutoSyncStore } from './use-ma2-auto-sync';
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
  useMa2AutoSyncStore.setState({ request: null, status: 'off' });
  useMa2ReadStore.setState({ busy: false });
  readCatalog.mockResolvedValue(catalog);
  vi.stubGlobal('window', { tbLink: { readMa2Catalog: readCatalog } });
});
afterEach(() => vi.unstubAllGlobals());

it('重新连接核对目录并复用缓存，等待明确开始同步', async () => {
  const message = await prepareMa2Editing(connection, useDocumentStore.getState().documentId);
  expect(readCatalog).toHaveBeenCalledWith({ ...connection, targets: [] });
  expect(scanMa2).not.toHaveBeenCalled();
  expect(importCachedMa2).toHaveBeenCalledOnce();
  expect(scanMa2Materials).toHaveBeenCalledWith(connection, false);
  expect(useMa2AutoSyncStore.getState().request).toBeNull();
  expect(message).toContain('实时同步');
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
  expect(useMa2AutoSyncStore.getState().request).toBeNull();
});
it('连接之前的本地修改保留，不能因连接动作自动覆盖控台', async () => {
  const project = structuredClone(useDocumentStore.getState().project!);
  project.rundown[0]!.lighting!.tracks[0]!.clips[0]!.events[0]!.at = 1000;
  useDocumentStore.getState().setProject(project, 'test.tblink');
  expect(await prepareMa2Editing(connection, useDocumentStore.getState().documentId)).toContain('连接前做的本地修改');
  expect(useMa2AutoSyncStore.getState().request).toBeNull();
});
it('原生保留时间线可载入但不会冒充可安全写回', async () => {
  const project = structuredClone(useDocumentStore.getState().project!);
  project.rundown[0]!.lighting!.ma2Bindings![0]!.nativeEvents = [{ path: 'native', reason: '未验证动作' }];
  useDocumentStore.getState().setProject(project, 'test.tblink');
  expect(await prepareMa2Editing(connection, useDocumentStore.getState().documentId)).toContain('还没有可以写回控台的时间线');
  expect(importCachedMa2).toHaveBeenCalledOnce(); expect(useMa2AutoSyncStore.getState().request).toBeNull();
});
