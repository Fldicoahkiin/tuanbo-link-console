import { useMemo } from 'react';
import { create } from 'zustand';
import type { P1FollowState } from '@tb/schema';
import { followRuntimeState, orphanFollow, P1_FOLLOW_PAGE, P1FollowClient, type P1FollowStartInput } from '../runtime/p1-follow-client';
import { recordRuntimeOperator } from '../runtime/runtime-action-log';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { useDocumentStore } from './document-store';
import { useIntegrationStore } from './integration-store';
import { projectCodec } from './project-codec';
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

/** The project as the document store has it now, with this computer's settings. */
function startInput(): P1FollowStartInput {
  const { project, path, documentId, revision } = useDocumentStore.getState();
  if (!project) throw new Error('还没打开工程，请先打开一个工程');
  return { project, path, documentId, revision, profile: useIntegrationStore.getState().profile, encode: value => projectCodec.encode(value) };
}

/**
 * Holds P1's timecode for the open project (standby), the same version of it only once; auto-follow then listens for
 * the song P1 plays. Where the window used to listen to P1 (one-click connect, 启动并待命, auto-follow turned on).
 */
export async function followP1(): Promise<P1FollowState> {
  // A song followed (or adopted) goes on as it started; the next version reaches it once nothing is followed.
  const current = useP1FollowStore.getState().follow;
  if (current && current.ownerId === P1_FOLLOW_PAGE && current.phase !== 'closed' && !nothingFollowed(current)) return current;
  const auto = useDocumentStore.getState().project?.p1AutoFollow?.enabled === true;
  const state = await p1FollowClient().start(startInput, auto ? 'auto' : 'manual');
  return auto && state.phase === 'standby' ? p1FollowClient().arm(null) : state;
}

/** Stopped, or auto-follow listening for its first song (the main process takes a newer start then, p1-follow-host.ts). */
export function nothingFollowed(state: P1FollowState): boolean {
  return state.phase === 'standby' || state.mode === 'auto' && state.phase === 'waiting' && state.itemId === null;
}

/** The window's preflight runs: the follow shows it as the check while it stands by. */
export async function checkingP1Follow<T>(step: () => Promise<T>): Promise<T> {
  setP1FollowChecking(true);
  try { return await step(); } finally { setP1FollowChecking(false); }
}

/** The song the operator chose to wait for under P1 (only while nothing is followed; a followed song is P1's). */
export function chooseP1Song(itemId: string): void {
  const runtime = useRuntimeStore.getState();
  if (runtime.state !== 'idle') return;
  runtime.setState({ currentItemId: itemId, currentCueId: null, nextCueId: null });
  const project = useDocumentStore.getState().project;
  if (project) void recordRuntimeOperator(project.projectId, project.rundown.find(item => item.id === itemId), '选择当前节目', { itemId })
    .catch((error: unknown) => console.error('选择当前节目没有记进运行日志', error));
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

/** A follow that goes on without a page, for the notice that offers it (null when there is none). */
export function useOrphanP1Follow(): ReturnType<typeof orphanFollow> {
  const follow = useP1FollowStore(state => state.follow);
  return useMemo(() => orphanFollow(follow), [follow]);
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
