import { useEffect } from 'react';
import { toUserErrorMessage } from '@tb/core/link';
import type { LinkProject } from '@tb/schema';
import { P1_FOLLOW_PAGE } from './runtime/p1-follow-client';
import { followP1, nothingFollowed, p1FollowClient, useOrphanP1Follow, useP1FollowStore } from './stores/p1-follow-store';

/**
 * The page and the main process's P1 follow (0.5.9 P4). `project`: the project the window plays with (LinkApp keeps it
 * while something is followed), `path` its file.
 * - Auto-follow listens for P1's song while that project has it on; each version of the project reaches the listener
 *   (the follow is started again with it while no song is followed), as the window rebuilt its listener with each edit.
 * - A follow this page left (no project, another one, 联动台播放, auto-follow turned off) is closed once nothing is
 *   followed, as the window let go of P1's timecode when its project changed.
 * - A follow that went on while the page loaded is taken back when this page has its project open; another page only
 *   offers to stop it (LinkApp).
 */
export function useP1AutoFollow(project: LinkProject | null, path: string | null, ready: boolean,
  notify: (message: string, tone?: 'info' | 'error') => void): void {
  const follow = useP1FollowStore(state => state.follow);
  const orphan = useOrphanP1Follow();
  const following = project !== null && project.playbackSource !== 'internal';
  const auto = following && project.p1AutoFollow?.enabled === true;
  const own = follow !== null && follow.phase !== 'closed' && follow.ownerId === P1_FOLLOW_PAGE;
  const idle = own && nothingFollowed(follow);
  const left = idle && (!following || path !== follow.projectPath || follow.mode === 'auto' && !auto);
  const orphaned = orphan !== null;
  const adoptable = orphan && following && path === orphan.projectPath ? orphan.projectPath : null;

  useEffect(() => {
    if (!left) return;
    void p1FollowClient().close().catch((error: unknown) => notify(`没能结束跟随 P1：${toUserErrorMessage(error)}`, 'error'));
  }, [left, notify]);

  useEffect(() => {
    if (!adoptable) return;
    void p1FollowClient().adopt(adoptable).then(() => notify('接着跟随 P1：联动台重新打开之前开始的跟随还在继续，这个界面接过来了。'),
      (error: unknown) => notify(`没能接着跟随 P1：${toUserErrorMessage(error)}`, 'error'));
  }, [adoptable, notify]);

  useEffect(() => {
    if (!project || !ready || !auto || orphaned) return;
    void followP1().catch((error: unknown) => notify(`P1 自动监听失败：${toUserErrorMessage(error)}`, 'error'));
  }, [project, ready, auto, orphaned, notify]);
}
