import { expect, it } from 'vitest';
import { waveformColumns, waveformNormalization } from './waveform-viewport';

it('像素合并保留单样本尖峰、尾部和当前视口之外的隔离', () => {
  expect([...waveformColumns([1, 0.1, 0.8, 0.4, 0.2, 0.9], 1, 6, 2)]).toEqual([0.8, 0.9]);
  const peaks = Array.from({ length: 500000 }, () => 0); peaks[123456] = 0.75; peaks[499999] = 1;
  const visible = waveformColumns(peaks, 0, peaks.length, 1000);
  expect(visible[246]).toBe(0.75); expect(visible[999]).toBe(1); expect(visible.length).toBe(1000);
});
it('线性选择与原始排序百分位一致，包括静音、升降序和重复值', () => {
  for (const input of [[], [0], Array.from({ length: 500000 }, () => 0), Array.from({ length: 1001 }, (_, i) => i / 1001),
    Array.from({ length: 1001 }, (_, i) => (1000 - i) / 1001), Array.from({ length: 1001 }, (_, i) => ((i * 317) % 31) / 31)]) {
    expect(waveformNormalization(input)).toBe(Math.max(0.001, [...input].sort((a, b) => a - b)[Math.floor(input.length * 0.96)] ?? 1));
  }
});
