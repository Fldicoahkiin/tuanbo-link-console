import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, type Ma2ExecutorPage } from '@tb/schema';
import { useDocumentStore } from './document-store';
import { loadMa2ExecutorDirectory, loadMa2ExecutorPage, locateMa2Executor, ma2SequenceLocations, prepareMa2ExecutorPages, scanMa2ExecutorLocations, selectMa2ExecutorPageKind, useMa2ExecutorPageStore } from './ma2-executor-page-store';

const read = vi.hoisted(() => vi.fn()); const list = vi.hoisted(() => vi.fn()); const connection = vi.hoisted(() => vi.fn());
vi.mock('./ma2-material-read-store', () => ({ ma2MaterialConnection: connection }));
const source = { show: 'Show', generation: 'session', version: '3.7.0.5' };
const snapshot = (page: number): Ma2ExecutorPage => ({ page, name: `页面 ${page}`, source, sequences: [], readAt: new Date().toISOString(), items: [{ slot: page === 4 ? 101 : 2, width: 1, name: '测试', kind: 'sequence', sequence: 1, reference: ['25', '1', '1'], button: null }] });
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('window', { tbLink: { readMa2ExecutorPage: read, listMa2ExecutorPages: list } });
  connection.mockResolvedValue({ network: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' } });
  const project = createEmptyLinkProject('页面'); project.schemaVersion = 2;
  project.ma2MaterialLibrary = { version: 1, source: '192.0.2.1:30000', library: { directory: { ...source, entries: [] }, readAt: new Date().toISOString(), sequences: [], errors: [], fixtureUsage: [] } };
  useDocumentStore.getState().setProject(project, 'pages.tblink'); prepareMa2ExecutorPages();
  list.mockResolvedValue({ ...source, buttonPage: 4, faderPage: 100, pages: [{ page: 4, name: '按钮' }, { page: 100, name: '推杆' }] });
  read.mockImplementation((request: { page: number }) => Promise.resolve(snapshot(request.page)));
});
afterEach(() => vi.unstubAllGlobals());

it('remembers button and fader page independently and resets both for another document', async () => {
  await loadMa2ExecutorDirectory(); selectMa2ExecutorPageKind('button'); expect(useMa2ExecutorPageStore.getState().page).toBe(4);
  await loadMa2ExecutorPage(5); selectMa2ExecutorPageKind('fader'); expect(useMa2ExecutorPageStore.getState().page).toBe(100);
  await loadMa2ExecutorPage(101); selectMa2ExecutorPageKind('button'); expect(useMa2ExecutorPageStore.getState().page).toBe(5);
  selectMa2ExecutorPageKind('fader'); expect(useMa2ExecutorPageStore.getState().page).toBe(101);
  locateMa2Executor(1000, 102); selectMa2ExecutorPageKind('fader'); selectMa2ExecutorPageKind('button');
  expect(useMa2ExecutorPageStore.getState().page).toBe(1000);
  useDocumentStore.getState().setProject(createEmptyLinkProject('other'), 'other.tblink'); prepareMa2ExecutorPages();
  expect(useMa2ExecutorPageStore.getState()).toMatchObject({ navigation: 0, selectedPages: { button: null, fader: null }, pages: {} });
});
it('indexes every page with real progress without moving the page currently being viewed', async () => {
  await loadMa2ExecutorPage(5); await scanMa2ExecutorLocations();
  const state = useMa2ExecutorPageStore.getState(); expect(state).toMatchObject({ page: 5, completed: 2, total: 2, complete: true, scanning: false });
  expect(ma2SequenceLocations(state.pages, 1)).toEqual([{ page: 4, slot: 101 }, { page: 100, slot: 2 }]);
  list.mockResolvedValue({ ...source, buttonPage: 4, faderPage: 100, pages: [{ page: 100, name: '推杆' }, { page: 1000, name: '新页' }] });
  await loadMa2ExecutorDirectory(); expect(useMa2ExecutorPageStore.getState().complete).toBe(false);
  expect(ma2SequenceLocations(useMa2ExecutorPageStore.getState().pages, 1)).toEqual([{ page: 100, slot: 2 }]);
});
it('clears failed pages and never declares a partial scan complete', async () => {
  await scanMa2ExecutorLocations(); expect(useMa2ExecutorPageStore.getState().complete).toBe(true);
  read.mockRejectedValueOnce(new Error('读取中断'));
  await expect(loadMa2ExecutorPage(4)).rejects.toThrow('读取中断'); expect(useMa2ExecutorPageStore.getState().pages[4]).toBeUndefined();
  expect(useMa2ExecutorPageStore.getState().complete).toBe(false);
  read.mockRejectedValueOnce(new Error('扫描中断')); await expect(scanMa2ExecutorLocations()).rejects.toThrow('扫描中断');
  expect(useMa2ExecutorPageStore.getState()).toMatchObject({ complete: false, scanning: false, completed: 0 });
});
it('does not turn a different sequence order in page metadata into a new local edit on every poll', async () => {
  const sequences = [1, 2].map(sequence => ({ sequence, name: `s${sequence}`, cues: [{ index: 1, number: '1.000', name: 'Cue' }] }));
  read.mockResolvedValue({ ...snapshot(4), sequences }); await loadMa2ExecutorPage(4);
  const revision = useDocumentStore.getState().revision;
  read.mockResolvedValue({ ...snapshot(4), sequences: [...sequences].reverse() }); await loadMa2ExecutorPage(4);
  expect(useDocumentStore.getState().revision).toBe(revision);
});
