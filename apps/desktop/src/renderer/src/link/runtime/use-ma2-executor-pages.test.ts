import { beforeEach, expect, it, vi } from 'vitest';
import { pageReadsPaused, startMa2ExecutorPagePolling } from './use-ma2-executor-pages';
import { loadMa2ExecutorPage, useMa2ExecutorPageStore } from '../stores/ma2-executor-page-store';
import { useMa2SyncStore } from '../stores/ma2-sync-store';
import { useShowStateStore } from '../stores/show-state-store';
import { useMa2MaterialReadStore } from '../stores/ma2-material-read-store';

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined }); });
vi.mock('../view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: { recordLog: vi.fn(() => Promise.resolve()) } }));
vi.mock('../stores/ma2-executor-page-store', async importOriginal => ({ ...await importOriginal<typeof import('../stores/ma2-executor-page-store')>(), loadMa2ExecutorPage: vi.fn(() => Promise.resolve()), loadMa2ExecutorDirectory: vi.fn(() => Promise.resolve()) }));
vi.mock('../stores/ma2-layout-store', async importOriginal => ({ ...await importOriginal<typeof import('../stores/ma2-layout-store')>(), currentMa2LayoutScope: () => 'scope-a' }));
beforeEach(() => {
  useMa2SyncStore.setState({ songs: {}, names: { state: 'idle', message: '' }, previewPlaying: false });
  useShowStateStore.setState({ show: { phase: 'idle', program: null } });
  useMa2MaterialReadStore.setState({ busy: false });
});
it('读素材、时间线播放和预览播放期间暂停执行器页面轮询；暂停和 P1 等下一首时照常刷新（第 3 题）', () => {
  expect(pageReadsPaused()).toBe(false);
  useMa2MaterialReadStore.setState({ busy: true }); expect(pageReadsPaused()).toBe(true);
  useMa2MaterialReadStore.setState({ busy: false });
  useShowStateStore.setState({ show: { phase: 'running', source: 'internal', itemId: 'song', program: null } }); expect(pageReadsPaused()).toBe(true);
  useShowStateStore.setState({ show: { phase: 'running', source: 'preview', itemId: null, program: null } }); expect(pageReadsPaused()).toBe(true);
  useShowStateStore.setState({ show: { phase: 'held', source: 'internal', itemId: 'song', reason: 'paused', program: null } }); expect(pageReadsPaused()).toBe(false);
  useShowStateStore.setState({ show: { phase: 'held', source: 'p1', itemId: null, reason: 'p1-waiting', program: null } }); expect(pageReadsPaused()).toBe(false);
  useShowStateStore.setState({ show: { phase: 'idle', program: null } }); expect(pageReadsPaused()).toBe(false);
});
it('读素材期间跳过的页面在暂停结束后自动补读，不会一直停在读取中', async () => {
  vi.useFakeTimers();
  try {
    useMa2ExecutorPageStore.setState({ scope: 'scope-a', bandPages: { upper: 1000, fader: null, lower: null }, pages: {} });
    useMa2MaterialReadStore.setState({ busy: true });
    const stop = startMa2ExecutorPagePolling('scope-a', false, () => undefined, { current: Number.POSITIVE_INFINITY });
    await vi.advanceTimersByTimeAsync(0);
    expect(loadMa2ExecutorPage).not.toHaveBeenCalled();
    useMa2MaterialReadStore.setState({ busy: false });
    await vi.advanceTimersByTimeAsync(1600);
    expect(loadMa2ExecutorPage).toHaveBeenCalledWith(1000, true);
    stop();
  } finally { vi.useRealTimers(); }
});
