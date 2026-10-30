import { create } from 'zustand';
import type { ConsoleFollow } from '@tb/core/link';
import { CONSOLE_FOLLOW_IDLE } from '../runtime/console-follow-monitor';

/** Whether the console runs with the playing song's timecode, as last read back. */
export const useConsoleFollowStore = create<{ follow: ConsoleFollow }>(() => ({ follow: CONSOLE_FOLLOW_IDLE }));

export function publishConsoleFollow(follow: ConsoleFollow): void {
  const current = useConsoleFollowStore.getState().follow;
  if (current.state !== follow.state || current.detail !== follow.detail || current.misses !== follow.misses) useConsoleFollowStore.setState({ follow });
}
