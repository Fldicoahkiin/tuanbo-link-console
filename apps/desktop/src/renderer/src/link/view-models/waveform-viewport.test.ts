import { expect, it } from 'vitest';
import { waveformNormalization } from './waveform-viewport';

it('线性选择与原始排序百分位一致，包括静音、升降序和重复值', () => {
  for (const input of [[], [0], Array.from({ length: 500000 }, () => 0), Array.from({ length: 1001 }, (_, i) => i / 1001),
    Array.from({ length: 1001 }, (_, i) => (1000 - i) / 1001), Array.from({ length: 1001 }, (_, i) => ((i * 317) % 31) / 31)]) {
    expect(waveformNormalization(input)).toBe(Math.max(0.001, [...input].sort((a, b) => a - b)[Math.floor(input.length * 0.96)] ?? 1));
  }
});
