import { expect, it } from 'vitest';
import { musicSegmentSpeed } from './music-segment-tempo';

it('fits known fractional tempos through 10 ms timestamp quantization and an isolated missed beat', () => {
  for (const bpm of [90, 114.5, 125, 127.5, 173.25]) {
    const beats = Array.from({ length: 80 }, (_, i) => Math.round((320 + i * 60000 / bpm) / 10) * 10).filter((_, i) => i !== 35);
    const result = musicSegmentSpeed(beats, 0, beats.at(-1)!, true);
    expect(result.bpm).not.toBeNull(); expect(Math.abs(result.bpm! - bpm)).toBeLessThan(.03); expect(result.endBpm).toBeNull();
  }
});
it('reports a local median estimate for irregular beats without borrowing the global tempo', () => {
  const beats = [0, 500, 1100, 1530, 2100, 2500, 3130, 3500];
  expect(musicSegmentSpeed(beats, 0, 4000, true).bpm).toBe(120);
  expect(musicSegmentSpeed([0, 500, 1000, 1500], 0, 2000, false).bpm).toBe(120);
  expect(musicSegmentSpeed(beats, 4000, 8000, true).bpm).toBeNull();
});
