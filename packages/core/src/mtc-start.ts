import { parseLinkProject, type LinkProject, type Ma2TimecodeRanges, type RundownItem } from '@tb/schema';
import type { LinkCommand } from './link-command';
import { programTimeOrigin } from './ma2-time-origin';
import { programPlaylistId, programPlaylists } from './program-playlists';

/** Time a song's MTC must stay clear of the one before it, so a late stop never runs into the next show. */
const GAP_MS = 10_000;

/**
 * The MTC start for a song that has none: the first whole second at least ten seconds after every
 * occupied range ends (60 s when nothing is occupied). The single allocator for P1 auto-follow and
 * for songs synced to the console; for P1 it reproduces the layout P1 exports always used.
 */
export function nextMtcStartMs(occupied: ReadonlyArray<{ startMs: number; endMs: number }>, durationMs: number, limitMs = 86_400_000): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('歌曲时长无效，无法分配时间码起点');
  const end = Math.max(60_000 - GAP_MS, ...occupied.map(range => range.endMs));
  const start = Math.ceil((end + GAP_MS) / 1000) * 1000;
  if (start + durationMs >= limitMs) throw new Error(`没有足够的时间码空间：新歌需要从 ${Math.round(start / 1000)} 秒开始，加上时长后超出 ${Math.round(limitMs / 3_600_000)} 小时，请拆分工程`);
  return start;
}

/** The slot MIDI timecode reaches on grandMA2 by default; every song's own Timecode show listens there. */
export const MA2_SONG_TIMECODE_SLOT = 'TC Slot 2';
/**
 * Starts a song sync error when the console changed the song's Sequence between the read and the
 * write: nothing was written and the next pass reads again, so it is a wait, not a failed attempt.
 */
export const MA2_SONG_COLLISION = '控台同时在改';

/** A show whose length the console does not give still runs past its last event; this much is kept clear after it. */
const LAST_EVENT_MARGIN_TICKS = 30 * 30;

/**
 * The MTC start for a song synced to the console without one: after every console Timecode show
 * that can start from the songs' timecode and every other song of the project that has a start.
 * MA2 keeps a show's offset, length and event times in 1/30 s whatever its frame format, and a show
 * linked to another TC Slot does not start from timecode on ours (both observed on onPC 3.7.0.5);
 * a show without events fires nothing. Slot values other than "TC Slot N" are counted as ours.
 * A show of ours whose range cannot be read stops the allocation instead of being guessed.
 */
export function allocateSongMtcStart(project: LinkProject, itemId: string, console: Ma2TimecodeRanges): number {
  const item = project.rundown.find(value => value.id === itemId);
  if (!item?.referenceAudio) throw new Error('歌曲没有音频时长，无法分配时间码起点');
  const occupied: Array<{ startMs: number; endMs: number }> = [];
  const unclear: string[] = [];
  for (const show of console.entries) {
    if (show.slot !== MA2_SONG_TIMECODE_SLOT && /^TC Slot [1-8]$/.test(show.slot) || show.last === '') continue;
    const offset = Number(show.offset); const length = show.length === '' ? 0 : Number(show.length); const last = Number(show.last);
    if (![offset, length, last].every(Number.isFinite)) { unclear.push(`Timecode ${show.target}${show.name ? `「${show.name}」` : ''}`); continue; }
    // The console's length when it covers every event; otherwise the last event plus a margin.
    const ticks = length >= last ? length : last + LAST_EVENT_MARGIN_TICKS;
    occupied.push({ startMs: offset * 1000 / 30, endMs: (offset + ticks) * 1000 / 30 });
  }
  if (unclear.length) throw new Error(`控台 ${MA2_SONG_TIMECODE_SLOT} 上这些时间码节目的时间范围读不清，未分配起点：${unclear.join('、')}。请在控台上给它设长度、删除它，或把它换到别的 TC Slot，然后重新同步`);
  for (const other of project.rundown) {
    if (other.id === itemId || !other.referenceAudio || !other.playback && !other.p1Media) continue;
    const start = programTimeOrigin(other);
    occupied.push({ startMs: start, endMs: start + other.referenceAudio.durationMs });
  }
  return nextMtcStartMs(occupied, item.referenceAudio.durationMs);
}

export type SongMtcStartReading = { state: 'set'; startMs: number } | { state: 'unset' } | { state: 'invalid'; reason: string };
/** The song's MTC start once it has one (its own playback start or the P1 start), or why it cannot be read. */
export function readSongMtcStart(item: Pick<LinkProject['rundown'][number], 'playback' | 'p1Media' | 'lighting'>): SongMtcStartReading {
  if (!item.playback && !item.p1Media) return { state: 'unset' };
  try { return { state: 'set', startMs: Math.round(programTimeOrigin(item)) }; }
  catch (error) { return { state: 'invalid', reason: error instanceof Error ? error.message : String(error) }; }
}

/** Another song whose MTC range runs into this one's. */
export type SongMtcOverlap = { id: string; title: string; playlistId: string | null };

/**
 * Songs whose MTC ranges overlap another song's: on the same timecode both songs' console shows
 * would fire. Each song lists the songs it overlaps. Songs without audio or a readable start are
 * not compared; their start reading says why. The same audio (sha256) from the same start is one
 * song on the console, not two: a song put into two playlists is two rundown items (2026-11-11
 * field report: a copy of drop.mp4 in another playlist was reported as overlapping drop.mp4).
 */
export function songMtcOverlaps(project: LinkProject): Map<string, SongMtcOverlap[]> {
  const ranges = project.rundown.flatMap(item => {
    const reading = readSongMtcStart(item);
    return item.referenceAudio && reading.state === 'set' ? [{ item, audio: item.referenceAudio.sha256, start: reading.startMs, end: reading.startMs + item.referenceAudio.durationMs }] : [];
  });
  const overlaps = new Map<string, SongMtcOverlap[]>();
  for (const range of ranges) {
    const others = ranges.filter(other => other.item.id !== range.item.id && other.start < range.end && range.start < other.end
      && !(other.audio === range.audio && other.start === range.start))
      .map(other => ({ id: other.item.id, title: other.item.title, playlistId: programPlaylistId(project, other.item) }));
    if (others.length) overlaps.set(range.item.id, others);
  }
  return overlaps;
}

/**
 * How a warning names the songs it overlaps: by title, and with the playlist when the title alone
 * would not tell which song is meant (the same title as this one, or a song of another playlist).
 */
export function songMtcOverlapNames(project: LinkProject, item: RundownItem, others: readonly SongMtcOverlap[]): string[] {
  const own = programPlaylistId(project, item);
  const lists = new Map(programPlaylists(project).map(list => [list.id, list.name]));
  return others.map(other => {
    if (other.title !== item.title && other.playlistId === own) return `「${other.title}」`;
    const list = other.playlistId === null ? undefined : lists.get(other.playlistId);
    return list === undefined ? `未分组里的「${other.title}」` : `播放列表「${list}」里的「${other.title}」`;
  });
}

/**
 * Songs being lit in this software that still have no MTC start: they have audio and lighting, hold
 * no Cues read from a console Timecode show, and can get a show of their own. A song without a start
 * cannot be paired with a console show (pairing is by the start alone). Songs without lighting keep
 * sending what they sent before, so a console show made for them by hand keeps running on the same timecode.
 */
export function songsNeedingMtcStart(project: LinkProject): string[] {
  return project.rundown.filter(item => item.referenceAudio && item.lighting && !item.playback && !item.p1Media
    && !item.lighting.ma2Bindings?.length && (!item.lighting.consoleSong || item.lighting.consoleSong.executor)).map(item => item.id);
}

/** MTC starts for those songs in rundown order, each after the one before, as `setAllocatedMtcStartsCommand` takes them. */
export function allocateMissingMtcStarts(project: LinkProject, console: Ma2TimecodeRanges): Map<string, number> {
  const starts = new Map<string, number>();
  const next = structuredClone(project);
  for (const id of songsNeedingMtcStart(project)) {
    const mtcOffsetMs = allocateSongMtcStart(next, id, console);
    const item = next.rundown.find(value => value.id === id);
    if (!item) throw new Error(`节目单中没有 ${id}`);
    item.playback = allocatedPlayback(mtcOffsetMs);
    starts.set(id, mtcOffsetMs);
  }
  return starts;
}

const allocatedPlayback = (mtcOffsetMs: number): NonNullable<LinkProject['rundown'][number]['playback']> => ({ volume: 100, startMs: 0, endMs: 0, mtcOffsetMs, shortcut: '' });

/**
 * Writes allocated MTC starts into songs that still have none. Like a console read-back it is kept
 * through undo and redo: undoing an edit never takes a song's start away, which would only allocate
 * it again and push the edit off the redo list. The start stays editable in the song's properties.
 */
export function setAllocatedMtcStartsCommand(starts: ReadonlyMap<string, number>): LinkCommand {
  if (!starts.size) throw new Error('没有需要分配 MTC 起点的歌曲');
  const apply = (project: LinkProject): LinkProject => {
    const missing = [...starts].filter(([id]) => project.rundown.some(item => item.id === id && !item.playback && !item.p1Media));
    if (!missing.length) return project;
    const next = structuredClone(project);
    for (const [id, mtcOffsetMs] of missing) for (const item of next.rundown) if (item.id === id) item.playback = allocatedPlayback(mtcOffsetMs);
    next.updatedAt = new Date().toISOString();
    return parseLinkProject(next);
  };
  return { id: crypto.randomUUID(), label: '分配歌曲 MTC 起点', historyRebaseKey: `mtc-start:${crypto.randomUUID()}`, rebaseHistory: apply, execute: apply, undo: before => before };
}
