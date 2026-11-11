import { expect, it } from 'vitest';
import type { LinkWaveform, LinkWaveformLevel } from '@tb/schema';
import { waveformColumnRange, waveformDisplay, waveformDisplayReady, waveformLevelFor, waveformScale } from './waveform-draw';

/** Levels as the main process merges them: four buckets of 96 samples make one of the next. */
function waveform(finest: number[], rhythm = true): LinkWaveform {
  const levels: LinkWaveformLevel[] = [];
  let peaks = finest, samplesPerBucket = 96;
  for (;;) {
    const wave = Int16Array.from(peaks.flatMap(peak => [-Math.round(peak * 32767), Math.round(peak * 32767)]));
    levels.push({ samplesPerBucket, wave, rhythm: rhythm ? wave.map(value => value / 2) : null });
    if (peaks.length <= 64) break;
    peaks = Array.from({ length: Math.ceil(peaks.length / 4) }, (_, index) => Math.max(...peaks.slice(index * 4, index * 4 + 4)));
    samplesPerBucket *= 4;
  }
  return { sampleRate: 48_000, sampleCount: finest.length * 96, levels, spectrum: null };
}

it('每一列都算上它盖到的所有桶：单个尖峰和最后一个桶都不丢，缩放到哪一级都一样', () => {
  const peaks = Array.from({ length: 120_000 }, () => 0); peaks[61_728] = 0.75; peaks[119_999] = 1;
  const song = waveform(peaks), total = song.sampleCount;
  for (const columns of [300, 1000, 1999, 12_000]) {
    const range = waveformColumnRange(song, 'wave', { startSample: 0, endSample: total, columns });
    expect(range.length).toBe(columns * 2);
    const spike = Math.floor(61_728 * 96 / (total / columns));
    expect(range[spike * 2 + 1]).toBeCloseTo(0.75, 4); expect(range[spike * 2]).toBeCloseTo(-0.75, 4);
    expect(range[(columns - 1) * 2 + 1]).toBeCloseTo(1, 4);
    // Only the column under the spike lights up, or its neighbour too when the bucket straddles their edge.
    const lit = Array.from({ length: columns - 1 }, (_, column) => column).filter(column => range[column * 2 + 1]! > 0);
    expect(lit).toContain(spike); expect(lit.length).toBeLessThanOrEqual(2); expect(lit[lit.length - 1]! - lit[0]!).toBe(lit.length - 1);
  }
});

it('选能给每列至少一个桶的最粗那一级；放大过了最细一级就用最细的', () => {
  const song = waveform(Array.from({ length: 120_000 }, () => 0.1));
  expect(waveformLevelFor(song, 10).samplesPerBucket).toBe(96);
  expect(waveformLevelFor(song, 96 * 4).samplesPerBucket).toBe(384);
  expect(waveformLevelFor(song, 96 * 4 * 4 * 3).samplesPerBucket).toBe(96 * 16);
  // Zoomed in past 2 ms a column: each column still reads a bucket, never an empty one.
  const range = waveformColumnRange(song, 'wave', { startSample: 9600, endSample: 9696, columns: 8 });
  expect([...range].every((value, index) => Math.abs(value - (index % 2 ? 0.1 : -0.1)) < 1e-4)).toBe(true);
});

it('音源之外的列不画；节奏波形用自己那一路，旧缓存没有节奏波形和频谱时说出来', () => {
  const song = waveform(Array.from({ length: 1000 }, () => 0.4));
  const range = waveformColumnRange(song, 'wave', { startSample: -song.sampleCount, endSample: song.sampleCount * 2, columns: 3 });
  expect(range[0]! > range[1]!).toBe(true); expect(range[4]! > range[5]!).toBe(true); expect(range[3]).toBeCloseTo(0.4, 4);
  expect(waveformColumnRange(song, 'rhythm', { startSample: 0, endSample: song.sampleCount, columns: 4 })[1]).toBeCloseTo(0.2, 3);
  expect(waveformScale(song, 'wave')).toBeCloseTo(0.4, 3); expect(waveformScale(song, 'rhythm')).toBeCloseTo(0.2, 3);
  const older = waveform(Array.from({ length: 1000 }, () => 0.4), false);
  expect(waveformDisplayReady(older, 'waveform')).toBe(true);
  expect(waveformDisplayReady(older, 'rhythm')).toBe(false); expect(waveformDisplayReady(older, 'spectrum')).toBe(false);
  expect(waveformDisplayReady(song, 'rhythm')).toBe(true);
  expect(['rhythm', 'spectrum', 'waveform', 'other'].map(waveformDisplay)).toEqual(['rhythm', 'spectrum', 'waveform', 'waveform']);
});
