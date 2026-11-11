import { afterEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { LinkWaveform, LinkWaveformResult } from '@tb/schema';
import { decodeWaveform, WaveformAccumulator, WaveformService, waveformSourceMatches, type DecodedWaveform } from './waveform-service';
import { decodeWaveformFile, encodeWaveformFile, WAVEFORM_LEVEL_FACTOR, waveformFromBase, WaveformLevelsAccumulator, type WaveformBase } from './waveform-levels';
import { decodedWaveform, loudest, pcm } from './fixtures/decoded-waveform';
import type { WaveformCacheEntry } from './link-project-service';

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) {
    for (const name of await readdir(path)) await unlink(join(path, name));
    await rmdir(path);
  }
});

/** An in-memory project cache: `<sha>.json` entries and `<sha>.levels.bin` bytes. */
function memoryCache(json: WaveformCacheEntry | null = null) {
  const store = { json, levels: null as Buffer | null };
  return {
    store,
    loadWaveformCache: vi.fn(() => Promise.resolve(store.json)),
    saveWaveformCache: vi.fn((_project: string, _sha: string, peaks: number[], sourceVerified: boolean) => { store.json = { peaks, sourceVerified }; return Promise.resolve(); }),
    loadWaveformLevels: vi.fn(() => Promise.resolve(store.levels)),
    saveWaveformLevels: vi.fn((_project: string, _sha: string, bytes: Uint8Array) => { store.levels = Buffer.from(bytes); return Promise.resolve(); })
  };
}
const SONG = 'c'.repeat(64), ONE = '1'.repeat(64), TWO = '2'.repeat(64);
const stateOf = (result: LinkWaveformResult): [string, number] => [result.state, Number(loudest(result.waveform).toFixed(3))];

function base(durationMs: number, sample: (index: number) => number): WaveformBase {
  const levels = new WaveformLevelsAccumulator(durationMs); levels.push(pcm(durationMs, sample)); return levels.finish();
}
/** Highest absolute value of a band over [fromMs, toMs) of the finest level, in full scale. */
function bandPeak(waveform: LinkWaveform, band: 'wave' | 'rhythm', fromMs: number, toMs: number): number {
  const level = waveform.levels[0]!, data = level[band]!, perMs = waveform.sampleRate / 1000 / level.samplesPerBucket;
  let high = 0;
  for (let index = Math.floor(fromMs * perMs); index < Math.min(data.length / 2, Math.ceil(toMs * perMs)); index++) high = Math.max(high, Math.abs(data[index * 2]!), Math.abs(data[index * 2 + 1]!));
  return high / 32767;
}

test('arbitrary PCM byte boundaries preserve every peak including the last sample', () => {
  const pcmBytes = Buffer.alloc(20);
  [0, -0.7, 0.2, 0, 1].forEach((value, index) => pcmBytes.writeFloatLE(value, index * 4));
  for (const size of [1, 3, 7, 20]) {
    const accumulator = new WaveformAccumulator(5, 2);
    for (let index = 0; index < pcmBytes.length; index += size) accumulator.push(pcmBytes.subarray(index, index + size));
    expect(accumulator.finish()[0]).toBeCloseTo(0.7);
    expect(accumulator.finish()[1]).toBe(1);
  }
});

test('invalid or truncated PCM cannot become a successful cache', () => {
  const partial = new WaveformAccumulator(1); partial.push(Buffer.from([0]));
  expect(() => partial.finish()).toThrow('完整有效');
  const nonFinite = new WaveformAccumulator(1); const bytes = Buffer.alloc(4); bytes.writeFloatLE(NaN);
  nonFinite.push(bytes); expect(() => nonFinite.finish()).toThrow('完整有效');
  expect(() => new WaveformAccumulator(0)).toThrow('采样范围');
  const levels = new WaveformLevelsAccumulator(1000); levels.push(Buffer.from([0]));
  expect(() => levels.finish()).toThrow('完整有效');
  const nanLevels = new WaveformLevelsAccumulator(1000); nanLevels.push(bytes); expect(() => nanLevels.finish()).toThrow('完整有效');
});

describe('多级峰值（E10）', () => {
  test('every level is the min and max of four buckets of the level below it, down to the samples', () => {
    let seed = 7; const noise = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x3fffffff - 1; };
    const durationMs = 12_345, samples = pcm(durationMs, index => 0.6 * noise() * Math.sin(index / 3000));
    const accumulator = new WaveformLevelsAccumulator(durationMs);
    // Split at odd byte counts: the result must not depend on where FFmpeg's chunks end.
    for (let offset = 0; offset < samples.length; offset += 4093) accumulator.push(samples.subarray(offset, offset + 4093));
    const waveform = waveformFromBase(accumulator.finish());
    expect(waveform.levels.length).toBeGreaterThan(3);
    expect(waveform.sampleCount).toBe(Math.round(durationMs * 48));
    const finest = waveform.levels[0]!;
    for (let bucket = 0; bucket < finest.wave.length / 2; bucket++) {
      let min = Infinity, max = -Infinity;
      for (let index = bucket * finest.samplesPerBucket; index < Math.min(waveform.sampleCount, (bucket + 1) * finest.samplesPerBucket); index++) {
        const value = samples.readFloatLE(index * 4); min = Math.min(min, value); max = Math.max(max, value);
      }
      expect(finest.wave[bucket * 2]).toBe(Math.round(min * 32767)); expect(finest.wave[bucket * 2 + 1]).toBe(Math.round(max * 32767));
    }
    for (let level = 1; level < waveform.levels.length; level++) {
      const below = waveform.levels[level - 1]!, current = waveform.levels[level]!;
      expect(current.samplesPerBucket).toBe(below.samplesPerBucket * WAVEFORM_LEVEL_FACTOR);
      expect(current.wave.length / 2).toBe(Math.ceil(below.wave.length / 2 / WAVEFORM_LEVEL_FACTOR));
      for (const band of ['wave', 'rhythm'] as const) {
        const low = below[band]!, high = current[band]!;
        for (let bucket = 0; bucket < high.length / 2; bucket++) {
          const children = Array.from({ length: WAVEFORM_LEVEL_FACTOR }, (_, child) => bucket * WAVEFORM_LEVEL_FACTOR + child).filter(child => child < low.length / 2);
          expect(high[bucket * 2]).toBe(Math.min(...children.map(child => low[child * 2]!)));
          expect(high[bucket * 2 + 1]).toBe(Math.max(...children.map(child => low[child * 2 + 1]!)));
        }
      }
    }
    // The coarsest level holds a whole song in a few dozen buckets.
    expect(waveform.levels[waveform.levels.length - 1]!.wave.length / 2).toBeLessThanOrEqual(64);
  });

  test('the rhythm band follows a 60 Hz kick and ignores a 2 kHz lead', () => {
    const tone = (hz: number): LinkWaveform => waveformFromBase(base(2000, index => 0.5 * Math.sin(2 * Math.PI * hz * index / 48_000)));
    const kick = tone(60), lead = tone(2000);
    // Past the filters' first few milliseconds.
    expect(bandPeak(kick, 'wave', 200, 2000)).toBeCloseTo(0.5, 2); expect(bandPeak(lead, 'wave', 200, 2000)).toBeCloseTo(0.5, 2);
    expect(bandPeak(kick, 'rhythm', 200, 2000)).toBeGreaterThan(0.3);
    expect(bandPeak(lead, 'rhythm', 200, 2000)).toBeLessThan(0.01);
  });

  test('the spectrum puts a tone in its band and a gap where it is silent', () => {
    const waveform = waveformFromBase(base(1000, index => index < 24_000 ? 0.5 * Math.sin(2 * Math.PI * 1000 * index / 48_000) : 0));
    const spectrum = waveform.spectrum!;
    expect(spectrum.frames).toBe(Math.ceil(48_000 / spectrum.hopSamples));
    const band = Math.round(Math.log(1000 / spectrum.minHz) / Math.log(spectrum.maxHz / spectrum.minHz) * (spectrum.bands - 1));
    const frame = (index: number): Uint8Array => spectrum.data.subarray(index * spectrum.bands, (index + 1) * spectrum.bands);
    const loud = frame(20);
    expect(loud.indexOf(Math.max(...loud))).toBeGreaterThanOrEqual(band - 1); expect(loud.indexOf(Math.max(...loud))).toBeLessThanOrEqual(band + 1);
    expect(Math.max(...frame(spectrum.frames - 10))).toBe(0);
  });

  test('the levels file reads back as written and anything else is generated again, not an error', () => {
    const written = base(3000, index => Math.sin(index / 100) * 0.3), bytes = encodeWaveformFile(SONG, written);
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('TBWL');
    const read = decodeWaveformFile(bytes, SONG, 3000)!;
    expect(read.sampleCount).toBe(written.sampleCount);
    expect([...read.wave]).toEqual([...written.wave]); expect([...read.rhythm]).toEqual([...written.rhythm]); expect([...read.spectrum.data]).toEqual([...written.spectrum.data]);
    expect(decodeWaveformFile(bytes, 'e'.repeat(64), 3000)).toBeNull();
    // Another length of song needs other buckets only past 500,000 of them (over 16 minutes).
    expect(decodeWaveformFile(bytes, SONG, 30 * 60_000)).toBeNull();
    expect(decodeWaveformFile(bytes.subarray(0, bytes.length - 1), SONG, 3000)).toBeNull();
    expect(decodeWaveformFile(Buffer.from('[0.1,0.2]\n'), SONG, 3000)).toBeNull();
    const otherFormat = Buffer.from(bytes); otherFormat.write('{"format":2', 8, 'utf8');
    expect(decodeWaveformFile(otherFormat, SONG, 3000)).toBeNull();
  });
});

test('concurrent requests share work, independent jobs serialize and failures never write cache', async () => {
  const cache = memoryCache();
  let fail: (error: Error) => void = () => { throw new Error('decoder not started'); };
  const decode = vi.fn().mockImplementationOnce(() => new Promise<DecodedWaveform>((_resolve, reject) => { fail = reject; })).mockResolvedValue(decodedWaveform(1000, 0.5));
  const service = new WaveformService(cache, decode, () => Promise.resolve(true));
  const first = service.ensure('show.tblink', 'one.wav', ONE, 1000, true);
  const failed = expect(first).rejects.toThrow('invalid audio');
  expect(service.ensure('show.tblink', 'one.wav', ONE, 1000, true)).toBe(first);
  const second = service.ensure('show.tblink', 'two.wav', TWO, 1000, true);
  await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(1));
  fail(new Error('invalid audio')); await failed;
  expect(stateOf(await second)).toEqual(['verified', 0.5]);
  expect(cache.saveWaveformCache).toHaveBeenCalledExactlyOnceWith('show.tblink', TWO, expect.any(Array), true);
  expect(cache.saveWaveformLevels).toHaveBeenCalledTimes(1);
  expect(decodeWaveformFile(cache.store.levels!, TWO, 1000)).not.toBeNull();
});

test('real FFmpeg streams the first channel and reports invalid media', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-waveform-')); directories.push(directory);
  const worker = join(directory, 'waveform-worker.cjs');
  await build({ entryPoints: [fileURLToPath(new URL('./waveform-worker.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', outfile: worker });
  const path = join(directory, 'stereo.wav');
  const wav = Buffer.alloc(44 + 48000 * 4);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(192000, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  for (let sample = 0; sample < 48000; sample += 1) { wav.writeInt16LE(8192, 44 + sample * 4); wav.writeInt16LE(-32768, 46 + sample * 4); }
  await writeFile(path, wav);
  const { peaks, base: finest } = await decodeWaveform(path, 1000, worker);
  expect(peaks).toHaveLength(4800); expect(peaks.every((value) => Math.abs(value - 0.25) < 0.0001)).toBe(true);
  expect(finest.sampleCount).toBe(48000); expect(finest.wave).toHaveLength(1000);
  expect([...finest.wave].every(value => Math.abs(value - 8192) <= 1)).toBe(true);
  expect(finest.spectrum.frames).toBe(100);
  const invalid = join(directory, 'invalid.wav'); await writeFile(invalid, 'invalid');
  await expect(decodeWaveform(invalid, 1000, worker)).rejects.toThrow('波形解码失败');
});

test('coarse waveform cache is regenerated for precise editing', async () => {
  const cache = memoryCache({ peaks: Array.from({ length: 2400 }, () => 0), sourceVerified: true });
  const decode = vi.fn().mockResolvedValue(decodedWaveform(60000, 0.4));
  const result = await new WaveformService(cache, decode, () => Promise.resolve(true)).ensure('show.tblink', 'song.wav', SONG, 60000, false);
  expect(stateOf(result)).toEqual(['verified', 0.4]);
  expect(result.waveform.levels[0]!.samplesPerBucket).toBe(96);
  expect(decode).toHaveBeenCalledExactlyOnceWith('song.wav', 60000);
  expect(cache.store.json?.peaks).toHaveLength(30000);
});

test('another song\'s file never fills this song\'s waveform cache', async () => {
  // 2026-11-11 the home player asked for song B with song A's link: A's peaks were saved as B's cache and
  // B's waveform stopped where A ended. The file is checked against the sha256 before anything is decoded.
  const directory = await mkdtemp(join(tmpdir(), 'tblink-waveform-')); directories.push(directory);
  const songA = 'a'.repeat(64), songB = 'b'.repeat(64);
  const fileA = join(directory, `${songA}.wav`); await writeFile(fileA, 'song a');
  const renamed = join(directory, 'natural.wav'); await writeFile(renamed, 'song a');
  const cache = memoryCache();
  const decode = vi.fn().mockResolvedValue(decodedWaveform(45000, 0.5));
  const service = new WaveformService(cache, decode);
  await expect(service.ensure('show.tblink', fileA, songB, 59470, true)).rejects.toThrow('不是这首歌的音频');
  await expect(service.ensure('show.tblink', renamed, songB, 59470, true)).rejects.toThrow('不是这首歌的音频');
  expect(decode).not.toHaveBeenCalled(); expect(cache.saveWaveformCache).not.toHaveBeenCalled(); expect(cache.saveWaveformLevels).not.toHaveBeenCalled();
  expect(stateOf(await service.ensure('show.tblink', fileA, songA, 45000, true))).toEqual(['verified', 0.5]);
  const { createHash } = await import('node:crypto');
  expect(await waveformSourceMatches(renamed, createHash('sha256').update('song a').digest('hex'))).toBe(true);
});

test('an old cache is shown as it is, rebuilt once from this song\'s file and then kept', async () => {
  // Caches from 0.5.8 have no levels (and before 2026-11-11 may hold another song's peaks: the home player asked
  // with the previous song's link). They are shown at once, then generated again the next time it is asked.
  for (const sourceVerified of [false, true]) {
    const cache = memoryCache({ peaks: Array.from({ length: 4800 }, () => 0.1), sourceVerified });
    const decode = vi.fn().mockResolvedValue(decodedWaveform(1000, 0.9)); const report = vi.fn();
    const service = new WaveformService(cache, decode, () => Promise.resolve(true), report);
    const shown = await service.ensure('show.tblink', 'song.wav', SONG, 1000, false);
    expect(stateOf(shown)).toEqual(['unverified', 0.1]);
    // Shown from the 0.5.8 cache: a waveform only, the rhythm band and the spectrum come with the rebuild.
    expect(shown.waveform.levels[0]!.rhythm).toBeNull(); expect(shown.waveform.spectrum).toBeNull();
    expect(decode).not.toHaveBeenCalled();
    const rebuilt = await service.ensure('show.tblink', 'song.wav', SONG, 1000, true);
    expect(stateOf(rebuilt)).toEqual(['verified', 0.9]); expect(rebuilt.waveform.spectrum).not.toBeNull();
    expect(cache.saveWaveformCache).toHaveBeenCalledExactlyOnceWith('show.tblink', SONG, expect.any(Array), true);
    // Kept now: neither request decodes again.
    for (const rebuild of [false, true]) expect(stateOf(await service.ensure('show.tblink', 'song.wav', SONG, 1000, rebuild))).toEqual(['verified', 0.9]);
    expect(decode).toHaveBeenCalledTimes(1); expect(report).not.toHaveBeenCalled();
  }
});

test('a song with levels is never decoded again, even after 0.5.8 rewrote its old cache', async () => {
  const cache = memoryCache({ peaks: Array.from({ length: 4800 }, () => 0.1), sourceVerified: false });
  cache.store.levels = encodeWaveformFile(SONG, decodedWaveform(1000, 0.3).base);
  const decode = vi.fn(), matches = vi.fn();
  const service = new WaveformService(cache, decode, matches);
  for (const rebuild of [false, true]) expect(stateOf(await service.ensure('show.tblink', 'song.wav', SONG, 1000, rebuild))).toEqual(['verified', 0.3]);
  expect(decode).not.toHaveBeenCalled(); expect(matches).not.toHaveBeenCalled(); expect(cache.saveWaveformCache).not.toHaveBeenCalled();
});

test('a failed rebuild keeps the old cache, is reported once and not tried again in this run', async () => {
  const report = vi.fn();
  for (const [decode, matches, reason] of [
    [vi.fn().mockRejectedValue(new Error('波形解码失败：文件读不了')), () => Promise.resolve(true), '波形解码失败'],
    [vi.fn(), () => Promise.resolve(false), '不是这首歌的音频']
  ] as const) {
    report.mockClear();
    const cache = memoryCache({ peaks: Array.from({ length: 4800 }, () => 0.1), sourceVerified: false });
    const service = new WaveformService(cache, decode, matches, report);
    const failed = await service.ensure('show.tblink', 'song.wav', SONG, 1000, true);
    expect(stateOf(failed)).toEqual(['rebuild-failed', 0.1]); expect(failed.state === 'rebuild-failed' && failed.error).toContain(reason);
    expect(report).toHaveBeenCalledExactlyOnceWith(SONG, expect.stringContaining(reason));
    // Asked again by another page, or the page is opened again: the same answer, no decode, no new report.
    for (const rebuild of [true, false]) {
      const again = await service.ensure('show.tblink', 'song.wav', SONG, 1000, rebuild);
      expect(stateOf(again)).toEqual(stateOf(failed)); expect(again.state === 'rebuild-failed' && again.error).toBe(failed.state === 'rebuild-failed' && failed.error);
    }
    expect(decode.mock.calls.length).toBeLessThanOrEqual(1); expect(report).toHaveBeenCalledTimes(1);
    expect(cache.saveWaveformCache).not.toHaveBeenCalled(); expect(cache.saveWaveformLevels).not.toHaveBeenCalled();
  }
});
