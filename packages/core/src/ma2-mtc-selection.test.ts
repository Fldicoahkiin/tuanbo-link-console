import { expect, it } from 'vitest';
import { ma2MtcSelectionCommand, ma2MtcSelections } from './ma2-mtc-selection';

it('歌曲内、空白和前后跳转都由绝对 MTC 位置选择唯一歌曲', () => {
  const points = ma2MtcSelections([{ timecode: 3, start: 36000, end: 37137 }, { timecode: 100, start: 18000, end: 19137 }]);
  const at = (time: number) => points.filter(point => point.at <= time).at(-1)?.timecode;
  for (const [time, song] of [[0, null], [36016, 3], [18600, 100], [20000, null], [36000, 3], [37137, null], [18000, 100]] as const) expect(at(time)).toBe(song);
});

it('首曲从零开始、相邻曲目接缝归下一首，不插入同帧关灯', () => {
  expect(ma2MtcSelections([{ timecode: 2, start: 300, end: 600 }, { timecode: 1, start: 0, end: 300 }]))
    .toEqual([{ at: 0, timecode: 1 }, { at: 300, timecode: 2 }, { at: 600, timecode: null }]);
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
