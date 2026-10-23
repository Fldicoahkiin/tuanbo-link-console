import type { LinkProject, MtcFrameRate } from '@tb/schema';
import { ma2PendingChanges } from './ma2-pending-changes';
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
