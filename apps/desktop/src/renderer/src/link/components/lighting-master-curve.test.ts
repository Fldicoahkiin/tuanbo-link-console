import { describe, expect, it } from 'vitest';
import { LightingTempoMap } from '@tb/core/link';
import { createLightingDocument, type LightingClip, type LightingEvent } from '@tb/schema';
import { lightingMasterSegments } from './lighting-master-curve';

const map = new LightingTempoMap(createLightingDocument().tempos);
const point = (at: number, level: number, executor = '1.1'): LightingEvent => ({ id: `${executor}:${at}:${level}`, kind: 'ma2-fader', at, level, executor, fader: 'Master', label: '主推杆' });
const clip: LightingClip = { id: 'clip', name: '片段', start: 0, duration: 20000, timeLock: 'time', muted: false, events: [] };

describe('主时间线 Master 曲线', () => {
  it('原生采样 20% 到 80% 在两秒与五秒对应 32% 和 50%，裁切保留屏外邻点', () => {
    const segments = lightingMasterSegments(clip, [point(10000, .8), point(0, .2)], map, 10, 20, 50);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.x1).toBe(0); expect(segments[0]?.x2).toBe(30);
    expect(segments[0]?.y1).toBeCloseTo(48 - .32 * 32);
    expect(segments[0]?.y2).toBe(32);
  });
  it('执行器独立，不向首尾外推，也不连接同一时刻不明确的值', () => {
    expect(lightingMasterSegments(clip, [point(0, .2), point(1000, .8, '1.2')], map, 10, 0, 100)).toEqual([]);
    expect(lightingMasterSegments(clip, [point(0, .2), point(1000, .8)], map, 10, 20, 100)).toEqual([]);
    expect(lightingMasterSegments(clip, [point(0, .2), point(1000, .8), point(1000, .4), point(2000, .9)], map, 10, 0, 100)).toEqual([]);
  });
  it('片段位置与节拍锁定使用共同时间映射，读取不改变原数据', () => {
    const events = [point(0, 0), point(2, 1)];
    const original = structuredClone(events);
    const beatClip = { ...clip, start: 2, duration: 4, timeLock: 'beat' as const };
    const start = map.beatToMs(2) / 100;
    const end = map.beatToMs(4) / 100;
    expect(lightingMasterSegments(beatClip, events, map, 10, start, end)).toEqual([{ executor: '1.1', x1: 0, y1: 48, x2: end - start, y2: 16 }]);
    expect(events).toEqual(original);
  });
});
