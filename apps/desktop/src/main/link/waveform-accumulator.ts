export const waveformBucketCount = (durationMs: number): number => Math.min(500_000, Math.max(4800, Math.ceil(durationMs / 2)));

/** Streaming PCM reduction: retain only one incomplete float and the output peaks. */
export class WaveformAccumulator {
  readonly peaks: number[];
  private remainder = Buffer.alloc(0);
  private sample = 0;
  private bucket = 0;
  private invalid = false;

  constructor(private readonly sampleCount: number, buckets = 2400) {
    if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0 || !Number.isSafeInteger(buckets) || buckets <= 0) throw new Error('波形采样范围无效');
    this.peaks = Array.from({ length: buckets }, () => 0);
  }

  push(chunk: Buffer): void {
    const data = this.remainder.length ? Buffer.concat([this.remainder, chunk]) : chunk;
    const complete = data.length - data.length % 4;
    for (let offset = 0; offset < complete; offset += 4) {
      const value = data.readFloatLE(offset);
      while (this.bucket < this.peaks.length - 1 && this.sample >= Math.floor((this.bucket + 1) * this.sampleCount / this.peaks.length)) this.bucket += 1;
      if (!Number.isFinite(value)) this.invalid = true;
      else this.peaks[this.bucket] = Math.max(this.peaks[this.bucket]!, Math.min(1, Math.abs(value)));
      this.sample += 1;
    }
    this.remainder = Buffer.from(data.subarray(complete));
  }

  finish(): number[] {
    if (this.remainder.length || this.invalid || !this.sample) throw new Error('波形解码未返回完整有效的音频采样');
    return this.peaks;
  }
}

