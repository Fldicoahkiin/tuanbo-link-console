import { create } from 'zustand';
import type { Ma2LayoutSettings, Ma2ReadProgress } from '@tb/schema';

/**
 * One console sync per song, whichever way it was lit: way 1 writes back to the console's own
 * Timecode show (`ma2Bindings`), way 2 to the song's own Sequence (`consoleSong`).
 * 'blocked': the sync failed as often as its policy allows; it waits for an edit or 刷新同步.
 * `checkedAt`: when a confirmed song was last compared with the console.
 * `recheckRevision`: a song parked until the project changes (way 1 edits held back by a moved start).
 */
export type SongSync = {
  sessionId: string; itemId: string; documentId: number; name: string; settings: Ma2LayoutSettings;
  state: 'pending' | 'syncing' | 'verified' | 'blocked' | 'paused'; message: string;
  requestId?: string | null; progress?: Ma2ReadProgress | null; checking?: boolean; writing?: boolean;
  acknowledged?: string; remoteRevision?: string | undefined; blockedRevision?: number | undefined; recheckRevision?: number | undefined;
  nextCheckAt?: number; checkedAt?: number; waitingForConnection?: boolean;
  consecutiveFailures?: number; consecutiveCollisions?: number; archivedSignature?: string; rewriteLegacyNames?: boolean;
};

/** Console objects renamed in the project; sent by the same pass as the songs, under the same failure policy. */
export type NameSync = { state: 'idle' | 'pending' | 'syncing' | 'verified' | 'blocked'; message: string; writing?: boolean; blockedRevision?: number | undefined; nextCheckAt?: number };

/** The session check: the console the project last read is reachable and still the same console. */
export type Ma2SessionCheck = { status: 'waiting' | 'ready' | 'blocked'; message: string };

export const useMa2SyncStore = create<{ songs: Record<string, SongSync>; names: NameSync; session: Ma2SessionCheck; timelinePlaying: boolean; previewPlaying: boolean }>(() => ({
  songs: {}, names: { state: 'idle', message: '' }, session: { status: 'waiting', message: '等待连接控台并打开工程' }, timelinePlaying: false, previewPlaying: false
}));

/** The programme or an editor preview is playing: nothing is written to the console. */
export function ma2SyncPlaying(): boolean {
  const state = useMa2SyncStore.getState();
  return state.timelinePlaying || state.previewPlaying;
}

/** A write already sent to the console is still waiting for its confirmation. */
export function ma2ConsoleWriting(): boolean {
  const state = useMa2SyncStore.getState();
  return Boolean(state.names.writing) || Object.values(state.songs).some(song => song.writing || Boolean(song.requestId));
}
