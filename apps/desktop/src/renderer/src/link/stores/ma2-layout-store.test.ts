import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, type Ma2LayoutSnapshot } from '@tb/schema';
import { useDocumentStore } from './document-store';
import { acceptCreatedMa2Layout, currentMa2LayoutScope, readMa2LayoutPage, useMa2LayoutStore } from './ma2-layout-store';

const read = vi.hoisted(() => vi.fn());
const connection = vi.hoisted(() => vi.fn());
vi.mock('./ma2-material-read-store', () => ({ ma2MaterialConnection: connection }));
const snapshot = (layout: number): Ma2LayoutSnapshot => ({ layout, name: `页面 ${layout}`, items: [], omittedFixtures: 0, readAt: new Date().toISOString() });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('window', { tbLink: { readMa2Layout: read } });
  connection.mockResolvedValue({ network: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' } });
  const project = createEmptyLinkProject('页面读取');
  project.schemaVersion = 2;
  project.ma2MaterialLibrary = { version: 1, source: '192.0.2.1:30000', library: { directory: { show: 'Show', generation: 'session', version: '3.7', entries: [] }, readAt: new Date().toISOString(), sequences: [], fixtureUsage: [], errors: [] } };
  useDocumentStore.getState().setProject(project, 'test.tblink');
  useMa2LayoutStore.setState({ scope: '', page: 999, snapshot: null, busy: false, error: '', requestId: null });
});

afterEach(() => vi.unstubAllGlobals());

it('翻页失败立即清除旧页面，不自动重试，也不修改工程的新建目标', async () => {
  const before = useDocumentStore.getState().project;
  read.mockResolvedValueOnce(snapshot(999)).mockRejectedValueOnce(new Error('控台未响应'));
  await readMa2LayoutPage(999);
  await expect(readMa2LayoutPage(1000)).rejects.toThrow('控台未响应');
  expect(useMa2LayoutStore.getState()).toMatchObject({ page: 1000, snapshot: null, busy: false, error: '控台未响应' });
  expect(read).toHaveBeenCalledTimes(2);
  expect(useDocumentStore.getState().project).toBe(before);
});

it('读取中切换工程，迟到结果不能污染新工程', async () => {
  let release: ((value: Ma2LayoutSnapshot) => void) | undefined;
  read.mockImplementation(() => new Promise<Ma2LayoutSnapshot>(resolve => { release = resolve; }));
  const task = readMa2LayoutPage(999);
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  useDocumentStore.getState().setProject(createEmptyLinkProject('另一工程'), 'other.tblink');
  release!(snapshot(999));
  await expect(task).rejects.toThrow('工程或素材来源变了');
  expect(useMa2LayoutStore.getState().snapshot).toBeNull();
});

it('错误页码、错误来源和错误返回页均不显示可操作的旧按钮', async () => {
  await expect(readMa2LayoutPage(0)).rejects.toThrow('页面编号');
  await expect(readMa2LayoutPage(1.5)).rejects.toThrow('页面编号');
  await expect(readMa2LayoutPage(10000)).rejects.toThrow('页面编号');
  expect(connection).not.toHaveBeenCalled();
  connection.mockResolvedValueOnce({ network: { host: '192.0.2.2', port: 30000 } });
  await expect(readMa2LayoutPage(999)).rejects.toThrow('不是同一台');
  expect(read).not.toHaveBeenCalled();
  read.mockResolvedValue(snapshot(998));
  await expect(readMa2LayoutPage(999)).rejects.toThrow('编号不一致');
  expect(useMa2LayoutStore.getState().snapshot).toBeNull();
});

it('新建成功的回读显示到对应页面，拒绝旧工程的新建结果', () => {
  const scope = currentMa2LayoutScope();
  acceptCreatedMa2Layout(scope, snapshot(999));
  expect(useMa2LayoutStore.getState().snapshot?.layout).toBe(999);
  useDocumentStore.getState().setProject(createEmptyLinkProject('另一工程'), 'other.tblink');
  expect(() => acceptCreatedMa2Layout(scope, snapshot(999))).toThrow('工程或素材来源变了');
});

it('后台歌曲回读不能抢走用户正在浏览的页面', () => {
  const scope = currentMa2LayoutScope();
  acceptCreatedMa2Layout(scope, snapshot(1000));
  acceptCreatedMa2Layout(scope, snapshot(999), false);
  expect(useMa2LayoutStore.getState().page).toBe(1000);
  acceptCreatedMa2Layout(scope, { ...snapshot(1000), name: '控台改名' }, false);
  expect(useMa2LayoutStore.getState().snapshot?.name).toBe('控台改名');
});
