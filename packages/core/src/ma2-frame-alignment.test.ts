import { describe, expect, it } from 'vitest';
import { alignMa2SnapshotToFrames } from './ma2-frame-alignment';
import type { Ma2SyncSnapshot } from '@tb/schema';

function snapshot(times: number[]): Ma2SyncSnapshot {
  return { bindingId: 'binding', consoleVersion: '3.3.4', revision: 'read', objects: [
    { id: 'tc', kind: 'timecode', parentId: null, order: 0, properties: {} },
    ...times.map((time, index) => ({ id: `e${index}`, kind: 'event' as const, parentId: 'tc', order: 0, properties: { time: String(time), cue: '1.25' } }))
  ] };
}
describe('MA2 帧对齐预览', () => {
  it('非整帧歌曲起点仍对齐原生时间网格，零点不向负时间取整', () => {
    const result = alignMa2SnapshotToFrames(snapshot([0, 1000]), 30, 125);
    const positions = result.snapshot.objects.filter(entry => entry.kind === 'event').map(entry => Number(entry.properties.time));
    for (const position of positions) expect((position + 125) * 30 / 1000).toBeCloseTo(Math.round((position + 125) * 30 / 1000));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(alignMa2SnapshotToFrames(result.snapshot, 30, 125).adjustments).toEqual([]);
  });
  it('按最近帧生成明确偏移，重复应用不累计误差且不改原数据', () => {
    const original = snapshot([0, 1, 517, 1500, 1501, 86399999]);
    const result = alignMa2SnapshotToFrames(original, 30);
    expect(result.adjustments.map((entry) => entry.id)).toEqual(['e1', 'e2', 'e4', 'e5']);
    expect(result.adjustments[1]).toEqual({ id: 'e2', fromMs: 517, toMs: 16000 / 30 });
    expect(result.adjustments.every((entry) => Math.abs(entry.toMs - entry.fromMs) <= 1000 / 60)).toBe(true);
    expect(alignMa2SnapshotToFrames(result.snapshot, 30).adjustments).toEqual([]);
    expect(original.objects[3]?.properties.time).toBe('517');
  });
  it('非法时间和帧率不能产生有效同步预览', () => {
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, 86400001]) expect(() => alignMa2SnapshotToFrames(snapshot([value]), 30)).toThrow();
    expect(() => alignMa2SnapshotToFrames(snapshot([1]), 0)).toThrow('帧率');
  });
});
