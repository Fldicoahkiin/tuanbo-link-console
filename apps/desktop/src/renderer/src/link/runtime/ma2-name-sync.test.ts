import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, type Ma2Catalog } from '@tb/schema';
import { saveMa2MaterialLibraryCommand } from '@tb/core/link';
import { useDocumentStore } from '../stores/document-store';
import { ma2MaterialConnection } from '../stores/ma2-material-read-store';
import { enableMa2NameSync, useMa2AutoSyncStore } from './use-ma2-auto-sync';
vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined }); });

vi.mock('../stores/ma2-mode-store', () => ({ useMa2ModeStore: vi.fn() }));
vi.mock('../stores/ma2-material-read-store', () => ({ ma2MaterialConnection: vi.fn() }));
vi.mock('../view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: {} }));
const connection = { dataDirectory: '', network: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' } };
const catalog: Ma2Catalog = { directory: { show: 'Test', generation: 'session', version: '3.7.0.5', entries: [] }, readAt: new Date().toISOString(), entries: [] };
const readCatalog = vi.fn<() => Promise<Ma2Catalog>>();
beforeEach(() => {
  vi.resetAllMocks();
  const project = saveMa2MaterialLibraryCommand('192.0.2.1:30000', { directory: catalog.directory, readAt: catalog.readAt, sequences: [], fixtureUsage: [], errors: [] }).execute(createEmptyLinkProject('名称同步'));
  useDocumentStore.getState().setProject(project, 'test.tblink');
  useMa2AutoSyncStore.setState({ request: null, status: 'off' });
  vi.mocked(ma2MaterialConnection).mockResolvedValue(connection);
  readCatalog.mockResolvedValue(catalog);
  vi.stubGlobal('window', { tbLink: { readMa2Catalog: readCatalog } });
});
afterEach(() => vi.unstubAllGlobals());

it('右键改名只开启名称同步；明确重试可重启已中断会话', async () => {
  useMa2AutoSyncStore.setState({ status: 'blocked' });
  await enableMa2NameSync(useDocumentStore.getState().documentId);
  expect(readCatalog).toHaveBeenCalledWith({ ...connection, targets: [] });
  expect(useMa2AutoSyncStore.getState().request).toEqual({ connection, catalog, scope: 'names' });
});
it('已有明确启用的全量同步会话不被右键改名重置', async () => {
  const request = { connection, catalog };
  useMa2AutoSyncStore.setState({ request, status: 'writing' });
  await enableMa2NameSync(useDocumentStore.getState().documentId);
  expect(useMa2AutoSyncStore.getState().request).toBe(request);
  expect(ma2MaterialConnection).not.toHaveBeenCalled();
});
it('未保存工程或控台会话变化不会开启写回', async () => {
  useDocumentStore.setState({ path: null });
  await expect(enableMa2NameSync(useDocumentStore.getState().documentId)).rejects.toThrow('先保存');
  expect(ma2MaterialConnection).not.toHaveBeenCalled();
  useDocumentStore.setState({ path: 'test.tblink' });
  readCatalog.mockResolvedValue({ ...catalog, directory: { ...catalog.directory, generation: 'other' } });
  await expect(enableMa2NameSync(useDocumentStore.getState().documentId)).rejects.toThrow('控台或 Show 有变化');
  expect(useMa2AutoSyncStore.getState().request).toBeNull();
});
it('回读期间切换工程不启用旧工程的名称写回', async () => {
  readCatalog.mockImplementation(() => {
    useDocumentStore.getState().setProject(createEmptyLinkProject('另一工程'), 'other.tblink');
    return Promise.resolve(catalog);
  });
  await expect(enableMa2NameSync(useDocumentStore.getState().documentId)).rejects.toThrow('工程已切换');
  expect(useMa2AutoSyncStore.getState().request).toBeNull();
});
