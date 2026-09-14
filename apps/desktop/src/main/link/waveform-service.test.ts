import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeWaveform, WaveformAccumulator, WaveformService } from './waveform-service';

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
  const cache = { loadWaveformCache: vi.fn((): Promise<number[] | null> => Promise.resolve(null)), saveWaveformCache: vi.fn(() => Promise.resolve()) };
  let fail: (error: Error) => void = () => { throw new Error('decoder not started'); };
  const decode = vi.fn().mockImplementationOnce(() => new Promise<number[]>((_resolve, reject) => { fail = reject; })).mockResolvedValue([0.5]);
  const service = new WaveformService(cache, decode);
  const first = service.ensure('show.tblink', 'one.wav', 'one', 1000);
  const failed = expect(first).rejects.toThrow('invalid audio');
  expect(service.ensure('show.tblink', 'one.wav', 'one', 1000)).toBe(first);
  const second = service.ensure('show.tblink', 'two.wav', 'two', 1000);
  await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(1));
  fail(new Error('invalid audio')); await failed;
  await expect(second).resolves.toEqual([0.5]);
  expect(cache.saveWaveformCache).toHaveBeenCalledExactlyOnceWith('show.tblink', 'two', [0.5]);
  cache.loadWaveformCache.mockResolvedValue([0.25]);
  await expect(service.ensure('show.tblink', 'cached.wav', 'cached', 1000)).resolves.toEqual([0.25]);
  expect(decode).toHaveBeenCalledTimes(2);
});

test('real FFmpeg streams the first channel and reports invalid media', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-waveform-')); directories.push(directory);
  const path = join(directory, 'stereo.wav');
  const wav = Buffer.alloc(44 + 48000 * 4);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(192000, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  for (let sample = 0; sample < 48000; sample += 1) { wav.writeInt16LE(8192, 44 + sample * 4); wav.writeInt16LE(-32768, 46 + sample * 4); }
  await writeFile(path, wav);
  const peaks = await decodeWaveform(path, 1000);
  expect(peaks).toHaveLength(2400); expect(peaks.every((value) => Math.abs(value - 0.25) < 0.0001)).toBe(true);
  const invalid = join(directory, 'invalid.wav'); await writeFile(invalid, 'invalid');
  await expect(decodeWaveform(invalid, 1000)).rejects.toThrow('波形解码失败');
});
