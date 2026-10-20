import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, type Ma2ExecutorPage } from '@tb/schema';
import { useDocumentStore } from './document-store';
import { loadMa2ExecutorDirectory, loadMa2ExecutorPage, locateMa2Executor, ma2SequenceLocations, prepareMa2ExecutorPages, scanMa2ExecutorLocations, selectMa2ExecutorBandPage, selectMa2ExecutorPageKind, updateMa2ExecutorPageItem, useMa2ExecutorPageStore } from './ma2-executor-page-store';
const { context, read, directory, update } = vi.hoisted(() => ({ context: { scope: 'test' }, read: vi.fn(), directory: vi.fn(), update: vi.fn() }));
vi.mock('./ma2-layout-store', () => ({ currentMa2LayoutScope: () => context.scope, ma2LayoutConnection: () => Promise.resolve({ network: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' }, expectedSource: { show: 'Show', generation: 'g', version: '3.7.0.5' } }) }));
function snapshot(page: number, name = '原名称'): Ma2ExecutorPage {
  return { page, name: '页面', readAt: '2026-10-20T00:00:00.000Z', sequences: [], items: [{ slot: 101, width: 1, name, kind: 'sequence', sequence: 1, button: 12299, reference: ['1'] }] };
}
beforeEach(() => {
  vi.clearAllMocks(); context.scope = crypto.randomUUID(); prepareMa2ExecutorPages();
  const project = createEmptyLinkProject('页面'); project.schemaVersion = 2;
  project.ma2MaterialLibrary = { version: 1, source: '192.0.2.1:30000', library: { directory: { show: 'Show', generation: 'g', version: '3.7.0.5', entries: [] }, readAt: '2026-10-20T00:00:00.000Z', sequences: [], errors: [], fixtureUsage: [] } };
  useDocumentStore.getState().setProject(project, 'pages.tblink');
  read.mockImplementation(({ page }: { page: number }) => Promise.resolve(snapshot(page)));
  directory.mockResolvedValue({ show: 'Show', generation: 'g', version: '3.7.0.5', buttonPage: 4, faderPage: 100, pages: [{ page: 4, name: '上' }, { page: 100, name: '下' }] });
  vi.stubGlobal('window', { tbLink: { readMa2ExecutorPage: read, listMa2ExecutorPages: directory, updateMa2Executor: update } });
});
afterEach(() => vi.unstubAllGlobals());
it('三层默认页来自原控台，改页互不影响，定位可找到指定层', async () => {
  await loadMa2ExecutorDirectory();
  expect(useMa2ExecutorPageStore.getState().bandPages).toEqual({ upper: 4, fader: 100, lower: 100 });
  selectMa2ExecutorBandPage('lower', 8);
  locateMa2Executor(1000, 2);
  expect(useMa2ExecutorPageStore.getState().bandPages).toEqual({ upper: 4, fader: 1000, lower: 8 });
});
it('同 Show 的连接组件升级只清旧数据，不把用户正在看的分页跳回默认', async () => {
  context.scope = JSON.stringify([5, '192.0.2.1:30000', 'Show', 'old', '3.7.0.5', false]);
  prepareMa2ExecutorPages(); await loadMa2ExecutorDirectory();
  selectMa2ExecutorBandPage('upper', 120); await loadMa2ExecutorPage(120, true);
  context.scope = JSON.stringify([5, '192.0.2.1:30000', 'Show', 'new', '3.7.0.5', false]);
  prepareMa2ExecutorPages();
  expect(useMa2ExecutorPageStore.getState().bandPages).toEqual({ upper: 120, fader: 100, lower: 100 });
  expect(useMa2ExecutorPageStore.getState().pages).toEqual({});
});
it('同页读取去重，某页出错保留最后回读快照且不清空其他页', async () => {
  await Promise.all([loadMa2ExecutorPage(4, true), loadMa2ExecutorPage(4, true)]);
  expect(read).toHaveBeenCalledTimes(1);
  await loadMa2ExecutorPage(100, true);
  read.mockRejectedValueOnce(new Error('短暂断开'));
  await expect(loadMa2ExecutorPage(4, true)).rejects.toThrow('短暂断开');
  const state = useMa2ExecutorPageStore.getState();
  expect(state.pages[4]?.items[0]?.name).toBe('原名称');
  expect(state.pages[100]?.items).toHaveLength(1);
  expect(state.pageErrors[4]).toBe('短暂断开');
});
it('写回确认前不改名称；确认后使用回读快照，不再多读一次整页', async () => {
  const old = await loadMa2ExecutorPage(4, true);
  let confirm: (value: unknown) => void = () => { throw new Error('未开始写入'); };
  update.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
  const pending = updateMa2ExecutorPageItem(4, old.items[0]!, { kind: 'rename', name: '新名' });
  await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
  expect(useMa2ExecutorPageStore.getState().pages[4]?.items[0]?.name).toBe('原名称');
  confirm({ pages: [snapshot(4, '新名')], backupFile: 'C:/backup.xml' });
  await pending;
  expect(useMa2ExecutorPageStore.getState().pages[4]?.items[0]?.name).toBe('新名');
  expect(read).toHaveBeenCalledOnce();
});
it('写回期间旧页面迟到不会覆盖已确认的新名称', async () => {
  const old = await loadMa2ExecutorPage(4, true);
  let finish: (value: unknown) => void = () => { throw new Error('未开始读取'); };
  read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const reading = loadMa2ExecutorPage(4, true);
  update.mockResolvedValueOnce({ pages: [snapshot(4, '新名')], backupFile: 'C:/backup.xml' });
  await updateMa2ExecutorPageItem(4, old.items[0]!, { kind: 'rename', name: '新名' });
  finish(snapshot(4)); await reading;
  expect(useMa2ExecutorPageStore.getState().pages[4]?.items[0]?.name).toBe('新名');
});
it('换工程重置全部分页、位置缓存；保留旧按钮页和推杆页的独立定位', async () => {
  await loadMa2ExecutorDirectory();
  selectMa2ExecutorPageKind('button'); await loadMa2ExecutorPage(5);
  selectMa2ExecutorPageKind('fader'); await loadMa2ExecutorPage(100);
  selectMa2ExecutorPageKind('button'); expect(useMa2ExecutorPageStore.getState().page).toBe(5);
  context.scope = crypto.randomUUID(); prepareMa2ExecutorPages();
  expect(useMa2ExecutorPageStore.getState()).toMatchObject({ pages: {}, navigation: 0, bandPages: { upper: null, fader: null, lower: null } });
});
it('扫描显示真实页数且不改变当前页；目录变化撤销全量完整标记', async () => {
  await loadMa2ExecutorPage(5); await scanMa2ExecutorLocations();
  const state = useMa2ExecutorPageStore.getState();
  expect(state).toMatchObject({ page: 5, completed: 2, total: 2, complete: true, scanning: false });
  expect(ma2SequenceLocations(state.pages, 1)).toEqual([{ page: 4, slot: 101 }, { page: 100, slot: 101 }]);
  directory.mockResolvedValueOnce({ show: 'Show', generation: 'g', version: '3.7.0.5', buttonPage: 4, faderPage: 100, pages: [{ page: 100, name: '下' }, { page: 1000, name: '新' }] });
  await loadMa2ExecutorDirectory();
  expect(useMa2ExecutorPageStore.getState().complete).toBe(false);
  expect(useMa2ExecutorPageStore.getState().pages[4]).toBeUndefined();
});
it('部分扫描失败不显示全部完成，乱序元数据不产生重复工程修改', async () => {
  read.mockRejectedValueOnce(new Error('扫描中断'));
  await expect(scanMa2ExecutorLocations()).rejects.toThrow('扫描中断');
  expect(useMa2ExecutorPageStore.getState()).toMatchObject({ complete: false, scanning: false, completed: 0 });
  const sequences = [1, 2].map(sequence => ({ sequence, name: `s${sequence}`, cues: [{ index: 1, number: '1.000', name: 'Cue' }] }));
  read.mockResolvedValue({ ...snapshot(4), sequences }); await loadMa2ExecutorPage(4);
  const revision = useDocumentStore.getState().revision;
  read.mockResolvedValue({ ...snapshot(4), sequences: [...sequences].reverse() }); await loadMa2ExecutorPage(4);
  expect(useDocumentStore.getState().revision).toBe(revision);
});
