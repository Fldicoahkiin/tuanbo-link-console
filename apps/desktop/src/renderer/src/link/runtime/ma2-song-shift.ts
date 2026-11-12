import { useMemo } from 'react';
import { create } from 'zustand';
import { songsShiftedBetween } from '@tb/core/link';
import type { LinkProject, Ma2ConsoleChanges } from '@tb/schema';
import { useMa2SyncStore, type SongSync } from '../stores/ma2-sync-store';
import { useMa2NetworkStatusStore } from '../stores/ma2-network-status-store';

/*
 * Blank time before a song's music and the console (0.5.9 E15, 00 设计第 2 节冲突 5). Adding or taking away blank
 * time moves the whole song: every point is one the software just changed, while the console still has them where
 * they were. Read back now, a point changed on the console before the move would count as the newer one (“最新的为准”)
 * and come back where it was, a blank's length off the music. So from the move until the console confirmed the
 * rewrite, the song is not read back: its next sync writes it, as 以联动台为准 does, the console's version backed up
 * first as every write does. Kept for this run only, as the edit times are (ma2-edit-times.ts), never in the project.
 * Before blank time is added, the song is to be in step with the console (`ma2PaddingWait`).
 */

const key = (documentId: number, itemId: string): string => `${documentId}:${itemId}`;
const useMa2SongShiftStore = create<{ shifted: Record<string, true> }>(() => ({ shifted: {} }));

/** The project the sync last looked at, per document: what the next look compares with. */
let looked: { documentId: number; project: LinkProject } | null = null;

/**
 * The songs moved as a whole (core songsShiftedBetween: by the command, its undo or its redo) since the sync last
 * looked at the document's project. Asked by noteMa2LocalEdits, which every project change reaches (markPendingMa2Songs)
 * before it works out what the console has not confirmed; a padding undone before the next look moved nothing.
 */
export function noteMa2SongsShifted(documentId: number, project: LinkProject | null): void {
  const before = looked?.documentId === documentId ? looked.project : null;
  looked = project ? { documentId, project } : null;
  if (!before || !project || before === project) return;
  const moved = songsShiftedBetween(before, project);
  if (!moved.length) return;
  useMa2SongShiftStore.setState(state => ({ shifted: { ...state.shifted, ...Object.fromEntries(moved.map(itemId => [key(documentId, itemId), true as const])) } }));
}

/** The song was moved as a whole and the console has not confirmed its rewrite yet. */
export function ma2SongShifted(entry: Pick<SongSync, 'documentId' | 'itemId'>): boolean {
  return useMa2SongShiftStore.getState().shifted[key(entry.documentId, entry.itemId)] === true;
}

/** The song holds nothing the console has not confirmed (noteMa2LocalEdits, the one caller): the console confirmed its
 * rewrite (written and read back), or the move was undone before it was written. It is read back as chosen again. */
export function clearMa2SongShift(entry: Pick<SongSync, 'documentId' | 'itemId'>): void {
  if (!ma2SongShifted(entry)) return;
  useMa2SongShiftStore.setState(state => {
    const shifted = { ...state.shifted };
    delete shifted[key(entry.documentId, entry.itemId)];
    return { shifted };
  });
}

/** How this pass treats the console's changes to the song: written over while it was moved and not confirmed yet,
 * otherwise a one-time 用联动台的 (way 1) or `chosen`, what the operator chose (ma2-realtime-preference.ts). */
export function ma2ConsoleChangesFor(entry: Pick<SongSync, 'documentId' | 'itemId' | 'consoleChangesOnce'>, chosen: Ma2ConsoleChanges): Ma2ConsoleChanges {
  if (ma2SongShifted(entry)) return 'software';
  return entry.consoleChangesOnce ?? chosen;
}

export const PADDING_SYNC_FIRST = '先同步这首歌再加空白';

/**
 * Why blank time cannot be added to the song now for the console's sake, or null: with the console connected, the
 * song has a change on the console not read back yet, or its sync stopped on a failure. Without the console (not
 * connected, or not synced over the network) it can always be added; the next sync writes the song.
 */
export function ma2PaddingWait(entry: SongSync | undefined, documentId: number, connected: boolean): string | null {
  if (!connected || !entry || entry.documentId !== documentId) return null;
  const unread = Object.keys(entry.consoleSeen ?? {}).length > 0;
  const failed = entry.state === 'blocked' || (entry.consecutiveFailures ?? 0) > 0;
  return unread || failed ? PADDING_SYNC_FIRST : null;
}

/** `ma2PaddingWait` for the page, worked out again when the song's sync or the connection changes. The network status
 * is only read while the console is synced over the network (use-status-sources.ts clears it otherwise). */
export function useMa2PaddingWait(itemId: string | null, documentId: number): string | null {
  const entry = useMa2SyncStore(state => itemId === null ? undefined : state.songs[itemId]);
  const connected = useMa2NetworkStatusStore(state => state.status?.state === 'connected');
  return useMemo(() => ma2PaddingWait(entry, documentId, connected), [entry, documentId, connected]);
}
