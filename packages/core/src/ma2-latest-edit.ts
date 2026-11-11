/**
 * When the same point was changed in the software and on the console since the last confirmed sync,
 * the later change wins (2026-11-11, the user: "矛盾的时候采用最新的"; it replaces 2026-10-26's "以联动台为准"
 * whenever console edits are read back). How late each change is, as the user was told:
 * - the software's: when the operator made the edit; an edit whose time is unknown (unsynced edits
 *   opened from the file after a restart) counts as older than anything on the console;
 * - the console's: when the software first saw it, since the console does not say when it was edited
 *   (the song open in the editor is checked every 2 seconds, the others every 30, never during playback).
 * A software edit at the very moment the console change was seen is the later one: the console was
 * edited before it was seen.
 */
export type Ma2EditTimes = { localEditedAt: number | undefined; consoleSeenAt: number };
export type Ma2LatestSide = 'local' | 'remote';

export function ma2LatestSide(times: Ma2EditTimes): Ma2LatestSide {
  return times.localEditedAt !== undefined && times.localEditedAt >= times.consoleSeenAt ? 'local' : 'remote';
}

/** What the status line and the run log say was chosen, e.g. "Timecode 63 有 2 处两边都改过，按最新的用了控台上的". */
export function ma2LatestChoiceText(where: string, count: number, side: Ma2LatestSide): string {
  return `${where} 有 ${count} 处两边都改过，按最新的用了${side === 'local' ? '联动台上的' : '控台上的'}`;
}
