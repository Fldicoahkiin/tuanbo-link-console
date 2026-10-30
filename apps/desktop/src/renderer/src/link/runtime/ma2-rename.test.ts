import { expect, it, vi } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, lightingTrackSchema, parseLinkProject, type Ma2RenameRequest, type Ma2RenameResult } from '@tb/schema';
import { saveMa2MaterialLibraryCommand, renameConsoleCueCommand, renameLightingLibraryEntryCommand, setLightingLibraryViewCommand, pendingMa2Renames, toConsoleLabel } from '@tb/core/link';
import { Ma2AutoSync, type Ma2AutoSyncDependencies } from './ma2-auto-sync';
import { useDocumentStore as store } from '../stores/document-store';

const source = { endpoint: '192.0.2.1:30000', show: 'Test' };
const ref = { sequence: 2, cue: '1.100', kind: 'single' as const };
function setup(original = 'Original') {
  const directory = { show: source.show, generation: 'session', version: '3.7.0.5', entries: [] };
  const project = saveMa2MaterialLibraryCommand(source.endpoint, { directory, readAt: new Date().toISOString(), fixtureUsage: [], errors: [],
    sequences: [{ sequence: 2, name: 'Sequence', cues: [{ index: 0, number: '1.100', name: original || null }] }] }).execute(createEmptyLinkProject('Rename'));
  store.getState().setProject(project, null);
  let playing = false;
  let remote = original;
  const catalog = { directory, readAt: new Date().toISOString(), entries: [] };
  const result = (request: Ma2RenameRequest): Ma2RenameResult => ({ sequence: 2, cue: '1.100', kind: 'single', show: source.show, generation: 'session', name: toConsoleLabel(request.change.name), backupFile: `tblink_label_${'a'.repeat(32)}.xml` });
  const dependencies: Ma2AutoSyncDependencies = {
    state: () => ({ ...store.getState(), playing }), catalog: vi.fn(() => Promise.resolve(catalog)),
    prepare: () => Promise.reject(new Error('Unexpected prepare')), read: () => Promise.reject(new Error('Unexpected read')),
    compare: () => Promise.reject(new Error('Unexpected compare')), apply: () => Promise.reject(new Error('Unexpected apply')),
    rename: vi.fn<Ma2AutoSyncDependencies['rename']>(request => { if (request.change.confirmedName !== remote) return Promise.reject(new Error('控台名称冲突')); remote = toConsoleLabel(request.change.name); return Promise.resolve(result(request)); }),
    archive: vi.fn(() => Promise.resolve('archive')), execute: (id, command) => store.getState().executeForDocument(id, command), changed: vi.fn()
  };
  const runner = new Ma2AutoSync(dependencies);
  const start = (scope: 'all' | 'names' = 'all') => runner.start({ dataDirectory: '', network: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' } }, catalog, scope);
  const rename = (name: string) => store.getState().execute(renameConsoleCueCommand(ref, name, source));
  return { runner, dependencies, start, rename, remote: () => remote, result, play: (value: boolean) => { playing = value; } };
}
it('原名为空的 Cue 写入后能确认并保存，撤销历史保留真实空名', async () => {
  const t = setup(''); t.rename('666'); t.start('names'); await t.runner.tick();
  expect(t.remote()).toBe('666');
  expect(pendingMa2Renames(store.getState().project)).toEqual([]);
  expect(t.dependencies.changed).toHaveBeenLastCalledWith('verified', '名称已写入控台并回读确认');
  expect(parseLinkProject(JSON.parse(JSON.stringify(store.getState().project))).ma2MaterialLibrary?.library?.sequences[0]?.cues[0]?.name).toBe('666');
  store.getState().undo();
  expect(pendingMa2Renames(store.getState().project)[0]).toMatchObject({ name: '', confirmedName: '666' });
  store.getState().redo();
  expect(pendingMa2Renames(store.getState().project)).toEqual([]);
});
it('开关关闭不写入，开启后小数 Cue 中文改名；保存重开、撤销、重做正确', async () => {
  const t = setup(); t.rename('中文面光'); await t.runner.tick(); expect(t.remote()).toBe('Original');
  expect(pendingMa2Renames(parseLinkProject(JSON.parse(JSON.stringify(store.getState().project))))).toHaveLength(1);
  t.start(); await t.runner.tick(); expect(t.remote()).toBe('ZhongWenMianGuang'); expect(pendingMa2Renames(store.getState().project)).toEqual([]);
  expect(store.getState().past).toHaveLength(1);
  store.getState().undo(); await t.runner.tick(); expect(t.remote()).toBe('Original');
  store.getState().redo(); await t.runner.tick(); expect(t.remote()).toBe('ZhongWenMianGuang');
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
it('控台 Show 换了名字：改名先不发，等工程的控台引用跟过去再发；同步不停下（2026-10-30）', async () => {
  const t = setup(); t.start(); t.rename('Changed');
  const catalog = await t.dependencies.catalog({ dataDirectory: '' });
  t.dependencies.catalog = () => Promise.resolve({ ...catalog, directory: { ...catalog.directory, show: 'Other' } });
  await t.runner.tick(); expect(t.dependencies.rename).not.toHaveBeenCalled();
  expect(t.dependencies.changed).toHaveBeenLastCalledWith('staged', '控台换了 Show 名或地址，改名等核对完再发到控台');
});
it('特殊命令字符被拒绝；英文、中文及单引号可用', () => {
  const t = setup(); expect(() => t.rename('"; Off All')).toThrow(); expect(() => t.rename('New\nName')).toThrow();
  t.rename("Front's 白光"); expect(pendingMa2Renames(store.getState().project)[0]?.name).toBe("Front's 白光");
});

it('右键名称同步独立于歌曲：不为未关联 Cue 创建控台对象或提交时间线，撤销仍回写名称', async () => {
  const t = setup();
  const project = structuredClone(store.getState().project!);
  project.schemaVersion = 2;
  const lighting = createLightingDocument();
  lighting.tracks = [lightingTrackSchema.parse({ id: 'track', name: '未关联歌曲', kind: 'ma2', color: '#abcdef', group: '', muted: false, solo: false, locked: false, channel: 1, controller: 7, portProfileId: '', noteNames: {}, clips: [{ id: 'clip', name: '编排', start: 0, duration: 10000, timeLock: 'time', muted: false, events: [{ id: 'cue', kind: 'ma2', at: 2000, action: 'goto', executor: '', sequence: 2, cue: '1.100', label: '歌曲点位' }] }] })];
  project.rundown = [{ id: 'song', title: '未确认配对的歌曲', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [], lighting }];
  store.getState().setProject(project, null);
  t.rename('新的控台名称'); t.start('names');
  await t.runner.tick();
  expect(t.remote()).toBe('XinDeKongTaiMingCheng');
  expect(store.getState().project?.rundown[0]?.lighting).toEqual(lighting);
  expect(t.dependencies.changed).toHaveBeenLastCalledWith('verified', '名称已写入控台并回读确认');
  store.getState().undo(); await t.runner.tick();
  expect(t.remote()).toBe('Original');
});
