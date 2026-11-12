import type { NativeObsPrepare, PlaybackSnapshot } from '@tb/schema';

/**
 * What a preparation made ahead for the next song is, not which project version asked for it (0.5.9 S8a, S8b). The one
 * place for both: the main process takes a preparation at the next song's start only when its identity is the one that
 * song asks for, and the program prepares the next song again while one is held when the identity it wants changed.
 */

/** The next song's audio: the decoded source and where it starts (NativeAudioPreload). An edit to another song, or to
 * this one's volume, leaves it the same. */
export function nextAudioIdentity(snapshot: PlaybackSnapshot): string {
  return JSON.stringify([snapshot.projectId, snapshot.itemId, snapshot.audio.relativePath,
    snapshot.audio.sha256, snapshot.audio.durationMs, snapshot.sampleRate, snapshot.positionMs]);
}

/** The next song's picture: its outputs are built from the song's content only (projectFromObsSnapshot has no revision),
 * and the session and its status take the revision of the request that takes them over (NativeObsPreloadPool). */
export function nextPictureIdentity(request: Pick<NativeObsPrepare, 'projectPath' | 'preciseSeeking' | 'snapshot'>, positionMs: number): string {
  return JSON.stringify([request.projectPath, request.preciseSeeking, { ...request.snapshot, revision: null }, positionMs]);
}
