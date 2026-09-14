import type { AudioBeatAnalysis } from '@tb/schema';
import { trackAudioBeats } from './audio-beat-tracking';

/** Streaming onset envelope. The analysis follows transients, not a guessed fixed BPM grid. */
export class AudioBeatDetector {
  private readonly energies: number[] = [];
  private sum = 0;
  private count = 0;
  private previous = 0;
  private low = 0;
  private lowSum = 0;

  constructor(private readonly sampleRate = 22050) {}

  push(sample: number): void {
    if (!Number.isFinite(sample)) throw new Error('音频包含无效采样');
    this.low += 0.04 * (sample - this.low);
    const high = sample - this.previous;
    this.sum += sample * sample + high * high * 0.5;
    this.lowSum += this.low * this.low;
    this.previous = sample;
    this.count += 1;
    if (this.count >= Math.round(this.sampleRate / 100)) {
      this.energies.push(Math.sqrt(this.sum / this.count) + Math.sqrt(this.lowSum / this.count));
      this.sum = 0; this.lowSum = 0; this.count = 0;
    }
  }

  finish(durationMs: number): AudioBeatAnalysis {
    const energies = this.energies;
    const hopMs = Math.round(this.sampleRate / 100) / this.sampleRate * 1000;
    const flux = energies.map((energy, index) => Math.max(0, energy - (energies[index - 1] ?? energy)));
    const peaks: Array<{ time: number; strength: number }> = [];
    for (let index = 2; index < flux.length - 2; index += 1) {
      const onset = flux[index]!;
      const energy = energies[index]!;
      if (energy < 0.003 || onset < Math.max(0.001, energy * 0.12) || onset < flux[index - 1]! || onset <= flux[index + 1]!) continue;
      const neighborhood = flux.slice(Math.max(0, index - 25), Math.min(flux.length, index + 26));
      const mean = neighborhood.reduce((sum, value) => sum + value, 0) / neighborhood.length;
      if (onset <= mean * 1.6) continue;
      const time = Math.round(index * hopMs);
      if (time > 0 && time < durationMs) peaks.push({ time, strength: onset });
    }
    return trackAudioBeats(selectPeaks(peaks, 70, 0));
  }
}

function selectPeaks(points: Array<{ time: number; strength: number }>, spacing: number, threshold: number) {
  const result: typeof points = [];
  for (const point of points) {
    if (point.strength < threshold) continue;
    const previous = result.at(-1);
    if (previous && point.time - previous.time < spacing) {
      if (point.strength > previous.strength) result[result.length - 1] = point;
    } else result.push(point);
  }
  return result;
}
