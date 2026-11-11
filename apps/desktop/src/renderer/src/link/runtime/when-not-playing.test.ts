import { beforeEach, expect, it, vi } from 'vitest';
import { useShowStateStore } from '../stores/show-state-store';
import { runWhenNotPlaying } from './when-not-playing';

const IDLE = { phase: 'idle', program: null } as const;
const RUNNING = { phase: 'running', source: 'internal', itemId: 'song', program: null } as const;
const PREVIEW = { phase: 'running', source: 'preview', itemId: null, program: null } as const;
const HELD = { phase: 'held', source: 'internal', itemId: 'song', reason: 'paused', program: null } as const;

beforeEach(() => { useShowStateStore.setState({ show: IDLE }); });

it('没在播放：马上做', () => {
  const task = vi.fn();
  runWhenNotPlaying(task);
  expect(task).toHaveBeenCalledOnce();
});

it('正在播放：等节目和试听都停了才做，只做一次；暂停也还在台上，不做', () => {
  useShowStateStore.setState({ show: RUNNING });
  const task = vi.fn();
  runWhenNotPlaying(task);
  expect(task).not.toHaveBeenCalled();
  useShowStateStore.setState({ show: PREVIEW });
  expect(task).not.toHaveBeenCalled();
  useShowStateStore.setState({ show: HELD });
  expect(task).not.toHaveBeenCalled();
  useShowStateStore.setState({ show: IDLE });
  expect(task).toHaveBeenCalledOnce();
  useShowStateStore.setState({ show: RUNNING });
  useShowStateStore.setState({ show: IDLE });
  expect(task).toHaveBeenCalledOnce();
});

it('还在等的时候取消：停了也不做', () => {
  useShowStateStore.setState({ show: RUNNING });
  const task = vi.fn();
  const cancel = runWhenNotPlaying(task);
  cancel();
  useShowStateStore.setState({ show: IDLE });
  expect(task).not.toHaveBeenCalled();
});
