import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { decodeWaveform, WaveformAccumulator, WaveformService, waveformSourceMatches } from './waveform-service';
import type { WaveformCacheEntry } from './link-project-service';

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) {
    for (const name of await readdir(path)) await unlink(join(path, name));
    await rmdir(path);
  }
});

test('arbitrary PCM byte boundaries preserve every peak including the last sample', () => {
  const pcm = Buffer.alloc(20);
  [0, -0.7, 0.2, 0, 1].forEach((value, index) => pcm.writeFloatLE(value, index * 4));
  for (const size of [1, 3, 7, 20]) {
    const accumulator = new WaveformAccumulator(5, 2);
    for (let index = 0; index < pcm.length; index += size) accumulator.push(pcm.subarray(index, index + size));
    expect(accumulator.finish()[0]).toBeCloseTo(0.7);
    expect(accumulator.finish()[1]).toBe(1);
  }
});

test('invalid or truncated PCM cannot become a successful cache', () => {
  const partial = new WaveformAccumulator(1); partial.push(Buffer.from([0]));
  expect(() => partial.finish()).toThrow('完整有效');
  const nonFinite = new WaveformAccumulator(1); const pcm = Buffer.alloc(4); pcm.writeFloatLE(NaN);
  nonFinite.push(pcm); expect(() => nonFinite.finish()).toThrow('完整有效');
  expect(() => new WaveformAccumulator(0)).toThrow('采样范围');
});

test('concurrent requests share work, independent jobs serialize and failures never write cache', async () => {
  const cache = { loadWaveformCache: vi.fn((): Promise<WaveformCacheEntry | null> => Promise.resolve(null)), saveWaveformCache: vi.fn(() => Promise.resolve()) };
  let fail: (error: Error) => void = () => { throw new Error('decoder not started'); };
  const decode = vi.fn().mockImplementationOnce(() => new Promise<number[]>((_resolve, reject) => { fail = reject; })).mockResolvedValue([0.5]);
  const service = new WaveformService(cache, decode, () => Promise.resolve(true));
  const first = service.ensure('show.tblink', 'one.wav', 'one', 1000, true);
  const failed = expect(first).rejects.toThrow('invalid audio');
  expect(service.ensure('show.tblink', 'one.wav', 'one', 1000, true)).toBe(first);
  const second = service.ensure('show.tblink', 'two.wav', 'two', 1000, true);
  await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(1));
  fail(new Error('invalid audio')); await failed;
  await expect(second).resolves.toEqual({ state: 'verified', peaks: [0.5] });
  expect(cache.saveWaveformCache).toHaveBeenCalledExactlyOnceWith('show.tblink', 'two', [0.5], true);
  cache.loadWaveformCache.mockResolvedValue({ peaks: Array.from({ length: 4800 }, () => 0.25), sourceVerified: true });
  expect((await service.ensure('show.tblink', 'cached.wav', 'cached', 1000, true)).peaks).toHaveLength(4800);
  expect(decode).toHaveBeenCalledTimes(2);
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
  const peaks = await decodeWaveform(path, 1000, worker);
  expect(peaks).toHaveLength(4800); expect(peaks.every((value) => Math.abs(value - 0.25) < 0.0001)).toBe(true);
  const invalid = join(directory, 'invalid.wav'); await writeFile(invalid, 'invalid');
  await expect(decodeWaveform(invalid, 1000, worker)).rejects.toThrow('波形解码失败');
});

test('coarse waveform cache is regenerated for precise editing', async () => {
  const cache = { loadWaveformCache: vi.fn().mockResolvedValue({ peaks: Array(2400).fill(0), sourceVerified: true }), saveWaveformCache: vi.fn().mockResolvedValue(undefined) };
  const detailed = Array.from({ length: 30000 }, (_, index) => index === 12001 ? 1 : 0);
  const decode = vi.fn().mockResolvedValue(detailed);
  const result = await new WaveformService(cache, decode, () => Promise.resolve(true)).ensure('show.tblink', 'song.wav', 'song', 60000, false);
  expect(result.peaks[12001]).toBe(1);
  expect(decode).toHaveBeenCalledExactlyOnceWith('song.wav', 60000);
  expect(cache.saveWaveformCache).toHaveBeenCalledExactlyOnceWith('show.tblink', 'song', detailed, true);
});

test('another song\'s file never fills this song\'s waveform cache', async () => {
  // 2026-11-11 the home player asked for song B with song A's link: A's peaks were saved as B's cache and
  // B's waveform stopped where A ended. The file is checked against the sha256 before anything is decoded.
  const directory = await mkdtemp(join(tmpdir(), 'tblink-waveform-')); directories.push(directory);
  const songA = 'a'.repeat(64), songB = 'b'.repeat(64);
  const fileA = join(directory, `${songA}.wav`); await writeFile(fileA, 'song a');
  const renamed = join(directory, 'natural.wav'); await writeFile(renamed, 'song a');
  const cache = { loadWaveformCache: vi.fn((): Promise<WaveformCacheEntry | null> => Promise.resolve(null)), saveWaveformCache: vi.fn(() => Promise.resolve()) };
  const decode = vi.fn().mockResolvedValue([0.5]);
  const service = new WaveformService(cache, decode);
  await expect(service.ensure('show.tblink', fileA, songB, 59470, true)).rejects.toThrow('不是这首歌的音频');
  await expect(service.ensure('show.tblink', renamed, songB, 59470, true)).rejects.toThrow('不是这首歌的音频');
  expect(decode).not.toHaveBeenCalled(); expect(cache.saveWaveformCache).not.toHaveBeenCalled();
  await expect(service.ensure('show.tblink', fileA, songA, 45000, true)).resolves.toEqual({ state: 'verified', peaks: [0.5] });
  const { createHash } = await import('node:crypto');
  expect(await waveformSourceMatches(renamed, createHash('sha256').update('song a').digest('hex'))).toBe(true);
});

test('an old cache is shown as it is, rebuilt once from this song\'s file and then marked', async () => {
  // Caches saved before 2026-11-11 may hold another song's peaks (the home player asked with the previous
  // song's link). They carry no mark, so they are rebuilt the next time the song's waveform is asked for.
  const old = Array.from({ length: 4800 }, () => 0.1), rebuilt = Array.from({ length: 4800 }, () => 0.9);
  let stored: WaveformCacheEntry = { peaks: old, sourceVerified: false };
  const cache = { loadWaveformCache: vi.fn(() => Promise.resolve(stored)),
    saveWaveformCache: vi.fn((_project: string, _sha: string, peaks: number[], sourceVerified: boolean) => { stored = { peaks, sourceVerified }; return Promise.resolve(); }) };
  const decode = vi.fn().mockResolvedValue(rebuilt); const report = vi.fn();
  const service = new WaveformService(cache, decode, () => Promise.resolve(true), report);
  await expect(service.ensure('show.tblink', 'song.wav', 'song', 1000, false)).resolves.toEqual({ state: 'unverified', peaks: old });
  expect(decode).not.toHaveBeenCalled();
  await expect(service.ensure('show.tblink', 'song.wav', 'song', 1000, true)).resolves.toEqual({ state: 'verified', peaks: rebuilt });
  expect(cache.saveWaveformCache).toHaveBeenCalledExactlyOnceWith('show.tblink', 'song', rebuilt, true);
  // Marked now: neither request decodes again.
  await expect(service.ensure('show.tblink', 'song.wav', 'song', 1000, false)).resolves.toEqual({ state: 'verified', peaks: rebuilt });
  await expect(service.ensure('show.tblink', 'song.wav', 'song', 1000, true)).resolves.toEqual({ state: 'verified', peaks: rebuilt });
  expect(decode).toHaveBeenCalledTimes(1); expect(report).not.toHaveBeenCalled();
});

test('a marked cache is never rebuilt', async () => {
  const peaks = Array.from({ length: 4800 }, () => 0.3);
  const cache = { loadWaveformCache: vi.fn().mockResolvedValue({ peaks, sourceVerified: true }), saveWaveformCache: vi.fn() };
  const decode = vi.fn(), matches = vi.fn();
  const service = new WaveformService(cache, decode, matches);
  for (const rebuild of [false, true]) await expect(service.ensure('show.tblink', 'song.wav', 'song', 1000, rebuild)).resolves.toEqual({ state: 'verified', peaks });
  expect(decode).not.toHaveBeenCalled(); expect(matches).not.toHaveBeenCalled(); expect(cache.saveWaveformCache).not.toHaveBeenCalled();
});

test('a failed rebuild keeps the old cache, is reported once and not tried again in this run', async () => {
  const old = Array.from({ length: 4800 }, () => 0.1);
  const cache = { loadWaveformCache: vi.fn().mockResolvedValue({ peaks: old, sourceVerified: false }), saveWaveformCache: vi.fn() };
  const report = vi.fn();
  for (const [decode, matches, reason] of [
    [vi.fn().mockRejectedValue(new Error('波形解码失败：文件读不了')), () => Promise.resolve(true), '波形解码失败'],
    [vi.fn(), () => Promise.resolve(false), '不是这首歌的音频']
  ] as const) {
    report.mockClear();
    const service = new WaveformService(cache, decode, matches, report);
    const failed = await service.ensure('show.tblink', 'song.wav', 'song', 1000, true);
    expect(failed).toMatchObject({ state: 'rebuild-failed', peaks: old }); expect(failed.state === 'rebuild-failed' && failed.error).toContain(reason);
    expect(report).toHaveBeenCalledExactlyOnceWith('song', expect.stringContaining(reason));
    // Asked again by another page, or the page is opened again: the same answer, no decode, no new report.
    for (const rebuild of [true, false]) await expect(service.ensure('show.tblink', 'song.wav', 'song', 1000, rebuild)).resolves.toEqual(failed);
    expect(decode.mock.calls.length).toBeLessThanOrEqual(1); expect(report).toHaveBeenCalledTimes(1);
  }
  expect(cache.saveWaveformCache).not.toHaveBeenCalled();
});
