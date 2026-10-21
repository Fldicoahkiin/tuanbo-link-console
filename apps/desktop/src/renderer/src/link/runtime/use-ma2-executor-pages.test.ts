import { beforeEach, expect, it, vi } from 'vitest';
import { pageReadsPaused } from './use-ma2-executor-pages';
import { useMa2AutoSyncStore } from '../stores/ma2-auto-sync-store';
import { useMa2MaterialReadStore } from '../stores/ma2-material-read-store';
import { useMa2SongSyncStore } from './ma2-song-sync';

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined }); });
vi.mock('../view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: { recordLog: vi.fn(() => Promise.resolve()) } }));
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
