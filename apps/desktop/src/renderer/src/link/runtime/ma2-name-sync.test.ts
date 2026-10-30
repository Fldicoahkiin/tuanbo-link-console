import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, type Ma2Catalog, type Ma2RenameRequest, type Ma2RenameResult } from '@tb/schema';
import { pendingMa2Renames, renameConsoleCueCommand, saveMa2MaterialLibraryCommand, toConsoleLabel } from '@tb/core/link';
import { useDocumentStore } from '../stores/document-store';
import { useMa2SyncStore } from '../stores/ma2-sync-store';
import { ma2MaterialConnection } from '../stores/ma2-material-read-store';
import { readMa2Method } from '../stores/ma2-mode-store';
import { useMa2RealtimePreference } from './ma2-realtime-preference';
import { enableMa2NameSync } from './ma2-name-sync';
vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined }); });

vi.mock('../stores/ma2-mode-store', () => ({ readMa2Method: vi.fn() }));
vi.mock('../stores/ma2-material-read-store', () => ({ ma2MaterialConnection: vi.fn() }));
vi.mock('./ma2-project-archive', () => ({ archiveMa2Project: () => Promise.resolve('C:/archive.tblink') }));
vi.mock('../view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: { recordLog: () => Promise.resolve() } }));
const connection = { dataDirectory: '', network: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' } };
const catalog: Ma2Catalog = { directory: { show: 'Test', generation: 'session', version: '3.7.0.5', entries: [] }, readAt: new Date().toISOString(), entries: [] };
const readCatalog = vi.fn<() => Promise<Ma2Catalog>>();
const rename = vi.fn<(request: Ma2RenameRequest) => Promise<Ma2RenameResult>>();
beforeEach(() => {
  vi.resetAllMocks();
  const project = saveMa2MaterialLibraryCommand('192.0.2.1:30000', { directory: catalog.directory, readAt: catalog.readAt, fixtureUsage: [], errors: [],
    sequences: [{ sequence: 2, name: 'Sequence', cues: [{ index: 0, number: '1.100', name: 'Original' }] }] }).execute(createEmptyLinkProject('名称同步'));
  useDocumentStore.getState().setProject(project, 'test.tblink');
  useDocumentStore.getState().execute(renameConsoleCueCommand({ sequence: 2, cue: '1.100', kind: 'single' }, 'Front', { endpoint: '192.0.2.1:30000', show: 'Test' }));
  useMa2SyncStore.setState({ names: { state: 'idle', message: '' } });
  useMa2RealtimePreference.setState({ enabled: true });
  vi.mocked(readMa2Method).mockReturnValue('network');
  vi.mocked(ma2MaterialConnection).mockResolvedValue(connection);
  readCatalog.mockResolvedValue(catalog);
  rename.mockImplementation(request => Promise.resolve({ sequence: 2, cue: '1.100', kind: 'single', show: 'Test', generation: 'session', name: toConsoleLabel(request.change.name), backupFile: `tblink_label_${'a'.repeat(32)}.xml` }));
  vi.stubGlobal('window', { tbLink: { readMa2Catalog: readCatalog, renameMa2Object: rename, getMa2NetworkStatus: () => Promise.resolve({ state: 'connected' }) } });
});
afterEach(() => vi.unstubAllGlobals());

it('实时同步开着时，右键改名交给下一轮同步；停下的改名同步也重新开始', async () => {
  useMa2SyncStore.setState({ names: { state: 'blocked', message: '结果未知', blockedRevision: useDocumentStore.getState().revision } });
  await enableMa2NameSync(useDocumentStore.getState().documentId);
  expect(useMa2SyncStore.getState().names).toMatchObject({ state: 'pending', blockedRevision: undefined, nextCheckAt: 0 });
  expect(readCatalog).not.toHaveBeenCalled(); expect(rename).not.toHaveBeenCalled();
});
it('正在同步名称时再改名，不另开一次同步', async () => {
  useMa2RealtimePreference.setState({ enabled: false });
  useMa2SyncStore.setState({ names: { state: 'syncing', message: '正在同步名称：Front', writing: true } });
  await enableMa2NameSync(useDocumentStore.getState().documentId);
  expect(ma2MaterialConnection).not.toHaveBeenCalled(); expect(rename).not.toHaveBeenCalled();
});
it('实时同步暂停或用本机 onPC 时，这次明确的改名单独写到控台并确认', async () => {
  useMa2RealtimePreference.setState({ enabled: false });
  await enableMa2NameSync(useDocumentStore.getState().documentId);
  expect(rename).toHaveBeenCalledOnce();
  expect(pendingMa2Renames(useDocumentStore.getState().project)).toEqual([]);
  expect(useMa2SyncStore.getState().names).toMatchObject({ state: 'verified', message: '名称已写入控台并回读确认' });
});
it('未保存工程、没读过控台素材时不写回，并说明要先做什么', async () => {
  useDocumentStore.setState({ path: null });
  await expect(enableMa2NameSync(useDocumentStore.getState().documentId)).rejects.toThrow('先保存');
  useDocumentStore.setState({ path: 'test.tblink' });
  useDocumentStore.setState(state => ({ project: { ...state.project!, ma2MaterialLibrary: undefined } }));
  await expect(enableMa2NameSync(useDocumentStore.getState().documentId)).rejects.toThrow('读取控台素材');
  expect(ma2MaterialConnection).not.toHaveBeenCalled();
});
it('连接控台期间切换工程，不把旧工程的名称写到控台', async () => {
  useMa2RealtimePreference.setState({ enabled: false });
  vi.mocked(ma2MaterialConnection).mockImplementation(() => {
    useDocumentStore.getState().setProject(createEmptyLinkProject('另一工程'), 'other.tblink');
    return Promise.resolve(connection);
  });
  const documentId = useDocumentStore.getState().documentId;
  await expect(enableMa2NameSync(documentId)).rejects.toThrow('工程已切换');
  expect(rename).not.toHaveBeenCalled();
});
