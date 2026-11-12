import { ma2PendingChanges, ma2SongPoints, programTimeOrigin } from '@tb/core/link';
import { useDocumentStore } from '../stores/document-store';
import { updateMa2Song, useMa2SyncStore, type SongSync } from '../stores/ma2-sync-store';
import { clearMa2SongShift, noteMa2SongsShifted } from './ma2-song-shift';

/**
 * When each side last changed a song's lighting (2026-11-11, 矛盾的时候采用最新的): the times the
 * latest-wins rule (`ma2LatestSide` in core) compares. They live in the sync store for this run only,
 * never in the project.
 */
export type Program = NonNullable<ReturnType<typeof useDocumentStore.getState>['project']>['rundown'][number];
/** The song's MTC start once it has one: it places the song's own Timecode show. */
export function songStart(item: Program): number | undefined {
  return item.playback || item.p1Media ? Math.round(programTimeOrigin(item)) : undefined;
}
/** What a confirmed sync acknowledges: the song's points, its name and, once it has one, its MTC start. */
export function songSignature(points: ReturnType<typeof ma2SongPoints>, name: string, start: number | undefined): string {
  return JSON.stringify([points, name, ...start === undefined ? [] : [start]]);
}
/** Set while a sync puts the console's confirmed read-back into a song: that is not an edit by the operator. */
let confirming = false;
/** The unconfirmed content each song had when its edit time was last looked at, per document and song. */
const seenEdits = new Map<string, string>();
/**
 * What the song holds that the console has not confirmed, as text to compare; null when nothing. Way 1
 * counts from the baseline the console confirmed, way 2 from what its last sync acknowledged. A song
 * whose points cannot be read yet has its reason as the content; markPendingMa2Songs shows the reason.
 */
function localEditKey(entry: SongSync, item: Program): string | null {
  const project = useDocumentStore.getState().project;
  if (!project || !item.lighting) return null;
  if (item.lighting.ma2Bindings?.length) {
    const changes = ma2PendingChanges(project).filter(change => change.itemId === item.id);
    return changes.length ? JSON.stringify(changes.map(change => [change.target, change.error, change.changes.map(value => value.after)])) : null;
  }
  let signature: string;
  try { signature = songSignature(ma2SongPoints(item.lighting), item.lighting.consoleSong?.name ?? entry.name, songStart(item)); }
  catch (cause) { signature = cause instanceof Error ? cause.message : String(cause); }
  return entry.acknowledged === signature ? null : signature;
}
/**
 * Keeps when the operator last changed each song's lighting in the software. A change a sync makes by
 * confirming the console is not an edit; once the console confirmed everything, the time is dropped.
 * The first look at a song after a restart has nothing to compare, so edits opened from the file keep
 * an unknown time and count as older.
 */
export function noteMa2LocalEdits(): void {
  const document = useDocumentStore.getState();
  // A song moved as a whole is written before it is read back again (0.5.9 E15): noted before what is unconfirmed.
  noteMa2SongsShifted(document.documentId, document.project);
  for (const entry of Object.values(useMa2SyncStore.getState().songs)) {
    if (entry.documentId !== document.documentId) continue;
    const item = document.project?.rundown.find(value => value.id === entry.itemId);
    if (!item) continue;
    const key = `${entry.documentId}:${entry.itemId}`;
    const edits = localEditKey(entry, item);
    const seen = seenEdits.get(key);
    seenEdits.set(key, edits ?? '');
    // Nothing the console has not confirmed: a song moved as a whole is read back as chosen again, whether the console
    // confirmed its rewrite or the move was undone before it was written (the one place that forgets it, ma2-song-shift.ts).
    if (edits === null) { if (entry.localEditedAt !== undefined) updateMa2Song(entry, { localEditedAt: undefined }); clearMa2SongShift(entry); continue; }
    if (seen !== undefined && seen !== edits && !confirming) updateMa2Song(entry, { localEditedAt: Date.now() });
  }
}
/** Puts what the console confirmed into the project without counting it as an operator's edit. */
export function confirmMa2Edit(run: () => void): void {
  confirming = true;
  try { run(); noteMa2LocalEdits(); }
  finally { confirming = false; }
}
/**
 * When a pass first saw this revision of a console object differ from the confirmed baseline; a further
 * console change renews it, and the console back at the baseline forgets it.
 */
export function consoleSeenAt(entry: SongSync, key: string, revision: string | null): number {
  const current = useMa2SyncStore.getState().songs[entry.itemId];
  const seen = { ...current?.sessionId === entry.sessionId ? current.consoleSeen : entry.consoleSeen };
  const now = Date.now();
  if (revision === null) { delete seen[key]; updateMa2Song(entry, { consoleSeen: seen }); return now; }
  const digest = revisionDigest(revision);
  const known = seen[key];
  if (known?.revision === digest) return known.at;
  seen[key] = { revision: digest, at: now };
  updateMa2Song(entry, { consoleSeen: seen });
  return now;
}
/** A short fingerprint of a console export (FNV-1a and the length); only compared with itself. */
function revisionDigest(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return `${text.length}:${hash.toString(16)}`;
}
/** The two times way 2's merge compares when a point changed on both sides. */
export function editTimes(entry: SongSync): { localEditedAt?: number; consoleSeenAt?: number } {
  const current = useMa2SyncStore.getState().songs[entry.itemId] ?? entry;
  const seen = current.consoleSeen?.own?.at;
  return { ...current.localEditedAt === undefined ? {} : { localEditedAt: current.localEditedAt }, ...seen === undefined ? {} : { consoleSeenAt: seen } };
}
