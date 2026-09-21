import type { LinkProject, Ma2Catalog } from '@tb/schema';
import { parseP1TimeOrigin } from './ma2-time-origin';

export function matchMa2Programs(project: LinkProject, catalog: Ma2Catalog): { pairs: Record<number, string>; unresolved: { target: number; reason: string }[] } {
  const pairs: Record<number, string> = {};
  const unresolved: { target: number; reason: string }[] = [];
  const normalize = (name: string): string => name.normalize('NFKC').trim().toLocaleLowerCase().replace(/\.(wav|mp3|flac|aac|m4a|ogg|mp4|m4v|mov|mkv|avi|webm)$/i, '');
  const songs = project.rundown.filter(item => item.referenceAudio && !item.p1UnavailableSourceKey).map(item => ({ item, start: item.p1Media ? parseP1TimeOrigin(item.p1Media.midiStartTime) : item.playback?.mtcOffsetMs ?? 0 }));
  for (const entry of catalog.entries) {
    if (entry.eventCount === 0) continue;
    if (entry.error) { unresolved.push({ target: entry.target, reason: entry.error }); continue; }
    if (project.rundown.some(item => item.lighting?.ma2Bindings?.some(binding => binding.timecode === entry.target))) continue;
    if (entry.frameFormat !== '30 FPS' || !/^\d+(?:\.\d+)?$/.test(entry.offset ?? '0') || entry.events.some(event => !/^\d+(?:\.\d+)?$/.test(event.time))) { unresolved.push({ target: entry.target, reason: '时间格式尚未支持，请手动核对' }); continue; }
    const times = entry.events.map(event => (Number(event.time) + Number(entry.offset ?? 0)) * 1000 / 30);
    const candidates = songs.filter(({ item, start }) => times.length > 0 && times.every(time => time >= start && time < start + item.referenceAudio!.durationMs));
    const named = candidates.filter(({ item }) => [item.title, item.p1Media?.sourceFileName ?? ''].some(name => normalize(name) === normalize(entry.name)));
    const selected = named.length === 1 ? named : candidates.length === 1 && candidates[0]!.start > 0 ? candidates : [];
    if (selected.length !== 1) { unresolved.push({ target: entry.target, reason: candidates.length ? '歌曲时间区间或名称不能唯一确认，请核对并选择歌曲' : '没有完整包含这些事件的歌曲，请核对起点或拆分时间线' }); continue; }
    pairs[entry.target] = selected[0]!.item.id;
  }
  return { pairs, unresolved };
}
