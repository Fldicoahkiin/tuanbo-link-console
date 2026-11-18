import type { Ma2TimecodeRanges } from '@tb/schema';
import { MA2_SONG_TIMECODE_SLOT } from './mtc-start';

/** Native MA2 Timecode positions are 30 Hz ticks, independently of their display format. */
export type Ma2MtcSong = { timecode: number; start: number; end: number };
export type Ma2MtcSelection = { at: number; timecode: number | null };
type ConsoleRange = Ma2TimecodeRanges['entries'][number];
const dayTicks = 24 * 60 * 60 * 30;

export function ma2MtcRange(entry: ConsoleRange): Ma2MtcSong {
  const start = Number(entry.offset);
  const length = Number(entry.length);
  const last = Number(entry.last);
  if (![start, length, last].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error(`Timecode ${entry.target} 的时间范围没有读清，请刷新控台时间线`);
  }
  return { timecode: entry.target, start, end: start + Math.max(length, entry.last === '' ? 0 : last + 1) };
}

const overlap = (a: Ma2MtcSong, b: Ma2MtcSong): boolean => a.start < b.end && b.start < a.end;
const overlapMessage = (a: number, b: number): string => `Timecode ${a} 和 ${b} 的时间范围重叠，请修改其中一条的 MTC 起始码`;

/** IPC carries human-readable errors. Keep their two actionable object numbers with the rule that produces them. */
export function ma2MtcConflictTargets(message: string): [number, number] | null {
  const pair = /Timecode (\d{1,5}) 和 (\d{1,5}) 的时间范围重叠/.exec(message);
  return pair ? [Number(pair[1]), Number(pair[2])] : null;
}

/** Check only the proposed move, so an unrelated overlapping pair can be repaired separately. */
export function checkMa2MtcStart(entries: readonly ConsoleRange[], target: number, startMs: number, minimumMs = 0, planned = false): Ma2MtcSong {
  const current = entries.find(value => value.target === target && !value.internal);
  if (!current && !planned) throw new Error(`控台上没有 Timecode ${target}，请刷新时间线`);
  const range = current ? ma2MtcRange(current) : null;
  const start = Math.round(startMs * 30 / 1000);
  const duration = Math.max(1, Math.ceil(minimumMs * 30 / 1000), range ? range.end - range.start : 0);
  const candidate = { timecode: target, start, end: start + duration };
  if (!Number.isSafeInteger(start) || start < 0 || candidate.end >= dayTicks) throw new Error('这条时间线会到达或跨过午夜，请输入更早的 MTC 起始码');
  for (const other of entries) {
    if (other.target === target || other.internal || other.last === '' || other.slot !== (current?.slot ?? MA2_SONG_TIMECODE_SLOT)) continue;
    if (overlap(candidate, ma2MtcRange(other))) throw new Error(overlapMessage(target, other.target));
  }
  return candidate;
}

/** One selection at every song boundary. Ambiguous or invalid ranges must never pick an arbitrary song. */
export function ma2MtcSelections(input: readonly Ma2MtcSong[]): Ma2MtcSelection[] {
  const songs = [...input].sort((a, b) => a.start - b.start || a.timecode - b.timecode);
  const seen = new Set<number>();
  for (const [index, song] of songs.entries()) {
    if (!Number.isInteger(song.timecode) || song.timecode < 1 || song.timecode > 99999 || seen.has(song.timecode)
      || !Number.isSafeInteger(song.start) || !Number.isSafeInteger(song.end) || song.start < 0 || song.start >= song.end || song.end >= dayTicks) {
      throw new Error('控台时间线的编号或时间范围无效，无法准备歌曲切换');
    }
    seen.add(song.timecode);
    const previous = songs[index - 1];
    if (previous && overlap(previous, song)) throw new Error(overlapMessage(previous.timecode, song.timecode));
  }
  const positions = new Map<number, number | null>([[0, null]]);
  for (const song of songs) { positions.set(song.start, song.timecode); positions.set(song.end, null); }
  // At a touching boundary the next song owns that frame, regardless of input order.
  for (const song of songs) positions.set(song.start, song.timecode);
  return [...positions].sort(([a], [b]) => a - b).map(([at, timecode]) => ({ at, timecode }));
}

/** The console executes these commands from its MTC selection Cue; the computer sends no playback commands. */
export function ma2MtcSelectionCommand(timecodes: readonly number[], selected: number | null): string {
  if (timecodes.length > 256 || new Set(timecodes).size !== timecodes.length || timecodes.some(number => !Number.isInteger(number) || number < 1 || number > 99999)
    || (selected !== null && !timecodes.includes(selected))) throw new Error('控台选曲清单无效或超过 256 条时间线');
  const others = timecodes.filter(number => number !== selected).sort((a, b) => a - b);
  return [...(others.length ? [`Off Timecode ${others.join(' + ')}`] : []), ...(selected === null ? [] : [`Go Timecode ${selected}`])].join('; ');
}

/** Internal selector objects still occupy their pool numbers, but are never songs or audition material. */
export function ma2SongDirectory<T extends { entries: ReadonlyArray<{ internal?: true | undefined }> }>(directory: T): T {
  return { ...directory, entries: directory.entries.filter(entry => !entry.internal) };
}
