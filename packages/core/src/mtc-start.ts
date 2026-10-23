import type { LinkProject, Ma2TimecodeRanges } from '@tb/schema';
import { programTimeOrigin } from './ma2-time-origin';

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
  if (!item?.referenceAudio) throw new Error('歌曲缺少参考音频时长，无法分配时间码起点');
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
