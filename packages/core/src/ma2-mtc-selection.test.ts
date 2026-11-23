import { expect, it } from 'vitest';
import { ma2EditedCueHold, ma2MtcSelectionCommand, ma2MtcSelections } from './ma2-mtc-selection';

it('歌曲内、空白和前后跳转都由绝对 MTC 位置选择唯一歌曲', () => {
  const points = ma2MtcSelections([{ timecode: 3, start: 36000, end: 37137 }, { timecode: 100, start: 18000, end: 19137 }]);
  const at = (time: number) => points.filter(point => point.at <= time).at(-1)?.timecode;
  for (const [time, song] of [[0, null], [36016, 3], [18600, 100], [20000, null], [36000, 3], [37137, null], [18000, 100]] as const) expect(at(time)).toBe(song);
});

it('新增的最后一个 Cue 持续到歌尾，同槽相邻起点和午夜限制其长度', () => {
  const current = { target: 3, offset: '36000', length: '30', last: '24', slot: 'TC Slot 2', name: '当前节目', frame: '30 FPS' };
  const next = { ...current, target: 4, offset: '36135' };
  const hold = (entries: typeof current[], tick = 109) => ma2EditedCueHold([current, ...entries], 3, 36000, tick, 37137);
  expect(hold([])).toBe(1137);
  expect(() => hold([next])).toThrow('Timecode 3 和 4');
  expect(() => hold([{ ...next, offset: '37137' }])).toThrow('间隔不足 1 秒');
  expect(hold([{ ...next, offset: '37167' }])).toBe(1137);
  expect(hold([{ ...next, last: '' }, { ...next, target: 5, slot: 'TC Slot 1' }])).toBe(1137);
  expect(() => hold([next], 135)).toThrow('Timecode 3 和 4');
  expect(() => hold([{ ...next, offset: '35990' }])).toThrow('重叠');
  expect(() => ma2EditedCueHold([{ ...current, offset: '2591800' }], 3, 2591800, 109, 2593000)).toThrow('午夜');
  expect(() => ma2EditedCueHold([], 3, 36000, 109, 37137)).toThrow('重新核对');
});

it('按接收槽的续跑时间保留空档，首曲可从零开始，空档内只关灯', () => {
  const points = (gap: number, roll: number) => ma2MtcSelections([{ timecode: 2, start: 300 + gap, end: 700 }, { timecode: 1, start: 0, end: 300 }], roll);
  for (const [roll, required] of [[0.5, 30], [1, 60], [2, 90]] as const) {
    expect(() => points(0, roll)).toThrow('间隔不足');
    expect(() => points(required - 1, roll)).toThrow(`间隔不足 ${required / 30} 秒`);
    expect(points(required, roll)).toEqual([{ at: 0, timecode: 1 }, { at: 300, timecode: null }, { at: 300 + required, timecode: 2 }, { at: 700, timecode: null }]);
  }
});

it('先关闭其他时间线再开启当前曲，控制清单内对象，不发全局 Off 或逐条灯光 Cue', () => {
  expect(ma2MtcSelectionCommand([100, 3, 2], 3)).toBe('Off Timecode 2 + 100; Go Timecode 3');
  expect(ma2MtcSelectionCommand([3, 2], null)).toBe('Off Timecode 2 + 3');
  expect(ma2MtcSelectionCommand([3], 3)).toBe('Go Timecode 3');
});

it('重叠、重复编号、跨日和非法编号明确拒绝', () => {
  expect(() => ma2MtcSelections([{ timecode: 1, start: 0, end: 301 }, { timecode: 2, start: 300, end: 600 }])).toThrow('重叠');
  expect(() => ma2MtcSelections([{ timecode: 1, start: 0, end: 300 }, { timecode: 1, start: 400, end: 600 }])).toThrow('无效');
  expect(() => ma2MtcSelections([{ timecode: 1, start: 0, end: 2592000 }])).toThrow('无效');
  expect(() => ma2MtcSelectionCommand([1], 2)).toThrow('无效');
  expect(() => ma2MtcSelectionCommand([1, 1], 1)).toThrow('无效');
});
