import type { LinkProject, MtcFrameRate } from '@tb/schema';
import { ma2PendingChanges } from './ma2-pending-changes';
import { ma2SongPoints } from './ma2-song-sequence';
import { lightingTimeOrigin, programTimeOrigin } from './ma2-time-origin';

export type SongLightingStatus =
  | { state: 'unmatched' }
  | { state: 'editing'; pending: number }
  | { state: 'ready'; timecode: number; startMs: number; frameRate: MtcFrameRate }
  | { state: 'attention'; reasons: string[] };

/**
 * Whether a song's lighting can run from its own console Timecode show when the player sends MTC.
 * Read from the project alone (pairings confirmed against a console read, Timecode bindings and
 * local edits), so it answers the same with the network cable unplugged. `ready.startMs` is the
 * song's MTC start, already checked against the paired show's offset and events.
 */
export function songLightingStatus(project: LinkProject, itemId: string): SongLightingStatus {
  const item = project.rundown.find(value => value.id === itemId);
  if (!item) throw new Error(`节目单中没有 ${itemId}`);
  const own = item.lighting?.consoleSong;
  if (item.lighting && own?.timecode) return ownShowStatus(item, item.lighting, own, own.timecode);
  if (own && !own.executor) return { state: 'attention', reasons: ['本曲控台序列只放在 Layout 页面上，没有执行器位置，不能建时间码节目'] };
  const pairings = Object.entries(project.ma2ReadState?.pairings ?? {}).filter(([, pairing]) => pairing.itemId === itemId);
  const bindings = item.lighting?.ma2Bindings ?? [];
  if (!pairings.length && !bindings.length) return { state: 'unmatched' };
  const reasons: string[] = [];
  for (const [target, pairing] of pairings) {
    if (pairing.status === 'stale') reasons.push(`控台 Timecode ${target}：${pairing.reason ?? '需要重新核对配对'}`);
    if (pairing.status === 'suggested') reasons.push(`控台 Timecode ${target} 是自动匹配结果，尚未确认`);
  }
  for (const binding of bindings) if (!pairings.some(([target]) => Number(target) === binding.timecode)) reasons.push(`控台 Timecode ${binding.timecode} 尚未读取控台核对配对`);
  const confirmed = pairings.filter(([, pairing]) => pairing.status === 'confirmed');
  if (confirmed.length > 1) reasons.push(`同一首歌对应多个控台 Timecode：${confirmed.map(([target]) => target).join('、')}`);
  let startMs: number | null = null;
  try {
    startMs = programTimeOrigin(item);
    if (lightingTimeOrigin(item.lighting, startMs) !== startMs) reasons.push('歌曲起始时间与控台时间线的起点不一致');
  } catch (error) { reasons.push(error instanceof Error ? error.message : String(error)); }
  for (const [target] of confirmed) {
    const frame = project.ma2ReadState?.catalog.entries.find(entry => entry.target === Number(target))?.frameFormat;
    if (frame !== '30 FPS') reasons.push(`控台 Timecode ${target} 的帧率为 ${frame ?? '未知'}，只支持 30 FPS`);
  }
  const pending = ma2PendingChanges(project).filter(change => change.itemId === itemId);
  for (const change of pending) if (change.error) reasons.push(`控台 Timecode ${change.target}：${change.error}`);
  if (reasons.length) return { state: 'attention', reasons };
  const count = pending.reduce((total, change) => total + change.changes.length, 0);
  if (count) return { state: 'editing', pending: count };
  if (confirmed.length === 1 && startMs !== null) return { state: 'ready', timecode: Number(confirmed[0]![0]), startMs, frameRate: '30' };
  return { state: 'unmatched' };
}

type Item = LinkProject['rundown'][number];
type Lighting = NonNullable<Item['lighting']>;
type ConsoleSong = NonNullable<Lighting['consoleSong']>;
const frames = (ms: number): number => Math.round(ms * 30 / 1000);

/**
 * A song with the program's own Timecode show: ready while every point still fires its own Cue of
 * the song's Sequence at the frame last written and the song start is unchanged; any difference is
 * an edit the next sync writes.
 */
function ownShowStatus(item: Item, lighting: Lighting, song: ConsoleSong, timecode: NonNullable<ConsoleSong['timecode']>): SongLightingStatus {
  let startMs: number; let points: ReturnType<typeof ma2SongPoints>;
  try { startMs = programTimeOrigin(item); points = ma2SongPoints(lighting); }
  catch (error) { return { state: 'attention', reasons: [error instanceof Error ? error.message : String(error)] }; }
  const written = new Map(song.points.map(point => [point.id, point]));
  let pending = frames(startMs) === timecode.offset ? 0 : 1;
  for (const point of points) {
    const stored = written.get(point.id);
    const own = stored && point.cues.length === 1 && point.cues[0]!.sequence === song.sequence && Number(point.cues[0]!.cue) === Number(stored.cue);
    if (!stored || !own || stored.atMs === undefined || frames(stored.atMs) !== frames(point.atMs)) pending += 1;
  }
  pending += song.points.filter(point => !points.some(local => local.id === point.id)).length;
  return pending ? { state: 'editing', pending } : { state: 'ready', timecode: timecode.number, startMs, frameRate: '30' };
}
