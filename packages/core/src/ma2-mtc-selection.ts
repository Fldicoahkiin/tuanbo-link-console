import type { LinkProject, Ma2TimecodeRanges } from '@tb/schema';
import { songDurationMs } from './audio-edit';
import { MA2_SONG_TIMECODE_SLOT, ma2MtcGapTicks, readSongMtcStart, sameMtcRecording } from './mtc-start';

/** Native MA2 Timecode positions are 30 Hz ticks, independently of their display format. */
export type Ma2MtcSong = { timecode: number; start: number; end: number };
export type Ma2MtcSelection = { at: number; timecode: number | null };
type ConsoleRange = Ma2TimecodeRanges['entries'][number];
const dayTicks = 24 * 60 * 60 * 30;

type RangeEntry = Pick<ConsoleRange, 'target' | 'offset' | 'length' | 'last'>;
const unreadableRange = (target: number): string => `Timecode ${target} 的时间范围没有读清，请刷新控台时间线`;
function readRange(entry: RangeEntry): Ma2MtcSong | null {
  const start = Number(entry.offset);
  const length = Number(entry.length);
  const last = Number(entry.last);
  if (![start, length, last].every(value => Number.isSafeInteger(value) && value >= 0)) {
    return null;
  }
  return { timecode: entry.target, start, end: start + Math.max(length, entry.last === '' ? 0 : last + 1) };
}

export function ma2MtcRange(entry: RangeEntry): Ma2MtcSong {
  const range = readRange(entry);
  if (!range) throw new Error(unreadableRange(entry.target));
  return range;
}

export function ma2MtcSeparation(a: { start: number; end: number }, b: { start: number; end: number }): number {
  return Math.max(a.start - b.end, b.start - a.end);
}
const gapMessage = (a: number, b: number, minimum: number): string => `Timecode ${a} 和 ${b} 的间隔不足 ${minimum / 30} 秒，请修改其中一条的 MTC 起始码`;
function checkSeparation(a: Ma2MtcSong, b: Ma2MtcSong, minimum: number): void {
  const gap = ma2MtcSeparation(a, b);
  if (gap < 0) throw new Error(overlapMessage(a.timecode, b.timecode));
  if (gap < minimum) throw new Error(gapMessage(a.timecode, b.timecode, minimum));
}
const overlapMessage = (a: number, b: number): string => `Timecode ${a} 和 ${b} 的时间范围重叠，请修改其中一条的 MTC 起始码`;

/** IPC carries human-readable errors. Keep their two actionable object numbers with the rule that produces them. */
export function ma2MtcConflictTargets(message: string): [number, number] | null {
  const pair = /Timecode (\d{1,5}) 和 (\d{1,5}) 的(?:时间范围重叠|间隔不足 \d+ 秒)/.exec(message);
  return pair ? [Number(pair[1]), Number(pair[2])] : null;
}

export function ma2SelectorTrackProblem(conflict: NonNullable<Ma2TimecodeRanges['selectorTrackConflict']>): string {
  return `Timecode ${conflict.timecode} 第 ${conflict.track} 轨会触发选曲执行器 ${conflict.executor}，可能重复启动灯光。请关闭这条轨道的播放，或把它改到歌曲执行器，再同步。`;
}

/** Use the last desk read during playback. Never start a desk read from the Play button. */
export function playbackMtcGapProblem(project: LinkProject, item: LinkProject['rundown'][number], startMs: number, durationMs: number, desk?: Ma2TimecodeRanges): string | null {
  const start = Math.round(startMs * 30 / 1000);
  if (desk?.selectorTrackConflict) return ma2SelectorTrackProblem(desk.selectorTrackConflict);
  const targetOf = (song: typeof item) => song.lighting?.consoleSong?.timecode?.number ?? song.lighting?.timelineDestination?.timecode ?? song.lighting?.ma2Bindings?.[0]?.timecode;
  const target = targetOf(item);
  const catalog = project.ma2ReadState?.catalog;
  const entries = desk?.entries ?? catalog?.entries.flatMap(entry => {
    if (entry.error || !entry.eventCount || !/^\d+$/.test(entry.offset ?? '') || !/^\d*$/.test(entry.length ?? '') || !entry.slot || entry.offset === null) return [];
    const last = entry.events.reduce((tick, event) => Math.max(tick, Number(event.time) || 0), 0);
    return [{ target: entry.target, slot: entry.slot, offset: entry.offset, length: entry.length ?? '0', last: String(last) }];
  }) ?? [];
  const owner = target ? entries.find(entry => entry.target === target) : entries.find(entry => Number(entry.offset) === start && entry.slot === MA2_SONG_TIMECODE_SLOT);
  if (owner && owner.slot !== MA2_SONG_TIMECODE_SLOT) return null;
  const ownRange = owner && readRange(owner);
  if (owner && !ownRange) return unreadableRange(owner.target);
  const interval = { start, end: Math.max(start + Math.ceil(durationMs * 30 / 1000), ownRange?.start === start ? ownRange.end : start) };
  const minimum = ma2MtcGapTicks(desk?.afterRollSeconds ?? catalog?.afterRollSeconds);
  for (const entry of entries) {
    if (entry.target === owner?.target || entry.slot !== MA2_SONG_TIMECODE_SLOT || entry.last === '' || ('internal' in entry && entry.internal)) continue;
    const other = readRange(entry);
    if (!other) return unreadableRange(entry.target);
    const gap = ma2MtcSeparation(interval, other);
    // An unbound song can have several same-origin matches in a saved catalog from
    // a different Show. Pairing reports that ambiguity; only a live read proves both exist.
    if (gap < 0 && !desk && !target && other.start === start) continue;
    if (gap < 0) return owner ? overlapMessage(owner.target, entry.target) : `本曲与 Timecode ${entry.target} 的时间范围重叠，请调整 MTC 起始码`;
    if (gap < minimum) {
      return owner ? gapMessage(owner.target, entry.target, minimum) : `本曲与 Timecode ${entry.target} 的间隔不足 ${minimum / 30} 秒，请调整 MTC 起始码`;
    }
  }
  for (const other of project.rundown) {
    if (other === item || !other.referenceAudio || !other.playback && !other.p1Media) continue;
    const bound = entries.find(entry => entry.target === targetOf(other));
    if (bound && bound.slot !== MA2_SONG_TIMECODE_SLOT) continue;
    const origin = readSongMtcStart(other);
    if (origin.state !== 'set') continue;
    const first = Math.round(origin.startMs * 30 / 1000);
    const gap = ma2MtcSeparation(interval, { start: first, end: first + Math.ceil(songDurationMs(other.referenceAudio) * 30 / 1000) });
    if (gap < 0 && item.referenceAudio && sameMtcRecording(item.referenceAudio.sha256, startMs, other.referenceAudio.sha256, origin.startMs)) continue;
    if (gap < 0) return `本曲与节目「${other.title}」的时间范围重叠，请调整 MTC 起始码`;
    if (gap < minimum) return `本曲与节目「${other.title}」的间隔不足 ${minimum / 30} 秒，请调整 MTC 起始码`;
  }
  return null;
}

/** Check only the proposed move, so an unrelated overlapping pair can be repaired separately. */
export function checkMa2MtcStart(entries: readonly ConsoleRange[], target: number, startMs: number, minimumMs = 0, planned = false, afterRollSeconds?: number): Ma2MtcSong {
  const current = entries.find(value => value.target === target && !value.internal);
  if (!current && !planned) throw new Error(`控台上没有 Timecode ${target}，请刷新时间线`);
  const range = current ? ma2MtcRange(current) : null;
  const start = Math.round(startMs * 30 / 1000);
  const duration = Math.max(1, Math.ceil(minimumMs * 30 / 1000), range ? range.end - range.start : 0);
  const candidate = { timecode: target, start, end: start + duration };
  checkMtcRange(entries, current?.slot ?? MA2_SONG_TIMECODE_SLOT, candidate, afterRollSeconds);
  return candidate;
}

function checkMtcRange(entries: readonly ConsoleRange[], slot: string, candidate: Ma2MtcSong, afterRollSeconds?: number): void {
  if (!Number.isSafeInteger(candidate.start) || candidate.start < 0 || candidate.end >= dayTicks) throw new Error('这条时间线会到达或跨过午夜，请输入更早的 MTC 起始码');
  for (const other of entries) {
    if (other.target === candidate.timecode || other.internal || other.last === '' || other.slot !== slot) continue;
    checkSeparation(candidate, ma2MtcRange(other), slot === MA2_SONG_TIMECODE_SLOT ? ma2MtcGapTicks(afterRollSeconds) : 0);
  }
}

/** Keep an edited final Cue through the music, inside the available interval on the same MIDI slot. */
export function ma2EditedCueHold(entries: readonly ConsoleRange[], target: number, offset: number, cueTick: number, songEndTick: number, afterRollSeconds?: number): number {
  const current = entries.find(entry => entry.target === target && !entry.internal);
  if (!current || current.slot !== MA2_SONG_TIMECODE_SLOT || ma2MtcRange(current).start !== offset) {
    throw new Error(`Timecode ${target} 的起始码或时间码源已变化，请重新核对当前节目`);
  }
  const end = Math.max(offset + cueTick + 1, songEndTick);
  checkMtcRange(entries, current.slot, { timecode: target, start: offset, end }, afterRollSeconds);
  return end - offset;
}

/** One selection at every song boundary. Ambiguous or invalid ranges must never pick an arbitrary song. */
export function ma2MtcSelections(input: readonly Ma2MtcSong[], afterRollSeconds?: number): Ma2MtcSelection[] {
  const songs = [...input].sort((a, b) => a.start - b.start || a.timecode - b.timecode);
  const seen = new Set<number>();
  for (const [index, song] of songs.entries()) {
    if (!Number.isInteger(song.timecode) || song.timecode < 1 || song.timecode > 99999 || seen.has(song.timecode)
      || !Number.isSafeInteger(song.start) || !Number.isSafeInteger(song.end) || song.start < 0 || song.start >= song.end || song.end >= dayTicks) {
      throw new Error('控台时间线的编号或时间范围无效，无法准备歌曲切换');
    }
    seen.add(song.timecode);
    const previous = songs[index - 1];
    if (previous) checkSeparation(previous, song, ma2MtcGapTicks(afterRollSeconds));
  }
  const positions = new Map<number, number | null>([[0, null]]);
  for (const song of songs) { positions.set(song.start, song.timecode); positions.set(song.end, null); }
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
