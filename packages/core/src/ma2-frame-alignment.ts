import { ma2SyncSnapshotSchema, type Ma2SyncSnapshot } from '@tb/schema';

/** MA2 Timecode XML stores integer ticks; expose rounding before the operator applies it. */
export function alignMa2SnapshotToFrames(input: Ma2SyncSnapshot, framesPerSecond: number): {
  snapshot: Ma2SyncSnapshot; adjustments: Array<{ id: string; fromMs: number; toMs: number }>;
} {
  if (!Number.isInteger(framesPerSecond) || framesPerSecond < 1 || framesPerSecond > 120) throw new Error('MA2 帧率无效');
  const snapshot = ma2SyncSnapshotSchema.parse(input);
  const adjustments: Array<{ id: string; fromMs: number; toMs: number }> = [];
  for (const event of snapshot.objects) {
    if (event.kind !== 'event') continue;
    const raw = event.properties.time;
    if (!raw || !/^\d+(?:\.\d+)?$/.test(raw)) throw new Error('灯光点时间无效');
    const fromMs = Number(raw);
    if (!Number.isFinite(fromMs) || fromMs < 0 || fromMs > 86400000) throw new Error('灯光点时间超出范围');
    const toMs = Math.round(fromMs * framesPerSecond / 1000) * 1000 / framesPerSecond;
    if (Math.abs(toMs - fromMs) > 1e-6) adjustments.push({ id: event.id, fromMs, toMs });
    event.properties.time = String(toMs);
  }
  return { snapshot, adjustments };
}
