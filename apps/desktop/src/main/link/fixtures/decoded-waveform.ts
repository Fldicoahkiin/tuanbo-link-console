import type { LinkWaveform } from '@tb/schema';
import { waveformBucketCount } from '../waveform-accumulator';
import { WaveformLevelsAccumulator } from '../waveform-levels';
import type { DecodedWaveform } from '../waveform-service';

/** 48 kHz mono f32le, as FFmpeg hands it to the worker. */
export function pcm(durationMs: number, sample: (index: number) => number): Buffer {
  const count = Math.round(durationMs * 48), bytes = Buffer.alloc(count * 4);
  for (let index = 0; index < count; index += 1) bytes.writeFloatLE(sample(index), index * 4);
  return bytes;
}

/** What the worker returns for a song of `durationMs` whose every sample is `level`. */
export function decodedWaveform(durationMs: number, level: number): DecodedWaveform {
  const levels = new WaveformLevelsAccumulator(durationMs);
  levels.push(pcm(durationMs, () => level));
  return { peaks: Array.from({ length: waveformBucketCount(durationMs) }, () => Math.abs(level)), base: levels.finish() };
}

/** The loudest point of the finest level, in full scale: enough to tell two waveforms apart in a test. */
export function loudest(waveform: LinkWaveform): number {
  let high = 0;
  for (const value of waveform.levels[0]!.wave) high = Math.max(high, Math.abs(value));
  return high / 32767;
}
