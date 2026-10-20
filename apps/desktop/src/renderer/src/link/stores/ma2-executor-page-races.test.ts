import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, type Ma2ExecutorPage, type Ma2ExecutorUpdateResult } from '@tb/schema';
import { useDocumentStore } from './document-store';
import { loadMa2ExecutorPage, prepareMa2ExecutorPages, scanMa2ExecutorLocations, updateMa2ExecutorPageItem, useMa2ExecutorPageStore } from './ma2-executor-page-store';
const { context, read, directory, update, connection } = vi.hoisted(() => ({ context: { scope: 'test' }, read: vi.fn(), directory: vi.fn(), update: vi.fn(), connection: vi.fn() }));
vi.mock('./ma2-layout-store', () => ({ currentMa2LayoutScope: () => context.scope, ma2LayoutConnection: connection }));
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Uninitialized promise'); };
  let reject: (reason: Error) => void = () => { throw new Error('Uninitialized promise'); };
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}
const target = { network: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' }, expectedSource: { show: 'Show', generation: 'g', version: '3.7.0.5' } };
const snapshot = (name = '原名称'): Ma2ExecutorPage => ({ page: 4, name: '页', readAt: '2026-10-20T00:00:00.000Z', sequences: [], items: [{ slot: 101, width: 1, name, kind: 'sequence', sequence: 1, button: 12299, reference: ['25', '1', '1'] }] });
beforeEach(() => {
  vi.resetAllMocks(); context.scope = crypto.randomUUID(); prepareMa2ExecutorPages();
  const project = createEmptyLinkProject('并发'); project.schemaVersion = 2;
  project.ma2MaterialLibrary = { version: 1, source: '192.0.2.1:30000', library: { directory: { ...target.expectedSource, entries: [] }, readAt: snapshot().readAt, sequences: [], fixtureUsage: [], errors: [] } };
  useDocumentStore.getState().setProject(project, 'races.tblink');
  connection.mockResolvedValue(target); read.mockResolvedValue(snapshot());
  directory.mockResolvedValue({ ...target.expectedSource, buttonPage: 4, faderPage: 4, pages: [{ page: 4, name: '页' }] });
  update.mockResolvedValue({ pages: [snapshot('新名')], backupFile: 'C:/backup.xml' });
  vi.stubGlobal('window', { tbLink: { readMa2ExecutorPage: read, listMa2ExecutorPages: directory, updateMa2Executor: update } });
});
afterEach(() => vi.unstubAllGlobals());
it('前台旧读取被写回淘汰时清除busy，不会永久显示读取中', async () => {
  const pending = deferred<Ma2ExecutorPage>(); read.mockReturnValueOnce(pending.promise);
  const reading = loadMa2ExecutorPage(4);
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  expect(useMa2ExecutorPageStore.getState().busy).toBe(true);
  await updateMa2ExecutorPageItem(4, snapshot().items[0]!, { kind: 'rename', name: '新名' });
  pending.resolve(snapshot()); await reading;
  expect(useMa2ExecutorPageStore.getState()).toMatchObject({ busy: false, requestId: null });
  expect(useMa2ExecutorPageStore.getState().pages[4]!.items[0]!.name).toBe('新名');
});
it('旧页读取迟到失败不会覆盖已回读成功页面的状态', async () => {
  const pending = deferred<Ma2ExecutorPage>(); read.mockReturnValueOnce(pending.promise);
  const reading = loadMa2ExecutorPage(4); const failure = expect(reading).rejects.toThrow('旧连接');
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  await updateMa2ExecutorPageItem(4, snapshot().items[0]!, { kind: 'rename', name: '新名' });
  pending.reject(new Error('旧连接')); await failure;
  expect(useMa2ExecutorPageStore.getState()).toMatchObject({ busy: false, requestId: null, pageErrors: { 4: '' }, error: '' });
});
it('等待连接期间切换工程不能把旧选择的删除发送给新工程控台', async () => {
  const pending = deferred<typeof target>(); connection.mockReturnValueOnce(pending.promise);
  const writing = updateMa2ExecutorPageItem(4, snapshot().items[0]!, { kind: 'delete' });
  const failure = expect(writing).rejects.toThrow('未修改执行器');
  context.scope = 'another'; prepareMa2ExecutorPages();
  pending.resolve(target); await failure;
  expect(update).not.toHaveBeenCalled();
});
it('全量扫描期间写回淘汰旧快照时，不能宣称所有位置完整', async () => {
  const pending = deferred<Ma2ExecutorPage>(); read.mockReturnValueOnce(pending.promise);
  const scanning = scanMa2ExecutorLocations(); const failure = expect(scanning).rejects.toThrow('执行器已有修改');
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  await updateMa2ExecutorPageItem(4, snapshot().items[0]!, { kind: 'rename', name: '新名' });
  pending.resolve(snapshot()); await failure;
  expect(useMa2ExecutorPageStore.getState()).toMatchObject({ complete: false, scanning: false });
});

function captureScope(): void {
  const state = useDocumentStore.getState();
  const material = state.project?.ma2MaterialLibrary;
  const source = material?.library?.directory;
  context.scope = JSON.stringify([state.documentId, material?.source, source?.show, source?.generation, source?.version, material?.library?.sourceUnverified]);
}
function installTimeline(): void {
  const project = structuredClone(useDocumentStore.getState().project!);
  const lighting = createLightingDocument();
  lighting.tracks = [{ id: 't', name: '灯光', kind: 'ma2', color: '#abcdef', group: '', muted: false, solo: false, locked: false, channel: 1, controller: 7, portProfileId: '', noteNames: {},
    cueStamp: { mode: 'fixed', sequence: 1, cue: '1', executor: '4.101' },
    clips: [{ id: 'c', name: '开场', start: 0, duration: 1000, timeLock: 'time', muted: false, events: [{ id: 'e', kind: 'ma2', at: 0, action: 'goto', cue: '1', sequence: 1, executor: '4.101', label: '亮灯' }] }] }];
  lighting.ma2Bindings = [{ id: 'binding', timecode: 99, name: 'Timecode', readAt: snapshot().readAt, sourceXml: '<MA>原始证据</MA>', baselineTracks: structuredClone(lighting.tracks),
    mappings: [{ trackId: 't', clipId: 'c', eventId: 'e', executor: '4.101', sequence: 1, cueIndex: 1, path: 'Event:0' }],
    trackMappings: [{ trackId: 't', executor: '4.101', path: 'Track:0', subtracks: ['SubTrack:0'] }] }];
  project.rundown = [{ id: 'song', title: '曲', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting }];
  project.ma2MaterialLibrary!.library!.sequences = [{ sequence: 1, name: '当前元数据', cues: [{ index: 1, number: '1.000', name: '亮灯' }] }];
  useDocumentStore.getState().setProject(project, 'races.tblink');
  captureScope(); prepareMa2ExecutorPages();
}
function changeSource(change: 'generation' | 'show' | 'endpoint' | 'version' | 'unverified'): void {
  useDocumentStore.getState().execute({
    id: crypto.randomUUID(), label: '测试控台来源变化', scope: 'lighting',
    execute(project) {
      const next = structuredClone(project);
      const material = next.ma2MaterialLibrary!;
      const library = material.library!;
      switch (change) {
        case 'generation': library.directory.generation = 'next-generation'; break;
        case 'show': library.directory.show = 'Other Show'; break;
        case 'endpoint': material.source = '192.0.2.2:30000'; break;
        case 'version': library.directory.version = '3.9.60.74'; break;
        case 'unverified': library.sourceUnverified = true; break;
      }
      return next;
    },
    undo: before => before
  });
  captureScope();
}
it.each(['move', 'delete', 'rename'] as const)('原生%s回包前仅刷新桥会话，保留本地引用迁移但不合并旧会话快照和元数据', async kind => {
  installTimeline();
  const pending = deferred<Ma2ExecutorUpdateResult>(); update.mockReturnValueOnce(pending.promise);
  const action = kind === 'move' ? { kind, page: 4, slot: 102 } : kind === 'rename' ? { kind, name: '控台新名' } : { kind };
  const writing = updateMa2ExecutorPageItem(4, snapshot().items[0]!, action);
  await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
  changeSource('generation');
  const fresh = snapshot('新会话快照');
  // Cover both a render that already prepared the new scope and a reply that
  // arrives before React has reset the page store.
  if (kind !== 'delete') {
    prepareMa2ExecutorPages();
    useMa2ExecutorPageStore.setState({ pages: { 4: fresh } });
  }
  pending.resolve({ pages: [{ ...snapshot('旧会话回包'), sequences: [{ sequence: 1, name: '旧会话元数据', cues: [] }] }], backupFile: 'C:/backup.xml' });
  await writing;
  const project = useDocumentStore.getState().project!;
  const lighting = project.rundown[0]!.lighting!;
  const expected = kind === 'move' ? '4.102' : kind === 'delete' ? '' : '4.101';
  expect(lighting.tracks[0]!.cueStamp).toMatchObject({ executor: expected });
  expect(lighting.tracks[0]!.clips[0]!.events[0]).toMatchObject({ executor: expected });
  if (kind === 'move') {
    expect(lighting.ma2Bindings![0]!.mappings[0]).toMatchObject({ executor: expected });
    expect(lighting.ma2Bindings![0]!.trackMappings![0]).toMatchObject({ executor: expected });
  }
  expect(lighting.ma2Bindings![0]!.baselineTracks[0]!.cueStamp).toMatchObject({ executor: '4.101' });
  expect(project.ma2MaterialLibrary!.library!.directory.generation).toBe('next-generation');
  expect(project.ma2MaterialLibrary!.library!.sequences[0]!.name).toBe('当前元数据');
  expect(useMa2ExecutorPageStore.getState()).toMatchObject({ scope: context.scope, mutating: false, pages: kind === 'delete' ? {} : { 4: fresh } });
  expect(update).toHaveBeenCalledOnce();
});
it.each(['document', 'show', 'endpoint', 'version', 'unverified'] as const)('原生移动回包前切换%s，拒绝假成功且保留当前工程与快照', async change => {
  installTimeline();
  const pending = deferred<Ma2ExecutorUpdateResult>(); update.mockReturnValueOnce(pending.promise);
  const writing = updateMa2ExecutorPageItem(4, snapshot().items[0]!, { kind: 'move', page: 5, slot: 102 });
  const failure = expect(writing).rejects.toThrow(/已写入并回读：4\.101 → 5\.102.*本地结果未应用.*返回原工程与控台.*备份：C:\/backup\.xml/);
  await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
  if (change === 'document') {
    // Same console and identical contents still belong to a new document.
    useDocumentStore.getState().setProject(structuredClone(useDocumentStore.getState().project!), 'other.tblink');
    captureScope();
  } else changeSource(change);
  prepareMa2ExecutorPages();
  const fresh = snapshot('当前来源快照'); useMa2ExecutorPageStore.setState({ pages: { 4: fresh } });
  const beforeReply = useDocumentStore.getState().project;
  pending.resolve({ pages: [snapshot('旧来源回包')], backupFile: 'C:/backup.xml' });
  await failure;
  expect(useDocumentStore.getState().project).toBe(beforeReply);
  expect(useDocumentStore.getState().project!.rundown[0]!.lighting!.tracks[0]!.cueStamp).toMatchObject({ executor: '4.101' });
  expect(useMa2ExecutorPageStore.getState()).toMatchObject({ scope: context.scope, pages: { 4: fresh }, mutating: false });
  expect(update).toHaveBeenCalledOnce();
});
