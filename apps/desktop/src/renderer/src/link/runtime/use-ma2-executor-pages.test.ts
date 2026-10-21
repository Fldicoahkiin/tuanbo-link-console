import { beforeEach, expect, it, vi } from 'vitest';
import { pageReadsPaused, startMa2ExecutorPagePolling } from './use-ma2-executor-pages';
import { loadMa2ExecutorPage, useMa2ExecutorPageStore } from '../stores/ma2-executor-page-store';
import { useMa2AutoSyncStore } from '../stores/ma2-auto-sync-store';
import { useMa2MaterialReadStore } from '../stores/ma2-material-read-store';
import { useMa2SongSyncStore } from './ma2-song-sync';

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined }); });
vi.mock('../view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: { recordLog: vi.fn(() => Promise.resolve()) } }));
vi.mock('../stores/ma2-executor-page-store', async importOriginal => ({ ...await importOriginal<typeof import('../stores/ma2-executor-page-store')>(), loadMa2ExecutorPage: vi.fn(() => Promise.resolve()), loadMa2ExecutorDirectory: vi.fn(() => Promise.resolve()) }));
vi.mock('../stores/ma2-layout-store', async importOriginal => ({ ...await importOriginal<typeof import('../stores/ma2-layout-store')>(), currentMa2LayoutScope: () => 'scope-a' }));
beforeEach(() => {
  useMa2AutoSyncStore.setState({ request: null, status: 'off', message: '', timelinePlaying: false, previewPlaying: false });
  useMa2MaterialReadStore.setState({ busy: false });
  useMa2SongSyncStore.setState({ songs: {} });
});
it('读素材、时间线播放和预览播放期间暂停执行器页面轮询', () => {
  expect(pageReadsPaused()).toBe(false);
  useMa2MaterialReadStore.setState({ busy: true }); expect(pageReadsPaused()).toBe(true);
  useMa2MaterialReadStore.setState({ busy: false }); useMa2AutoSyncStore.setState({ timelinePlaying: true }); expect(pageReadsPaused()).toBe(true);
  useMa2AutoSyncStore.setState({ timelinePlaying: false, previewPlaying: true }); expect(pageReadsPaused()).toBe(true);
  useMa2AutoSyncStore.setState({ previewPlaying: false }); expect(pageReadsPaused()).toBe(false);
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
