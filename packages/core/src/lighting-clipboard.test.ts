import { describe, expect, it } from 'vitest';
import { lightingClipSchema, type LightingClip, type LightingEvent } from '@tb/schema';
import { LightingTempoMap, lightingCurveValue, lightingEventTime } from './lighting-edit';
import { copyLightingEvents, pasteLightingEvents } from './lighting-clipboard';

const map = new LightingTempoMap([
  { beat: 0, bpm: 120, numerator: 4, denominator: 4 },
  { beat: 4, bpm: 60, numerator: 4, denominator: 4 },
  { beat: 8, bpm: 180, numerator: 3, denominator: 4 }
]);
const base: LightingClip = { id: 'source', name: '灯光', timeLock: 'time', start: 4000, duration: 10000, muted: false, events: [] };

describe('灯光事件剪贴板', () => {
  it('小数 BPM 和片段起点下粘贴首点不会产生负坐标', () => {
    const fractional = new LightingTempoMap([{ beat: 0, bpm: 127.3, numerator: 4, denominator: 4 }]);
    for (let index = 1; index < 100; index++) for (const timeLock of ['time', 'beat'] as const) {
      const target = { ...base, timeLock, start: index * 0.137, duration: 10 };
      const startMs = timeLock === 'time' ? target.start : fractional.beatToMs(target.start);
      for (const sourceLock of ['time', 'beat'] as const) {
        const result = pasteLightingEvents(target, { timeLock: sourceLock, events: [{ id: 'one', at: 0, kind: 'cc', controller: 7, value: 100 }] }, startMs, fractional);
        expect(result.clip.events[0]?.at).toBe(0);
        expect(lightingClipSchema.safeParse(result.clip).success).toBe(true);
      }
    }
  });
  it('复制独立快照，删除和修改源内容不影响粘贴，MA2 引用保持不变', () => {
    const source: LightingClip = { ...base, events: [
      { id: 'cue', at: 3000, kind: 'ma2', cue: '37.200', executor: '2.5', sequence: 23, label: '切换', action: 'goto' },
      { id: 'raw', at: 1000, kind: 'raw', bytes: [0xb0, 7, 100], label: '推杆' },
      { id: 'skip', at: 2000, kind: 'cc', controller: 7, value: 1 }
    ] };
    const copied = copyLightingEvents(source, new Set(['cue', 'raw']));
    expect(copied).not.toBeNull();
    const raw = source.events[1]; if (raw?.kind === 'raw') raw.bytes[2] = 0;
    source.events = [];
    const target = { ...base, id: 'target', start: 0, duration: 100, events: [] };
    const result = pasteLightingEvents(target, copied!, 1200, map);
    expect(result.clip.events).toMatchObject([
      { at: 3200, kind: 'ma2', cue: '37.200', executor: '2.5', sequence: 23, action: 'goto' },
      { at: 1200, kind: 'raw', bytes: [0xb0, 7, 100] }
    ]);
    expect(result.clip.duration).toBeGreaterThan(3200);
    expect(result.pastedIds.every((id) => !['cue', 'raw'].includes(id))).toBe(true);
    expect(new Set([...result.pastedIds, ...pasteLightingEvents(target, copied!, 1200, map).pastedIds]).size).toBe(4);
    expect(target.events).toHaveLength(0);
    expect(copyLightingEvents(source, new Set(['cue']))).toBeNull();
    expect(() => pasteLightingEvents(base, copied!, 3999, map)).toThrow('片段起点');
    expect(() => pasteLightingEvents(base, copied!, NaN, map)).toThrow('片段起点');
    expect(lightingClipSchema.parse(result.clip)).toEqual(result.clip);
  });

  for (const sourceLock of ['time', 'beat'] as const) for (const targetLock of ['time', 'beat'] as const) {
    it(`${sourceLock} → ${targetLock} 跨变速粘贴保留音符首尾和曲线的精确形状`, () => {
      const unit = sourceLock === 'time' ? 1000 : 1;
      const points: LightingEvent[] = [
        { id: 'a', kind: 'point', at: 0, value: 12, shape: 'smooth', controlValues: [100, 30] },
        { id: 'b', kind: 'point', at: 8 * unit, value: 120, shape: 'hold' }
      ];
      const source: LightingClip = { ...base, timeLock: sourceLock, start: 0, duration: 8 * unit, events: [...points, { id: 'note', kind: 'note', at: unit, duration: 6 * unit, note: 64, velocity: 101 }] };
      const clipboard = copyLightingEvents(source, new Set(source.events.map((event) => event.id)))!;
      const target: LightingClip = { ...base, id: 'target', timeLock: targetLock, start: targetLock === 'time' ? 500 : 1, duration: 1 };
      const result = pasteLightingEvents(target, clipboard, 1000, map);
      const sourceToMs = (at: number): number => sourceLock === 'time' ? 1000 + at : map.beatToMs(2 + at);
      const note = result.clip.events.find((event) => event.kind === 'note');
      if (!note || note.kind !== 'note') throw new Error('音符未粘贴');
      expect(lightingEventTime(result.clip, note, map)).toBeCloseTo(sourceToMs(unit), 8);
      expect(lightingEventTime(result.clip, { ...note, at: note.at + note.duration }, map)).toBeCloseTo(sourceToMs(7 * unit), 8);
      const converted = result.clip.events.filter((event) => event.kind === 'point').sort((a, b) => a.at - b.at);
      expect(converted).toHaveLength(sourceLock === targetLock ? 2 : 4);
      const first = points[0]; const last = points[1];
      if (first?.kind !== 'point' || last?.kind !== 'point') throw new Error('曲线测试数据无效');
      for (let index = 0; index < 400; index++) {
        const fraction = index / 400;
        const ms = sourceToMs(fraction * 8 * unit);
        const at = (targetLock === 'time' ? ms : map.msToBeat(ms)) - target.start;
        const from = converted.filter((point) => point.at <= at).at(-1)!;
        const to = converted.find((point) => point.at > at)!;
        expect(lightingCurveValue(from, to, (at - from.at) / (to.at - from.at))).toBeCloseTo(lightingCurveValue(first, last, fraction), 9);
      }
      expect(lightingClipSchema.parse(JSON.parse(JSON.stringify(result.clip)))).toEqual(result.clip);
    });
  }

  it.each(['hold', 'linear'] as const)('%s 曲线跨变速转换不会引入错误平滑', (shape) => {
    const source: LightingClip = { ...base, start: 0, duration: 8000, events: [{ id: 'a', kind: 'point', at: 0, value: 20, shape }, { id: 'b', kind: 'point', at: 8000, value: 100, shape: 'hold' }] };
    const copied = copyLightingEvents(source, new Set(['a', 'b']))!;
    const result = pasteLightingEvents({ ...base, start: 0, timeLock: 'beat' }, copied, 1000, map);
    const points = result.clip.events.filter((event) => event.kind === 'point');
    expect(points.slice(0, -1).every((point) => point.shape === shape)).toBe(true);
    expect(points[1]?.value).toBe(shape === 'hold' ? 20 : 30);
    expect(points[2]?.value).toBe(shape === 'hold' ? 20 : 70);
  });
});
