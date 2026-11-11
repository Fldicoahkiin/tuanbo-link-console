import type { LinkProject, Ma2Catalog } from '@tb/schema';
import { formatMtcOffset } from './mtc-timecode';
import { MA2_FRAME_MS, programTimeOrigin } from './ma2-time-origin';

type Ma2CatalogEntry = Ma2Catalog['entries'][number];

/** MA2 keeps a show's offset and event times in 1/30 s whatever its frame format. */
const TICKS_PER_SECOND = 30;

/** The show's start in console ticks, or null when the console wrote something else. */
export function ma2ShowStartTicks(entry: Pick<Ma2CatalogEntry, 'offset'>): number | null {
  const text = entry.offset ?? '0';
  return /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : null;
}

/**
 * A song and a console Timecode show belong together when they start on the same frame (2026-10-26,
 * lighting workflow rule 3). Less than one frame apart counts as the same start: a P1 start such as
 * 11820.02 s and a show offset in whole 1/30 s name the same frame.
 */
export function sameMtcStart(songStartMs: number, showTicks: number): boolean {
  return Math.abs(songStartMs * TICKS_PER_SECOND / 1000 - showTicks) < 1;
}

/** The Timecode events (offset added) after the end of the song's audio: kept and shown, never a reason not to pair. */
export function ma2EventsAfterSong(entry: Ma2CatalogEntry, startMs: number, durationMs: number): Ma2CatalogEntry['events'] {
  const start = ma2ShowStartTicks(entry);
  if (start === null) return [];
  return entry.events.filter(event => /^\d+(?:\.\d+)?$/.test(event.time) && (Number(event.time) + start) * 1000 / TICKS_PER_SECOND >= startMs + durationMs);
}

export type Ma2StartMatch = {
  /** Console show → song: the show starts where exactly one song starts, and that song starts no other show. */
  pairs: Record<number, string>;
  /** Shows with events that are not paired, and why. */
  unresolved: { target: number; reason: string }[];
  /** Songs that start where two or more console shows start: the shows, in number order. Nothing is guessed. */
  duplicateStarts: Record<string, number[]>;
  /** Paired shows with something to know that does not stop the pairing. */
  notes: { target: number; text: string }[];
  /**
   * Songs whose MTC start moved off the console shows they hold Cues from and onto exactly one other
   * show (2026-11-04): that show replaces them, the Cues of the old ones are archived. Applied by the
   * pairing step of every edit, so a switch is never left waiting.
   */
  switches: Ma2TimelineSwitch[];
};

export type Ma2TimelineSwitch = { itemId: string; from: number[]; to: number };

/**
 * Which console Timecode show runs with which song, by the MTC start alone (2026-10-26). The show's
 * number counts only for a song that already took that show's Cues (a binding): the show must still
 * start where the song starts. Names, the console Show, the audio and the Cue times play no part.
 * A song's own show (made by this software for a new song) belongs to that song and is not matched.
 * `failed` holds why a switch to a show could not be made; that show is not proposed again until the
 * operator asks for it in the console timeline view.
 */
export function matchMa2Programs(project: LinkProject, catalog: Ma2Catalog, failed: ReadonlyMap<number, string> = new Map()): Ma2StartMatch {
  const unresolved: Ma2StartMatch['unresolved'] = [];
  const switches: Ma2TimelineSwitch[] = [];
  const notes: Ma2StartMatch['notes'] = [];
  const frameRate = project.timebase.frameRate;
  const songs = project.rundown.flatMap(item => {
    if (!item.referenceAudio || item.p1UnavailableSourceKey || !item.p1Media && !item.playback || item.lighting?.consoleSong) return [];
    try { return [{ item, start: programTimeOrigin(item) }]; }
    catch { return []; }
  });
  const own = new Set(project.rundown.flatMap(item => item.lighting?.consoleSong?.timecode ? [item.lighting.consoleSong.timecode.number] : []));
  const bound = new Map(project.rundown.flatMap(item => (item.lighting?.ma2Bindings ?? []).map(binding => [binding.timecode, item.id] as const)));
  const placedAt = new Map(project.rundown.flatMap(item => (item.lighting?.ma2Bindings ?? []).map(binding => [binding.timecode, binding.timeOriginMs ?? 0] as const)));
  const found = new Map<number, string>();
  for (const entry of catalog.entries) {
    if (own.has(entry.target)) continue;
    const owner = bound.get(entry.target);
    if (!owner && entry.eventCount === 0) continue;
    if (entry.error) { unresolved.push({ target: entry.target, reason: entry.error }); continue; }
    const start = ma2ShowStartTicks(entry);
    if (start === null) { unresolved.push({ target: entry.target, reason: `控台写的起点“${entry.offset ?? ''}”读不懂，没有对歌曲` }); continue; }
    const code = formatMtcOffset(start * 1000 / TICKS_PER_SECOND, frameRate);
    if (owner) {
      const song = songs.find(value => value.item.id === owner);
      // The Cues were put on the song from the start they had then; both must still be the show's start.
      const placed = placedAt.get(entry.target) ?? 0;
      if (song && sameMtcStart(song.start, start) && sameMtcStart(placed, start)) found.set(entry.target, owner);
      else unresolved.push({ target: entry.target, reason: !song
        ? `「${project.rundown.find(item => item.id === owner)?.title ?? owner}」还没有可用的 MTC 起始码，已放进歌曲的 Cue 都保留，先不往控台写`
        : !sameMtcStart(song.start, start)
          ? `控台 Timecode ${entry.target} 从 ${code} 开始，和「${song.item.title}」的 MTC 起始码 ${formatMtcOffset(song.start, frameRate)} 对不上。已放进歌曲的 Cue 都保留，这首歌先不往控台写`
          : `「${song.item.title}」里 Timecode ${entry.target} 的 Cue 是按起点 ${formatMtcOffset(placed, frameRate)} 放的，和现在的 ${code} 对不上。Cue 都保留，这首歌先不往控台写；请在控台时间线里点“从控台刷新”` });
      continue;
    }
    const same = songs.filter(song => sameMtcStart(song.start, start));
    if (same.length === 1) found.set(entry.target, same[0]!.item.id);
    else if (same.length > 1) unresolved.push({ target: entry.target, reason: `有 ${same.length} 首歌的 MTC 起始码都是 ${code}（${same.map(song => `「${song.item.title}」`).join('、')}），分不清是哪一首，没有对上。请改开其中几首的起始码` });
  }
  for (const [target, itemId] of bound) if (!own.has(target) && !catalog.entries.some(entry => entry.target === target)) {
    unresolved.push({ target, reason: `新读取的控台里没有 Timecode ${target}。「${project.rundown.find(item => item.id === itemId)?.title ?? itemId}」已放进的 Cue 都保留，这首歌先不往控台写` });
  }
  const bySong = new Map<string, number[]>();
  for (const [target, itemId] of found) bySong.set(itemId, [...bySong.get(itemId) ?? [], target]);
  const pairs: Record<number, string> = {};
  const duplicateStarts: Record<string, number[]> = {};
  for (const [itemId, targets] of bySong) {
    // The song already holds the Cues of a show that no longer starts with it: another show starting there
    // is not taken over silently, or the song would hold two shows with different starts.
    const lost = [...bound].filter(([target, owner]) => owner === itemId && !found.has(target)).map(([target]) => target);
    if (lost.length) {
      const song = songs.find(value => value.item.id === itemId)!;
      const fresh = targets.filter(value => !bound.has(value));
      const held = targets.filter(value => bound.has(value));
      const blocker = fresh.length === 1 && !held.length ? switchBlocker(song, lost, fresh[0]!, catalog, failed, frameRate) : null;
      if (fresh.length === 1 && !held.length && blocker === null) { switches.push({ itemId, from: lost, to: fresh[0]! }); continue; }
      for (const target of fresh) unresolved.push({ target, reason: blocker ?? `Timecode ${target} 和「${song.item.title}」起点一样，但控台上还有别的时间线也从这个起点开始，没有自动换过去` });
      targets.splice(0, targets.length, ...held);
      if (!targets.length) continue;
    }
    const sorted = targets.sort((a, b) => a - b);
    if (sorted.length > 1) {
      duplicateStarts[itemId] = sorted;
      const title = project.rundown.find(item => item.id === itemId)?.title ?? itemId;
      for (const target of sorted) unresolved.push({ target, reason: `控台上 Timecode ${sorted.join('、')} 的起点相同，都和「${title}」的起始码一样，分不清用哪一个，没有对上。请在控台上改开它们的起点，或删掉多余的` });
      continue;
    }
    const target = sorted[0]!;
    pairs[target] = itemId;
    const song = songs.find(value => value.item.id === itemId)!;
    const entry = catalog.entries.find(value => value.target === target)!;
    const after = ma2EventsAfterSong(entry, song.start, song.item.referenceAudio!.durationMs);
    if (after.length) notes.push({ target, text: `控台 Timecode ${target} 有 ${after.length} 个事件在歌曲结束之后，播放到歌曲结束就不会触发` });
  }
  return { pairs, unresolved: unresolved.sort((a, b) => a.target - b.target), duplicateStarts, notes, switches };
}

/**
 * Why a song that moved its MTC start cannot take over the one show now starting there, or null when
 * it can: every show it holds Cues from has left that start (or the console no longer has it), the
 * read is complete, and the new show's Cues can go on the song as they are.
 */
function switchBlocker(song: { item: LinkProject['rundown'][number]; start: number }, from: readonly number[], to: number, catalog: Ma2Catalog, failed: ReadonlyMap<number, string>, frameRate: LinkProject['timebase']['frameRate']): string | null {
  const title = song.item.title;
  const failure = failed.get(to);
  if (failure !== undefined) return `Timecode ${to} 和「${title}」起点一样，但没能换过去：${failure}`;
  if (catalog.incomplete || catalog.sourceUnverified) return `Timecode ${to} 和「${title}」起点一样，控台读完整后自动换过去`;
  for (const target of from) {
    const entry = catalog.entries.find(value => value.target === target);
    if (!entry) continue;
    const start = entry.error ? null : ma2ShowStartTicks(entry);
    if (start === null) return `Timecode ${to} 和「${title}」起点一样，但原来的 Timecode ${target} 没读清楚，没有自动换过去`;
    if (sameMtcStart(song.start, start)) return `Timecode ${to} 和「${title}」起点一样，但原来的 Timecode ${target} 也还从这个起点开始，分不清用哪一个`;
  }
  const entry = catalog.entries.find(value => value.target === to);
  if (!entry?.preview || entry.error || entry.conversionError) return `Timecode ${to} 和「${title}」起点一样，但这一条还没读取完整，读完后自动换过去`;
  if (entry.preview.timing?.absoluteEventTimesMs.some(time => time < song.start - MA2_FRAME_MS)) {
    return `Timecode ${to} 里有比「${title}」起始码 ${formatMtcOffset(song.start, frameRate)} 还早的事件，没有自动换过去`;
  }
  return null;
}
