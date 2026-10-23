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
