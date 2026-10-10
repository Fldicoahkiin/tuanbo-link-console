import { expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type Ma2RenameRequest, type Ma2RenameResult } from '@tb/schema';
import { saveMa2MaterialLibraryCommand, renameConsoleCueCommand, renameLightingLibraryEntryCommand, setLightingLibraryViewCommand, pendingMa2Renames } from '@tb/core/link';
import { Ma2AutoSync, type Ma2AutoSyncDependencies } from './ma2-auto-sync';
import { useDocumentStore as store } from '../stores/document-store';

const source = { endpoint: '192.0.2.1:30000', show: 'Test' };
const ref = { sequence: 2, cue: '1.100', kind: 'single' as const };
function setup() {
  const directory = { show: source.show, generation: 'session', version: '3.7.0.5', entries: [] };
  const project = saveMa2MaterialLibraryCommand(source.endpoint, { directory, readAt: new Date().toISOString(), fixtureUsage: [], errors: [],
    sequences: [{ sequence: 2, name: 'Sequence', cues: [{ index: 0, number: '1.100', name: 'Original' }] }] }).execute(createEmptyLinkProject('Rename'));
  store.getState().setProject(project, null);
  let playing = false;
  let remote = 'Original';
  const catalog = { directory, readAt: new Date().toISOString(), entries: [] };
  const result = (request: Ma2RenameRequest): Ma2RenameResult => ({ sequence: 2, cue: '1.100', kind: 'single', show: source.show, generation: 'session', name: request.change.name, backupFile: `tblink_label_${'a'.repeat(32)}.xml` });
  const dependencies: Ma2AutoSyncDependencies = {
    state: () => ({ ...store.getState(), playing }), catalog: vi.fn(() => Promise.resolve(catalog)),
    prepare: () => Promise.reject(new Error('Unexpected prepare')), read: () => Promise.reject(new Error('Unexpected read')),
    compare: () => Promise.reject(new Error('Unexpected compare')), apply: () => Promise.reject(new Error('Unexpected apply')),
    rename: vi.fn<Ma2AutoSyncDependencies['rename']>(request => { if (request.change.confirmedName !== remote) return Promise.reject(new Error('控台名称冲突')); remote = request.change.name; return Promise.resolve(result(request)); }),
    archive: vi.fn(() => Promise.resolve('archive')), execute: (id, command) => store.getState().executeForDocument(id, command), changed: vi.fn()
  };
  const runner = new Ma2AutoSync(dependencies);
  const start = () => runner.start({ dataDirectory: '', network: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' } }, catalog);
  const rename = (name: string) => store.getState().execute(renameConsoleCueCommand(ref, name, source));
  return { runner, dependencies, start, rename, remote: () => remote, result, play: (value: boolean) => { playing = value; } };
}
it('开关关闭不写入，开启后小数 Cue 中文改名；保存重开、撤销、重做正确', async () => {
  const t = setup(); t.rename('中文面光'); await t.runner.tick(); expect(t.remote()).toBe('Original');
  expect(pendingMa2Renames(parseLinkProject(JSON.parse(JSON.stringify(store.getState().project))))).toHaveLength(1);
  t.start(); await t.runner.tick(); expect(t.remote()).toBe('中文面光'); expect(pendingMa2Renames(store.getState().project)).toEqual([]);
  expect(store.getState().past).toHaveLength(1);
  store.getState().undo(); await t.runner.tick(); expect(t.remote()).toBe('Original');
  store.getState().redo(); await t.runner.tick(); expect(t.remote()).toBe('中文面光');
  expect(pendingMa2Renames(parseLinkProject(JSON.parse(JSON.stringify(store.getState().project))))).toEqual([]);
});
it('播放中暂存；停止后改名，无时间线或执行器也可同步', async () => {
  const t = setup(); t.start(); t.play(true); t.rename('Front'); await t.runner.tick(); expect(t.dependencies.rename).not.toHaveBeenCalled();
  t.play(false); await t.runner.tick(); expect(t.remote()).toBe('Front');
});
it('分类页改名并保存浏览位置后，一次撤销仍恢复上一个名称', async () => {
  const t = setup(); t.rename('First'); store.getState().undo(); store.getState().redo();
  const id = store.getState().project!.ma2MaterialLibrary!.userLibrary!.entries[0]!.id;
  store.getState().execute(renameLightingLibraryEntryCommand(id, 'Second'));
  store.getState().execute(setLightingLibraryViewCommand({ section: 'front', tone: 'bright', people: 3, zone: 'front', view: 'music', effectCategory: 'effect:music:0', scope: 'category', query: '' }));
  t.start(); await t.runner.tick(); expect(t.remote()).toBe('Second');
  store.getState().undo(); expect(pendingMa2Renames(store.getState().project)[0]?.name).toBe('First');
  await t.runner.tick(); expect(t.remote()).toBe('First');
});
it('写入期间再次改名，回读不覆盖新名；关闭开关仍确认在途写入', async () => {
  const t = setup(); t.start(); t.rename('First');
  let finish: ((value: Ma2RenameResult) => void) | undefined;
  let request: Ma2RenameRequest | undefined;
  t.dependencies.rename = vi.fn<Ma2AutoSyncDependencies['rename']>(value => { request = value; return new Promise(resolve => { finish = resolve; }); });
  const running = t.runner.tick(); await vi.waitFor(() => expect(finish).toBeDefined());
  t.rename('Second'); t.runner.stop(); finish!(t.result(request!)); await running;
  expect(pendingMa2Renames(store.getState().project)[0]).toMatchObject({ confirmedName: 'First', name: 'Second' });
  expect(t.dependencies.changed).toHaveBeenLastCalledWith('off', expect.any(String));
});
it('超时或冲突后保留改名，不自动重试或冒充确认', async () => {
  const t = setup(); t.start(); t.rename('Changed');
  t.dependencies.rename = vi.fn(() => Promise.reject(new Error('结果未知')));
  await t.runner.tick(); await t.runner.tick(); expect(t.dependencies.rename).toHaveBeenCalledTimes(1);
  expect(pendingMa2Renames(store.getState().project)).toHaveLength(1);
  expect(t.dependencies.changed).toHaveBeenLastCalledWith('blocked', '结果未知');
});
it('换 Show 阻断，不把旧名称发送到新控台', async () => {
  const t = setup(); t.start(); t.rename('Changed');
  const catalog = await t.dependencies.catalog({ dataDirectory: '' });
  t.dependencies.catalog = () => Promise.resolve({ ...catalog, directory: { ...catalog.directory, show: 'Other' } });
  await t.runner.tick(); expect(t.dependencies.rename).not.toHaveBeenCalled();
  expect(t.dependencies.changed).toHaveBeenLastCalledWith('blocked', expect.stringContaining('Show'));
});
it('特殊命令字符被拒绝；英文、中文及单引号可用', () => {
  const t = setup(); expect(() => t.rename('"; Off All')).toThrow(); expect(() => t.rename('New\nName')).toThrow();
  t.rename("Front's 白光"); expect(pendingMa2Renames(store.getState().project)[0]?.name).toBe("Front's 白光");
});
