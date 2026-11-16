/** Native MA2 Timecode positions are 30 Hz ticks, independently of their display format. */
export type Ma2MtcSong = { timecode: number; start: number; end: number };
export type Ma2MtcSelection = { at: number; timecode: number | null };

/** One selection at every song boundary. Ambiguous or invalid ranges must never pick an arbitrary song. */
export function ma2MtcSelections(input: readonly Ma2MtcSong[]): Ma2MtcSelection[] {
  const songs = [...input].sort((a, b) => a.start - b.start || a.timecode - b.timecode);
  const seen = new Set<number>();
  for (const [index, song] of songs.entries()) {
    if (!Number.isInteger(song.timecode) || song.timecode < 1 || song.timecode > 99999 || seen.has(song.timecode)
      || !Number.isSafeInteger(song.start) || !Number.isSafeInteger(song.end) || song.start < 0 || song.start >= song.end || song.end >= 2592000) {
      throw new Error('控台时间线的编号或时间范围无效，无法准备歌曲切换');
    }
    seen.add(song.timecode);
    const previous = songs[index - 1];
    if (previous && previous.end > song.start) throw new Error(`Timecode ${previous.timecode} 和 ${song.timecode} 的时间范围重叠，请先调整起始码或长度再同步`);
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
