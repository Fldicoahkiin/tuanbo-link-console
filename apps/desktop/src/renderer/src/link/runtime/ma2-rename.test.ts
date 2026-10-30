import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, lightingTrackSchema, parseLinkProject, type Ma2Catalog, type Ma2RenameRequest, type Ma2RenameResult } from '@tb/schema';
import { saveMa2MaterialLibraryCommand, renameConsoleCueCommand, renameLightingLibraryEntryCommand, setLightingLibraryViewCommand, pendingMa2Renames, toConsoleLabel } from '@tb/core/link';
import { useDocumentStore as store } from '../stores/document-store';
import { useMa2SyncStore } from '../stores/ma2-sync-store';
import { useMa2RealtimePreference } from './ma2-realtime-preference';
import { tickMa2SongSync } from './ma2-song-sync';
import { MOVED_RENAMES } from './ma2-name-sync';

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined }); });
const { archive } = vi.hoisted(() => ({ archive: vi.fn() }));
vi.mock('./ma2-project-archive', () => ({ archiveMa2Project: archive }));
vi.mock('../view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: { recordLog: () => Promise.resolve() } }));

const source = { endpoint: '192.0.2.1:30000', show: 'Test' };
const ref = { sequence: 2, cue: '1.100', kind: 'single' as const };
const directory = { show: source.show, generation: 'session', version: '3.7.0.5', entries: [] };
const status = vi.fn(), readMa2Catalog = vi.fn<() => Promise<Ma2Catalog>>(), renameMa2Object = vi.fn<(request: Ma2RenameRequest) => Promise<Ma2RenameResult>>();
let remote = '';
const result = (request: Ma2RenameRequest): Ma2RenameResult => ({ sequence: 2, cue: '1.100', kind: 'single', show: source.show, generation: 'session', name: toConsoleLabel(request.change.name), backupFile: `tblink_label_${'a'.repeat(32)}.xml` });
function load(original = 'Original'): void {
  const project = saveMa2MaterialLibraryCommand(source.endpoint, { directory, readAt: new Date().toISOString(), fixtureUsage: [], errors: [],
    sequences: [{ sequence: 2, name: 'Sequence', cues: [{ index: 0, number: '1.100', name: original || null }] }] }).execute(createEmptyLinkProject('Rename'));
  store.getState().setProject(project, 'rename.tblink');
  remote = original;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'tblink.ma2-connection-method.v1' ? 'network' : null, setItem: () => undefined });
  vi.stubGlobal('window', { tbLink: { getMa2NetworkStatus: status, readMa2Catalog, renameMa2Object } });
  status.mockResolvedValue({ state: 'connected', settings: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test', autoConnect: false } });
  readMa2Catalog.mockResolvedValue({ directory, readAt: new Date().toISOString(), entries: [] });
  renameMa2Object.mockImplementation(request => { if (request.change.confirmedName !== remote) return Promise.reject(new Error('控台名称冲突')); remote = toConsoleLabel(request.change.name); return Promise.resolve(result(request)); });
  archive.mockResolvedValue('C:/archive.tblink');
  useMa2RealtimePreference.setState({ enabled: true });
  useMa2SyncStore.setState({ songs: {}, names: { state: 'idle', message: '' }, timelinePlaying: false, previewPlaying: false });
  load();
});
afterEach(() => { vi.unstubAllGlobals(); });

const tick = () => tickMa2SongSync(false);
const rename = (name: string) => store.getState().execute(renameConsoleCueCommand(ref, name, source));
const names = () => useMa2SyncStore.getState().names;

it('原名为空的 Cue 写入后能确认并保存，撤销历史保留真实空名', async () => {
  load(''); rename('666'); await tick();
  expect(remote).toBe('666');
  expect(pendingMa2Renames(store.getState().project)).toEqual([]);
  expect(names()).toMatchObject({ state: 'verified', message: '名称已写入控台并回读确认' });
  expect(parseLinkProject(JSON.parse(JSON.stringify(store.getState().project))).ma2MaterialLibrary?.library?.sequences[0]?.cues[0]?.name).toBe('666');
  store.getState().undo();
  expect(pendingMa2Renames(store.getState().project)[0]).toMatchObject({ name: '', confirmedName: '666' });
  store.getState().redo();
  expect(pendingMa2Renames(store.getState().project)).toEqual([]);
});
it('同步暂停时不写入，打开后小数 Cue 中文改名；保存重开、撤销、重做正确', async () => {
  useMa2RealtimePreference.setState({ enabled: false });
  rename('中文面光'); await tick(); expect(remote).toBe('Original');
  expect(pendingMa2Renames(parseLinkProject(JSON.parse(JSON.stringify(store.getState().project))))).toHaveLength(1);
  useMa2RealtimePreference.setState({ enabled: true });
  await tick(); expect(remote).toBe('ZhongWenMianGuang'); expect(pendingMa2Renames(store.getState().project)).toEqual([]);
  expect(store.getState().past).toHaveLength(1);
  store.getState().undo(); await tick(); expect(remote).toBe('Original');
  store.getState().redo(); await tick(); expect(remote).toBe('ZhongWenMianGuang');
  expect(pendingMa2Renames(parseLinkProject(JSON.parse(JSON.stringify(store.getState().project))))).toEqual([]);
});
it('播放中暂存；停止后改名，无时间线或执行器也可同步', async () => {
  useMa2SyncStore.setState({ timelinePlaying: true }); rename('Front'); await tickMa2SongSync(true);
  expect(renameMa2Object).not.toHaveBeenCalled(); expect(names().state).toBe('pending'); expect(names().message).toContain('播放中');
  useMa2SyncStore.setState({ timelinePlaying: false }); await tick(); expect(remote).toBe('Front');
});
it('分类页改名并保存浏览位置后，一次撤销仍恢复上一个名称', async () => {
  rename('First'); store.getState().undo(); store.getState().redo();
  const id = store.getState().project!.ma2MaterialLibrary!.userLibrary!.entries[0]!.id;
  store.getState().execute(renameLightingLibraryEntryCommand(id, 'Second'));
  store.getState().execute(setLightingLibraryViewCommand({ section: 'front', tone: 'bright', people: 3, zone: 'front', view: 'music', effectCategory: 'effect:music:0', scope: 'category', query: '' }));
  await tick(); expect(remote).toBe('Second');
  store.getState().undo(); expect(pendingMa2Renames(store.getState().project)[0]?.name).toBe('First');
  await tick(); expect(remote).toBe('First');
});
it('写入期间再次改名，回读不覆盖新名；暂停同步仍确认在途写入，不再发下一笔', async () => {
  rename('First');
  let finish: ((value: Ma2RenameResult) => void) | undefined;
  let request: Ma2RenameRequest | undefined;
  renameMa2Object.mockImplementation(value => { request = value; return new Promise(resolve => { finish = resolve; }); });
  const running = tick(); await vi.waitFor(() => expect(finish).toBeDefined());
  expect(names().writing).toBe(true);
  rename('Second'); useMa2RealtimePreference.setState({ enabled: false }); finish!(result(request!)); await running;
  expect(pendingMa2Renames(store.getState().project)[0]).toMatchObject({ confirmedName: 'First', name: 'Second' });
  expect(renameMa2Object).toHaveBeenCalledOnce();
  expect(names()).toMatchObject({ state: 'pending', writing: false });
});
it('超时或冲突后保留改名，不自动重试或冒充确认；再改一次才重新发', async () => {
  rename('Changed');
  renameMa2Object.mockRejectedValue(new Error('结果未知'));
  await tick(); await tick(); expect(renameMa2Object).toHaveBeenCalledOnce();
  expect(pendingMa2Renames(store.getState().project)).toHaveLength(1);
  expect(names().state).toBe('blocked'); expect(names().message).toContain('结果未知');
  rename('Changed again'); await tick(); expect(renameMa2Object).toHaveBeenCalledTimes(2);
});
it('断线时改名等待连接，不算失败', async () => {
  rename('Changed');
  status.mockResolvedValue({ state: 'disconnected' });
  await tick();
  expect(renameMa2Object).not.toHaveBeenCalled(); expect(names().state).toBe('pending'); expect(names().message).toContain('等待控台连接');
});
it('控台 Show 换了名字：改名先不发，等工程的控台引用跟过去再发；同步不停下（2026-10-30）', async () => {
  rename('Changed');
  readMa2Catalog.mockResolvedValue({ directory: { ...directory, show: 'Other' }, readAt: new Date().toISOString(), entries: [] });
  await tick(); expect(renameMa2Object).not.toHaveBeenCalled();
  expect(names()).toMatchObject({ state: 'pending', message: MOVED_RENAMES });
});
it('特殊命令字符被拒绝；英文、中文及单引号可用', () => {
  expect(() => rename('"; Off All')).toThrow(); expect(() => rename('New\nName')).toThrow();
  rename("Front's 白光"); expect(pendingMa2Renames(store.getState().project)[0]?.name).toBe("Front's 白光");
});

it('右键名称同步独立于歌曲：不为未关联 Cue 创建控台对象或提交时间线，撤销仍回写名称', async () => {
  const project = structuredClone(store.getState().project!);
  project.schemaVersion = 2;
  const lighting = createLightingDocument();
  lighting.tracks = [lightingTrackSchema.parse({ id: 'track', name: '未关联歌曲', kind: 'ma2', color: '#abcdef', group: '', muted: false, solo: false, locked: false, channel: 1, controller: 7, portProfileId: '', noteNames: {}, clips: [{ id: 'clip', name: '编排', start: 0, duration: 10000, timeLock: 'time', muted: false, events: [{ id: 'cue', kind: 'ma2', at: 2000, action: 'goto', executor: '', sequence: 2, cue: '1.100', label: '歌曲点位' }] }] })];
  project.rundown = [{ id: 'song', title: '未确认配对的歌曲', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [], lighting }];
  store.getState().setProject(project, 'rename.tblink');
  rename('新的控台名称');
  await tick();
  expect(remote).toBe('XinDeKongTaiMingCheng');
  expect(store.getState().project?.rundown[0]?.lighting).toEqual(lighting);
  expect(names()).toMatchObject({ state: 'verified', message: '名称已写入控台并回读确认' });
  store.getState().undo(); await tick();
  expect(remote).toBe('Original');
});
