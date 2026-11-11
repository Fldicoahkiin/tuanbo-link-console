import { endianness } from 'node:os';
import { z } from 'zod';
import type { LinkWaveform, LinkWaveformLevel, LinkWaveformSpectrum } from '@tb/schema';

/**
 * The one waveform of a song (E10, 0.5.9): the home player, the editor and the lighting workbench all draw it,
 * so the page never decodes a whole song. One pass over the PCM gives the finest min/max level, the same for
 * the 45–180 Hz band (the old lighting "节奏波形") and a log-frequency spectrum (the old "频谱"). Coarser levels
 * are merged from the finest one when it is read, four buckets at a time.
 */
export const WAVEFORM_SAMPLE_RATE = 48_000;
/** 2 ms, as the cache before it: one bucket per column at the timeline's closest zoom (480 px/s). */
const FINEST_SAMPLES_PER_BUCKET = 96;
const MAX_FINEST_BUCKETS = 500_000;
export const WAVEFORM_LEVEL_FACTOR = 4;
/** Coarser levels stop once a whole song fits in about this many buckets. */
const COARSEST_BUCKETS = 64;
/** As the old WaveSurfer spectrogram: 1024-sample Hann window, 40 Hz – 16 kHz on a log scale, gainDB 20, rangeDB 70. */
const SPECTRUM = { windowSamples: 1024, bands: 96, minHz: 40, maxHz: 16_000, floorDb: -90, rangeDb: 70 } as const;
/** 10 ms between spectrum frames, coarser for songs over 10 minutes so the cache stays small. */
const MIN_SPECTRUM_HOP = 480;
const MAX_SPECTRUM_FRAMES = 60_000;

export function waveformSamplesPerBucket(durationMs: number): number {
  return Math.max(FINEST_SAMPLES_PER_BUCKET, Math.ceil(Math.round(durationMs * WAVEFORM_SAMPLE_RATE / 1000) / MAX_FINEST_BUCKETS));
}
function spectrumHopSamples(durationMs: number): number {
  return Math.max(MIN_SPECTRUM_HOP, Math.ceil(Math.round(durationMs * WAVEFORM_SAMPLE_RATE / 1000) / MAX_SPECTRUM_FRAMES));
}

/** What one decode yields and what the cache file holds: only the finest level. */
export type WaveformBase = {
  samplesPerBucket: number; sampleCount: number; wave: Int16Array; rhythm: Int16Array;
  spectrum: LinkWaveformSpectrum;
};

const quantize = (value: number): number => Math.round(Math.max(-1, Math.min(1, value)) * 32767);

/** WebAudio's BiquadFilterNode (lowpass/highpass, Q in dB), so the rhythm band matches the old page filter. */
class Biquad {
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  private readonly b0: number; private readonly b1: number; private readonly b2: number; private readonly a1: number; private readonly a2: number;
  constructor(type: 'lowpass' | 'highpass', frequency: number, qDb: number) {
    const w0 = 2 * Math.PI * frequency / WAVEFORM_SAMPLE_RATE, cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * 10 ** (qDb / 20)), a0 = 1 + alpha;
    const edge = type === 'lowpass' ? (1 - cos) / 2 : (1 + cos) / 2;
    this.b0 = edge / a0; this.b1 = (type === 'lowpass' ? 1 - cos : -(1 + cos)) / a0; this.b2 = edge / a0;
    this.a1 = -2 * cos / a0; this.a2 = (1 - alpha) / a0;
  }
  next(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

class GrowingInt16 {
  private data = new Int16Array(4096); length = 0;
  push(a: number, b: number): void {
    if (this.length + 2 > this.data.length) { const next = new Int16Array(this.data.length * 2); next.set(this.data); this.data = next; }
    this.data[this.length++] = a; this.data[this.length++] = b;
  }
  done(): Int16Array { return this.data.slice(0, this.length); }
}

/** Radix-2 FFT magnitudes of one Hann-windowed frame, scaled as the old spectrogram (2 / N). */
class Spectrum {
  private readonly size = SPECTRUM.windowSamples;
  private readonly window = Float64Array.from({ length: this.size }, (_, n) => 0.5 * (1 - Math.cos(2 * Math.PI * n / (this.size - 1))));
  private readonly reverse = new Uint32Array(this.size);
  private readonly cos = new Float64Array(this.size / 2); private readonly sin = new Float64Array(this.size / 2);
  private readonly re = new Float64Array(this.size); private readonly im = new Float64Array(this.size);
  /** For each band, the FFT bin below its centre and the weight of the one above. */
  private readonly bins: Array<{ lo: number; weight: number }>;
  constructor() {
    const bits = Math.log2(this.size);
    for (let i = 0; i < this.size; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= (i >> b & 1) << (bits - 1 - b); this.reverse[i] = r; }
    for (let i = 0; i < this.size / 2; i++) { this.cos[i] = Math.cos(-2 * Math.PI * i / this.size); this.sin[i] = Math.sin(-2 * Math.PI * i / this.size); }
    this.bins = Array.from({ length: SPECTRUM.bands }, (_, band) => {
      const hz = SPECTRUM.minHz * (SPECTRUM.maxHz / SPECTRUM.minHz) ** (band / (SPECTRUM.bands - 1));
      const position = hz * this.size / WAVEFORM_SAMPLE_RATE, lo = Math.floor(position);
      return { lo, weight: position - lo };
    });
  }
  /** `ring` holds the last `size` samples, the oldest at `start`; `valid` of them are real, the rest silence. */
  frame(ring: Float64Array, start: number, valid: number, out: GrowingBytes): void {
    const { re, im, size } = this;
    for (let i = 0; i < size; i++) {
      const value = i < valid ? ring[(start + i) % size]! * this.window[i]! : 0;
      const j = this.reverse[i]!; re[j] = value; im[j] = 0;
    }
    for (let span = 2; span <= size; span *= 2) {
      const half = span / 2, step = size / span;
      for (let offset = 0; offset < size; offset += span) {
        for (let k = 0; k < half; k++) {
          const c = this.cos[k * step]!, s = this.sin[k * step]!, a = offset + k, b = a + half;
          const tr = re[b]! * c - im[b]! * s, ti = re[b]! * s + im[b]! * c;
          re[b] = re[a]! - tr; im[b] = im[a]! - ti; re[a] = re[a]! + tr; im[a] = im[a]! + ti;
        }
      }
    }
    const magnitude = (bin: number): number => 2 / size * Math.hypot(re[bin]!, im[bin]!);
    for (const { lo, weight } of this.bins) {
      const value = magnitude(lo) * (1 - weight) + magnitude(lo + 1) * weight;
      const db = 20 * Math.log10(Math.max(value, 1e-12));
      out.push(Math.max(0, Math.min(255, Math.round((db - SPECTRUM.floorDb) / SPECTRUM.rangeDb * 255))));
    }
  }
}

class GrowingBytes {
  private data = new Uint8Array(65536); length = 0;
  push(value: number): void {
    if (this.length + 1 > this.data.length) { const next = new Uint8Array(this.data.length * 2); next.set(this.data); this.data = next; }
    this.data[this.length++] = value;
  }
  done(): Uint8Array { return this.data.slice(0, this.length); }
}

/** Streaming f32le mono PCM at 48 kHz into a WaveformBase; keeps one window of samples, not the song. */
export class WaveformLevelsAccumulator {
  private readonly samplesPerBucket: number;
  private readonly hop: number;
  private remainder = Buffer.alloc(0);
  private sample = 0;
  private invalid = false;
  private readonly wave = new GrowingInt16(); private readonly rhythm = new GrowingInt16();
  private waveMin = Infinity; private waveMax = -Infinity; private rhythmMin = Infinity; private rhythmMax = -Infinity;
  private readonly highpass = new Biquad('highpass', 45, Math.SQRT1_2);
  private readonly lowpass = new Biquad('lowpass', 180, Math.SQRT1_2);
  private readonly spectrum = new Spectrum();
  private readonly ring = new Float64Array(SPECTRUM.windowSamples);
  private readonly frames = new GrowingBytes();
  private frameCount = 0;

  constructor(durationMs: number) {
    if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('波形采样范围无效');
    this.samplesPerBucket = waveformSamplesPerBucket(durationMs);
    this.hop = spectrumHopSamples(durationMs);
  }

  push(chunk: Buffer): void {
    const data = this.remainder.length ? Buffer.concat([this.remainder, chunk]) : chunk;
    const complete = data.length - data.length % 4;
    for (let offset = 0; offset < complete; offset += 4) this.add(data.readFloatLE(offset));
    this.remainder = Buffer.from(data.subarray(complete));
  }

  private add(raw: number): void {
    const value = Number.isFinite(raw) ? raw : 0;
    if (!Number.isFinite(raw)) this.invalid = true;
    const low = this.lowpass.next(this.highpass.next(value));
    if (value < this.waveMin) this.waveMin = value; if (value > this.waveMax) this.waveMax = value;
    if (low < this.rhythmMin) this.rhythmMin = low; if (low > this.rhythmMax) this.rhythmMax = low;
    this.ring[this.sample % SPECTRUM.windowSamples] = value;
    this.sample += 1;
    if (this.sample % this.samplesPerBucket === 0) this.closeBucket();
    // A frame starts every `hop` samples and is taken once its window is full.
    const start = this.sample - SPECTRUM.windowSamples;
    if (start >= 0 && start % this.hop === 0) this.takeFrame(start, SPECTRUM.windowSamples);
  }

  private closeBucket(): void {
    this.wave.push(quantize(this.waveMin), quantize(this.waveMax));
    this.rhythm.push(quantize(this.rhythmMin), quantize(this.rhythmMax));
    this.waveMin = this.rhythmMin = Infinity; this.waveMax = this.rhythmMax = -Infinity;
  }

  private takeFrame(start: number, valid: number): void {
    this.spectrum.frame(this.ring, start % SPECTRUM.windowSamples, valid, this.frames);
    this.frameCount += 1;
  }

  finish(): WaveformBase {
    if (this.remainder.length || this.invalid || !this.sample) throw new Error('波形解码未返回完整有效的音频采样');
    if (this.sample % this.samplesPerBucket !== 0) this.closeBucket();
    // Frames whose window runs past the end are padded with silence, as far as the last sample.
    for (let start = this.frameCount * this.hop; start < this.sample; start = this.frameCount * this.hop) {
      const valid = this.sample - start;
      if (valid >= SPECTRUM.windowSamples) throw new Error('波形频谱帧数不一致');
      this.takeFrame(start, valid);
    }
    return {
      samplesPerBucket: this.samplesPerBucket, sampleCount: this.sample, wave: this.wave.done(), rhythm: this.rhythm.done(),
      spectrum: { ...SPECTRUM, hopSamples: this.hop, frames: this.frameCount, data: this.frames.done() }
    };
  }
}

/** Four buckets of one level make one of the next. */
function mergeLevel(source: Int16Array): Int16Array {
  const buckets = source.length / 2, merged = Math.ceil(buckets / WAVEFORM_LEVEL_FACTOR), out = new Int16Array(merged * 2);
  for (let i = 0; i < merged; i++) {
    let min = 32767, max = -32767;
    for (let j = i * WAVEFORM_LEVEL_FACTOR, end = Math.min(buckets, j + WAVEFORM_LEVEL_FACTOR); j < end; j++) {
      const low = source[j * 2]!, high = source[j * 2 + 1]!;
      if (low < min) min = low; if (high > max) max = high;
    }
    out[i * 2] = min; out[i * 2 + 1] = max;
  }
  return out;
}

function pyramid(samplesPerBucket: number, wave: Int16Array, rhythm: Int16Array | null): LinkWaveformLevel[] {
  const levels: LinkWaveformLevel[] = [{ samplesPerBucket, wave, rhythm }];
  for (let level = levels[0]!; level.wave.length / 2 > COARSEST_BUCKETS; level = levels[levels.length - 1]!) {
    levels.push({ samplesPerBucket: level.samplesPerBucket * WAVEFORM_LEVEL_FACTOR, wave: mergeLevel(level.wave), rhythm: level.rhythm ? mergeLevel(level.rhythm) : null });
  }
  return levels;
}

export function waveformFromBase(base: WaveformBase): LinkWaveform {
  return { sampleRate: WAVEFORM_SAMPLE_RATE, sampleCount: base.sampleCount, levels: pyramid(base.samplesPerBucket, base.wave, base.rhythm), spectrum: base.spectrum };
}

/** A cache from 0.5.8 (a bare array of absolute peaks): shown as a waveform until it is generated again. */
export function waveformFromLegacyPeaks(peaks: readonly number[], durationMs: number): LinkWaveform {
  const sampleCount = Math.max(1, Math.round(durationMs * WAVEFORM_SAMPLE_RATE / 1000));
  const wave = new Int16Array(peaks.length * 2);
  peaks.forEach((peak, index) => { const value = quantize(Math.abs(peak)); wave[index * 2] = -value; wave[index * 2 + 1] = value; });
  return { sampleRate: WAVEFORM_SAMPLE_RATE, sampleCount, levels: pyramid(sampleCount / peaks.length, wave, null), spectrum: null };
}

/**
 * `<sha>.levels.bin`, beside the 0.5.8 cache `<sha>.json`, which stays as it was (0.5.8 is the rollback
 * installer and only reads `<sha>.json`). "TBWL", a uint32 header length, a JSON header, then the finest
 * level of the waveform and of the rhythm band (int16 little-endian) and the spectrum bytes. A file of
 * another format or for another length of song is not an error: it is generated again.
 */
const MAGIC = 'TBWL';
const WAVEFORM_FILE_FORMAT = 1;
const headerSchema = z.object({
  format: z.literal(WAVEFORM_FILE_FORMAT), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), sampleRate: z.literal(WAVEFORM_SAMPLE_RATE),
  samplesPerBucket: z.number().int().positive(), sampleCount: z.number().int().positive(), buckets: z.number().int().positive().max(2_000_000),
  spectrum: z.object({ hopSamples: z.number().int().positive(), windowSamples: z.literal(SPECTRUM.windowSamples), frames: z.number().int().positive().max(200_000),
    bands: z.literal(SPECTRUM.bands), minHz: z.literal(SPECTRUM.minHz), maxHz: z.literal(SPECTRUM.maxHz), floorDb: z.literal(SPECTRUM.floorDb), rangeDb: z.literal(SPECTRUM.rangeDb) }).strict()
}).strict();

function assertLittleEndian(): void {
  if (endianness() !== 'LE') throw new Error('波形缓存只支持小端字节序的电脑');
}

export function encodeWaveformFile(sourceSha256: string, base: WaveformBase): Buffer {
  assertLittleEndian();
  const { data, ...spectrum } = base.spectrum;
  const header = Buffer.from(JSON.stringify(headerSchema.parse({ format: WAVEFORM_FILE_FORMAT, sourceSha256, sampleRate: WAVEFORM_SAMPLE_RATE,
    samplesPerBucket: base.samplesPerBucket, sampleCount: base.sampleCount, buckets: base.wave.length / 2, spectrum })), 'utf8');
  // Padded so the int16 data starts on an even offset.
  const padding = (8 + header.length) % 2;
  return Buffer.concat([Buffer.from(MAGIC, 'latin1'), uint32(header.length), header, Buffer.alloc(padding),
    Buffer.from(base.wave.buffer, base.wave.byteOffset, base.wave.byteLength), Buffer.from(base.rhythm.buffer, base.rhythm.byteOffset, base.rhythm.byteLength), Buffer.from(data)]);
}

function uint32(value: number): Buffer { const buffer = Buffer.alloc(4); buffer.writeUInt32LE(value); return buffer; }

/** Null for a file of another format, another song or another length: the caller generates it again. */
export function decodeWaveformFile(bytes: Buffer, sourceSha256: string, durationMs: number): WaveformBase | null {
  assertLittleEndian();
  if (bytes.length < 8 || bytes.toString('latin1', 0, 4) !== MAGIC) return null;
  const headerLength = bytes.readUInt32LE(4);
  if (headerLength > 4096 || 8 + headerLength > bytes.length) return null;
  let value: unknown;
  // The header is text this app wrote; damaged text means the file is generated again.
  try { value = JSON.parse(bytes.toString('utf8', 8, 8 + headerLength)); } catch { return null; }
  const parsed = headerSchema.safeParse(value);
  if (!parsed.success) return null;
  const header = parsed.data;
  if (header.sourceSha256 !== sourceSha256 || header.samplesPerBucket !== waveformSamplesPerBucket(durationMs)) return null;
  if (header.buckets !== Math.ceil(header.sampleCount / header.samplesPerBucket) || header.spectrum.frames !== Math.ceil(header.sampleCount / header.spectrum.hopSamples)) return null;
  const start = 8 + headerLength + (8 + headerLength) % 2, levelBytes = header.buckets * 4, spectrumBytes = header.spectrum.frames * header.spectrum.bands;
  if (bytes.length !== start + levelBytes * 2 + spectrumBytes) return null;
  // Copied out so the arrays own aligned memory, whatever the Buffer's offset in its pool.
  const int16 = (offset: number): Int16Array => new Int16Array(new Uint8Array(bytes.subarray(offset, offset + levelBytes)).buffer);
  return {
    samplesPerBucket: header.samplesPerBucket, sampleCount: header.sampleCount, wave: int16(start), rhythm: int16(start + levelBytes),
    spectrum: { ...header.spectrum, data: new Uint8Array(bytes.subarray(start + levelBytes * 2)) }
  };
}
