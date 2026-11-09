import { describe, expect, it } from 'vitest';
import { markedOnAir, offAirParts, offAirTitle, onAirAt } from './timeline-air';

describe('时间线上标出不播出的部分', () => {
  it('中间被机位挡住的一段按片段长度的比例给出', () => {
    const parts = offAirParts({ startFrame: 100, endFrame: 200 }, [{ start: 100, end: 125 }, { start: 175, end: 400 }]);
    expect(parts).toEqual([{ from: 0.25, to: 0.75 }]);
    expect(offAirTitle(parts)).toBe('变暗的部分被上面的机位挡住，不会播出');
  });
  it('整段被挡住和完全不在画面里的片段分开处理', () => {
    expect(offAirParts({ startFrame: 0, endFrame: 30 }, [])).toEqual([{ from: 0, to: 1 }]);
    expect(offAirTitle([{ from: 0, to: 1 }])).toBe('整段被上面的机位挡住，不会播出');
    expect(offAirParts({ startFrame: 0, endFrame: 30 }, undefined)).toEqual([]);
    expect(offAirParts({ startFrame: 0, endFrame: 30 }, [{ start: 0, end: 30 }])).toEqual([]);
    expect(offAirTitle([])).toBeNull();
  });
  it('播放头所在帧在播的片段，结束帧不算', () => {
    const airtime = new Map([['media:a', [{ start: 0, end: 30 }]], ['cue:b', [{ start: 30, end: 60 }]], ['cue:c', []]]);
    expect([...onAirAt(airtime, 29)]).toEqual(['media:a']);
    expect([...onAirAt(airtime, 30)]).toEqual(['cue:b']);
  });
  it('标“正在播出”：按 OBS 在播的那一版，加上播放头处显示着的来源；播放中改过的部分不标；确认不了是哪一版时什么都不标', () => {
    const airtime = new Map([['media:a', [{ start: 0, end: 30 }]], ['cue:b', [{ start: 0, end: 60 }]]]);
    expect([...markedOnAir(airtime, new Set(), 10, ['caption'])].sort()).toEqual(['cue:b', 'cue:caption', 'media:a']);
    expect([...markedOnAir(airtime, new Set(['cue:b', 'cue:caption']), 10, ['caption'])]).toEqual(['media:a']);
    expect([...markedOnAir(null, new Set(), 10, ['caption'])]).toEqual([]);
  });
});
