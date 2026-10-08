import type { LinkProject, Ma2Catalog } from '@tb/schema';
import { programTimeOrigin } from './ma2-time-origin';

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
    const times = entry.events.map(event => (Number(event.time) + Number(entry.offset ?? 0)) * 1000 / 30);
    const candidates = songs.filter(({ item, start }) => times.length > 0 && times.every(time => time >= start && time < start + item.referenceAudio!.durationMs));
    const selected = candidates.length === 1 ? candidates : [];
    if (selected.length !== 1) { unresolved.push({ target: entry.target, reason: candidates.length ? '歌曲原始时间区间重叠，请核对并选择歌曲；不按歌名或序号硬配' : `没有完整包含这些事件的已确认歌曲区间，请核对起点或拆分时间线${originErrors.length ? `；${originErrors.join('；')}` : ''}` }); continue; }
    pairs[entry.target] = selected[0]!.item.id;
  }
  return { pairs, unresolved };
}
