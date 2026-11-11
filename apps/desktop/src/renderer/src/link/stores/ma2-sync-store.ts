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
  /** When a pass last took this song up; a one-time sync ends once every song was taken up after it began. */
  attemptedAt?: number;
  /**
   * The two times "the latest wins" compares (2026-11-11), kept while the app runs and never saved in
   * the project: `localEditedAt`, when the operator last changed the song's lighting in the software
   * since the last confirmation (unknown after a restart); `consoleSeen`, per console object ('tc:63' for
   * way 1's Timecode 63, 'own' for way 2's own Sequence), the console revision that differs from the
   * confirmed baseline and when a pass first saw it.
   */
  localEditedAt?: number | undefined;
  consoleSeen?: Record<string, { revision: string; at: number }> | undefined;
  /** A failure is reported once per text (2026-11-11): the last text written to the run log, and the last one shown in a toast. */
  loggedFailure?: string | undefined;
  announcedFailure?: string | undefined;
  /** 用联动台的 on a stopped way-1 song: the next pass writes the timeline over the console's edits, once. */
  consoleChangesOnce?: 'software' | undefined;
};

/** Console objects renamed in the project; sent by the same pass as the songs, under the same failure policy. */
export type NameSync = { state: 'idle' | 'pending' | 'syncing' | 'verified' | 'blocked'; message: string; writing?: boolean; blockedRevision?: number | undefined; nextCheckAt?: number };

/** The session check: the console the project last read is reachable and still the same console. */
export type Ma2SessionCheck = { status: 'waiting' | 'ready' | 'blocked'; message: string };

export const useMa2SyncStore = create<{ songs: Record<string, SongSync>; names: NameSync; session: Ma2SessionCheck; timelinePlaying: boolean; previewPlaying: boolean }>(() => ({
  songs: {}, names: { state: 'idle', message: '' }, session: { status: 'waiting', message: '等待连接控台并打开工程' }, timelinePlaying: false, previewPlaying: false
}));

/** Patches a song's sync state while the same session holds it; a paused song stays paused. */
export function updateMa2Song(entry: SongSync, patch: Partial<SongSync>): void {
  useMa2SyncStore.setState(state => {
    const current = state.songs[entry.itemId];
    if (!current || current.sessionId !== entry.sessionId) return state;
    return { songs: { ...state.songs, [entry.itemId]: { ...current, ...patch, ...(current.state === 'paused' ? { state: 'paused' as const } : {}) } } };
  });
}
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
