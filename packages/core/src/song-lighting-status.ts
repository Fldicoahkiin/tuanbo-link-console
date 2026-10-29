import type { LinkProject, MtcFrameRate } from '@tb/schema';
import { ma2PendingChanges } from './ma2-pending-changes';
import { ma2SongPairs } from './ma2-pairing-state';
import { ma2SongPoints } from './ma2-song-sequence';
import { programTimeOrigin } from './ma2-time-origin';

export type SongLightingStatus =
  /** No console show is known to start where the song starts; `reason` says why when there is one. */
  | { state: 'unmatched'; reason: string | null }
  /** The console show that runs with the song. `pending` edits are not on the console yet; `problems` stop them being written. */
  | { state: 'matched'; timecode: number; startMs: number; frameRate: MtcFrameRate | null; pending: number; problems: string[]; notes: string[] }
  /** Two or more console shows start where the song starts: none is guessed and nothing is written. */
  | { state: 'duplicate'; timecodes: number[] };

/**
 * Whether a console Timecode show runs with the song when the player sends its MTC (2026-10-26: by the
 * MTC start alone, no confirmation). Read from the project alone (the last console read it keeps, the
 * songs' starts, bindings and local edits), so it answers the same with the network cable unplugged.
 * Nothing here holds a song back: every song plays and sends its timecode.
 */
export function songLightingStatus(project: LinkProject, itemId: string): SongLightingStatus {
  const item = project.rundown.find(value => value.id === itemId);
  if (!item) throw new Error(`节目单中没有 ${itemId}`);
  const own = item.lighting?.consoleSong;
  if (item.lighting && own?.timecode) return ownShowStatus(item, item.lighting, own, own.timecode);
  if (own && !own.executor) return { state: 'unmatched', reason: '这首歌的控台序列只放在 Layout 页面上，没有执行器位置，建不了时间码节目' };
  if (own) return { state: 'unmatched', reason: '控台上还没有这首歌的时间码节目，同步时自动建立' };
  const match = ma2SongPairs(project);
  const duplicate = match.duplicateStarts[itemId];
  if (duplicate) return { state: 'duplicate', timecodes: duplicate };
  const target = Object.entries(match.pairs).find(([, id]) => id === itemId)?.[0];
  const bound = new Set(item.lighting?.ma2Bindings?.map(binding => binding.timecode) ?? []);
  if (target === undefined) {
    const reasons = match.unresolved.filter(value => bound.has(value.target)).map(value => value.reason);
    return { state: 'unmatched', reason: reasons.length ? reasons.join('；') : null };
  }
  const timecode = Number(target);
  const pending = ma2PendingChanges(project).filter(change => change.itemId === itemId);
  const problems = pending.flatMap(change => change.error ? [`控台 Timecode ${change.target}：${change.error}`] : []);
  for (const value of match.unresolved) if (bound.has(value.target)) problems.push(value.reason);
  const format = project.ma2ReadState?.catalog.entries.find(entry => entry.target === timecode)?.frameFormat;
  return { state: 'matched', timecode, startMs: programTimeOrigin(item), frameRate: consoleFrameRate(format),
    pending: pending.reduce((total, change) => total + change.changes.length, 0), problems,
    notes: match.notes.filter(note => note.target === timecode).map(note => note.text) };
}

function consoleFrameRate(format: string | null | undefined): MtcFrameRate | null {
  return format === '30 FPS' ? '30' : format === '25 FPS' ? '25' : format === '24 FPS' ? '24' : null;
}

type Item = LinkProject['rundown'][number];
type Lighting = NonNullable<Item['lighting']>;
type ConsoleSong = NonNullable<Lighting['consoleSong']>;
const frames = (ms: number): number => Math.round(ms * 30 / 1000);

/**
 * A song with the program's own Timecode show: ready while every point still fires its own Cue of
 * the song's Sequence at the frame last written and the song start is unchanged; any difference is
 * an edit the next sync writes.
 */
function ownShowStatus(item: Item, lighting: Lighting, song: ConsoleSong, timecode: NonNullable<ConsoleSong['timecode']>): SongLightingStatus {
  let startMs: number; let points: ReturnType<typeof ma2SongPoints>;
  try { startMs = programTimeOrigin(item); points = ma2SongPoints(lighting); }
  catch (error) { return { state: 'unmatched', reason: error instanceof Error ? error.message : String(error) }; }
  const written = new Map(song.points.map(point => [point.id, point]));
  let pending = frames(startMs) === timecode.offset ? 0 : 1;
  for (const point of points) {
    const stored = written.get(point.id);
    const own = stored && point.cues.length === 1 && point.cues[0]!.sequence === song.sequence && Number(point.cues[0]!.cue) === Number(stored.cue);
    if (!stored || !own || stored.atMs === undefined || frames(stored.atMs) !== frames(point.atMs)) pending += 1;
  }
  pending += song.points.filter(point => !points.some(local => local.id === point.id)).length;
  return { state: 'matched', timecode: timecode.number, startMs, frameRate: '30', pending, problems: [], notes: [] };
}
