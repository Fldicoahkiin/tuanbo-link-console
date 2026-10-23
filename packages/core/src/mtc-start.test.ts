import { expect, it } from 'vitest';
import { nextMtcStartMs } from './mtc-start';

it('没有占用时从 60 秒开始；否则取最晚结束时间加 10 秒后的第一个整秒', () => {
  expect(nextMtcStartMs([], 30_000)).toBe(60_000);
  expect(nextMtcStartMs([{ startMs: 60_000, endMs: 90_000 }], 30_000)).toBe(100_000);
  expect(nextMtcStartMs([{ startMs: 60_000, endMs: 90_400 }, { startMs: 3_600_000, endMs: 3_700_000 }, { startMs: 100_000, endMs: 130_000 }], 30_000)).toBe(3_710_000);
});

it('超出上限或时长无效时报错，不截断', () => {
  expect(() => nextMtcStartMs([{ startMs: 0, endMs: 86_000_000 }], 600_000)).toThrow('超出 24 小时');
  expect(() => nextMtcStartMs([{ startMs: 0, endMs: 53_000_000 }], 1_000_000, 54_000_000)).toThrow('15 小时');
  expect(() => nextMtcStartMs([], 0)).toThrow('时长无效');
});
