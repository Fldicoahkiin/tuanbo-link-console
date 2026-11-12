import { create } from 'zustand';
import type { P1FollowState } from '@tb/schema';
import { followRuntimeState, P1_FOLLOW_PAGE, P1FollowClient } from '../runtime/p1-follow-client';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { useDocumentStore } from './document-store';
import { useRuntimeStore } from './runtime-store';

/*
 * The main process's P1 follow as this window shows it (0.5.9 P4): the one place its state lands. `follow` is this page's
 * follow, or one that goes on without a page. The runtime store gets the same state in the words the rest of the window
 * reads (its runtime state, the song, P1's timecode), so that the guards which wait while P1 is followed keep working.
 */

type P1FollowStore = {
  follow: P1FollowState | null;
  /** The window checks before arming (its preflight): shown as the check while the follow stands by. */
  checking: boolean;
};

export const useP1FollowStore = create<P1FollowStore>(() => ({ follow: null, checking: false }));

let mainErrorsShown = false;
let client: P1FollowClient | null = null;

/** LinkApp says when this page shows the main process's red text, before any follow starts. */
export function setMainErrorsShown(shown: boolean): void { mainErrorsShown = shown; }

/** The page's one client (made on first use, so that importing this does not reach the desktop bridge). */
export function p1FollowClient(): P1FollowClient {
  client ??= new P1FollowClient({ api: linkDesktopViewModel, ownerId: P1_FOLLOW_PAGE, shown: showP1Follow, errorsShown: () => mainErrorsShown });
  return client;
}

export function setP1FollowChecking(checking: boolean): void {
  useP1FollowStore.setState({ checking });
  const follow = useP1FollowStore.getState().follow;
  if (follow) mirror(follow);
}

export function showP1Follow(state: P1FollowState): void {
  useP1FollowStore.setState({ follow: state });
  mirror(state);
}

/** Only while the open project follows P1 (联动台播放 writes the runtime store itself) and only for this page's follow. */
function mirror(state: P1FollowState): void {
  const project = useDocumentStore.getState().project;
  if (!project || project.playbackSource === 'internal') return;
  if (state.phase !== 'closed' && state.ownerId !== P1_FOLLOW_PAGE) return;
  const following = state.phase !== 'closed' && state.phase !== 'standby' && state.itemId !== null;
  const mtc = state.mtc;
  useRuntimeStore.getState().setState({
    state: followRuntimeState(state, useP1FollowStore.getState().checking), mode: 'live',
    reason: state.reason ?? (state.input?.state === 'closed' ? state.input.reason : null),
    ...following ? { currentItemId: state.itemId } : {},
    timecode: mtc?.timecode ?? null, detectedFrameRate: mtc?.frameRate ?? null, mtcStable: mtc?.stable ?? false,
    // The main process says whether P1's timecode came within 500 ms on the interface's clock; the window's checks of
    // "within 500 ms" read it as now.
    lastMtcAt: mtc?.receiving ? performance.now() : null
  });
}
