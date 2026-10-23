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

/** A show whose length the console does not give still runs past its last event; this much is kept clear after it. */
const LAST_EVENT_MARGIN_TICKS = 30 * 30;

/**
 * The MTC start for a song synced to the console without one: after every console Timecode show
 * (offset to its length, or to its last event plus a margin when the length does not cover it,
 * in 30 Hz ticks) and every other song of the project that has a start. A show whose range cannot
 * be told stops the allocation instead of being guessed.
 */
export function allocateSongMtcStart(project: LinkProject, itemId: string, console: Ma2TimecodeRanges): number {
  const item = project.rundown.find(value => value.id === itemId);
  if (!item?.referenceAudio) throw new Error('歌曲缺少参考音频时长，无法分配时间码起点');
  const occupied: Array<{ startMs: number; endMs: number }> = [];
  const unclear: string[] = [];
  for (const show of console.entries) {
    const offset = Number(show.offset); const length = show.length === '' ? 0 : Number(show.length); const last = show.last === '' ? null : Number(show.last);
    if (show.frame !== '30 FPS' || !Number.isFinite(offset) || !Number.isFinite(length) || last !== null && !Number.isFinite(last)) { unclear.push(`Timecode ${show.target}（${show.frame || '帧率未知'}）`); continue; }
    // The console's length when it covers every event; otherwise the last event plus a margin.
    const ticks = last === null || length >= last ? length : last + LAST_EVENT_MARGIN_TICKS;
    occupied.push({ startMs: offset * 1000 / 30, endMs: (offset + ticks) * 1000 / 30 });
  }
  if (unclear.length) throw new Error(`控台上这些时间码节目的时间范围无法确定，未分配起点，请在控台核对：${unclear.join('、')}`);
  for (const other of project.rundown) {
    if (other.id === itemId || !other.referenceAudio || !other.playback && !other.p1Media) continue;
    const start = programTimeOrigin(other);
    occupied.push({ startMs: start, endMs: start + other.referenceAudio.durationMs });
  }
  return nextMtcStartMs(occupied, item.referenceAudio.durationMs);
}
