import { beforeEach, expect, it, vi } from 'vitest';
import { useMa2SyncStore } from '../stores/ma2-sync-store';
import { runWhenNotPlaying } from './when-not-playing';

beforeEach(() => { useMa2SyncStore.setState({ timelinePlaying: false, previewPlaying: false }); });

it('没在播放：马上做', () => {
  const task = vi.fn();
  runWhenNotPlaying(task);
  expect(task).toHaveBeenCalledOnce();
});

it('正在播放：等节目和试听都停了才做，只做一次', () => {
  useMa2SyncStore.setState({ timelinePlaying: true, previewPlaying: true });
  const task = vi.fn();
  runWhenNotPlaying(task);
  expect(task).not.toHaveBeenCalled();
  useMa2SyncStore.setState({ timelinePlaying: false });
  expect(task).not.toHaveBeenCalled();
  useMa2SyncStore.setState({ previewPlaying: false });
  expect(task).toHaveBeenCalledOnce();
  useMa2SyncStore.setState({ timelinePlaying: true });
  useMa2SyncStore.setState({ timelinePlaying: false });
  expect(task).toHaveBeenCalledOnce();
});

it('还在等的时候取消：停了也不做', () => {
  useMa2SyncStore.setState({ timelinePlaying: true });
  const task = vi.fn();
  const cancel = runWhenNotPlaying(task);
  cancel();
  useMa2SyncStore.setState({ timelinePlaying: false });
  expect(task).not.toHaveBeenCalled();
});
