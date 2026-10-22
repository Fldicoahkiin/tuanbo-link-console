import type { LinkProject, Ma2Catalog } from '@tb/schema';
import { programTimeOrigin } from './ma2-time-origin';

type Ma2CatalogEntry = Ma2Catalog['entries'][number];
/** The first Timecode event (offset added, 30 FPS) outside the song's audio, or undefined when all fit. */
export function ma2EventOutsideSong(entry: Ma2CatalogEntry, startMs: number, durationMs: number): Ma2CatalogEntry['events'][number] | undefined {
  return entry.events.find(event => {
    const time = (Number(event.time) + Number(entry.offset ?? 0)) * 1000 / 30;
    return time < startMs || time >= startMs + durationMs;
  });
}

export function matchMa2Programs(project: LinkProject, catalog: Ma2Catalog): { pairs: Record<number, string>; unresolved: { target: number; reason: string }[] } {
  const pairs: Record<number, string> = {};
  const unresolved: { target: number; reason: string }[] = [];
  const originErrors: string[] = [];
  const songs = project.rundown.filter(item => item.referenceAudio && !item.p1UnavailableSourceKey && (item.p1Media || item.playback)).flatMap(item => {
    if (item.p1Media?.importedFullSource) { originErrors.push(`${item.title}：P1 裁剪未按原范围导入，请核对音频坐标`); return []; }
    try { return [{ item, start: programTimeOrigin(item) }]; }
    catch (error) { originErrors.push(`${item.title}：${error instanceof Error ? error.message : String(error)}`); return []; }
  });
  for (const entry of catalog.entries) {
    if (entry.eventCount === 0) continue;
    if (entry.error) { unresolved.push({ target: entry.target, reason: entry.error }); continue; }
    if (project.rundown.some(item => item.lighting?.ma2Bindings?.some(binding => binding.timecode === entry.target))) continue;
    if (entry.frameFormat !== '30 FPS' || !/^\d+(?:\.\d+)?$/.test(entry.offset ?? '0') || entry.events.some(event => !/^\d+(?:\.\d+)?$/.test(event.time))) { unresolved.push({ target: entry.target, reason: '时间格式尚未支持，请手动核对' }); continue; }
    const fits = ({ item, start }: typeof songs[number]): boolean => entry.events.length > 0 && !ma2EventOutsideSong(entry, start, item.referenceAudio!.durationMs);
    const titles = (list: typeof songs): string => list.map(({ item }) => `“${item.title}”`).join('、');
    // A song whose start (in 30 FPS frames) equals the Timecode offset is paired first; several such
    // songs are told apart by their events and then by the Timecode length, never by name or order.
    const sameStart = songs.filter(({ start }) => Math.round(start * 30 / 1000) === Number(entry.offset ?? 0));
    if (sameStart.length) {
      const inside = sameStart.filter(fits);
      const length = Number(entry.length ?? 0) * 1000 / 30;
      const sized = inside.length > 1 && length > 0 ? inside.filter(({ item }) => length <= item.referenceAudio!.durationMs) : inside;
      if (sized.length === 1) { pairs[entry.target] = sized[0]!.item.id; continue; }
      unresolved.push({ target: entry.target, reason: inside.length ? `起始码相同的歌曲有 ${titles(sized.length ? sized : inside)}，无法区分，请核对并选择歌曲` : `起始码与 ${titles(sameStart)} 相同，但事件超出歌曲时长，请核对起点或拆分时间线` });
      continue;
    }
    const candidates = songs.filter(fits);
    const selected = candidates.length === 1 ? candidates : [];
    if (selected.length !== 1) { unresolved.push({ target: entry.target, reason: candidates.length ? '歌曲原始时间区间重叠，请核对并选择歌曲；不按歌名或序号硬配' : `没有完整包含这些事件的已确认歌曲区间，请核对起点或拆分时间线${originErrors.length ? `；${originErrors.join('；')}` : ''}` }); continue; }
    pairs[entry.target] = selected[0]!.item.id;
  }
  return { pairs, unresolved };
}
