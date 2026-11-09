import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PlaybackSnapshot } from '@tb/schema';
import type { DecodeResult } from './native-audio-decode';
import { NativeAudioCache } from './native-audio-cache';
import { NativeAudioPreload } from './native-audio-preload';

// A release's rename can be refused, the way Windows refuses one while a virus scanner holds the file.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

type Decoder = { readonly finished: Promise<DecodeResult>; exit: (result: DecodeResult) => void; refuse: boolean };
const decoders = vi.hoisted(() => [] as Decoder[]);
/** While held, a prefill has not decoded the start yet: it ends once let go, or when its preparation is cancelled. */
const prefill = vi.hoisted(() => ({ held: false }));
afterEach(() => { prefill.held = false; });
// Stands in for FFmpeg: the whole decode is written at once, and the test decides when the process exits.
vi.mock('./native-audio-decode', async () => {
  const { writeFileSync } = await import('node:fs');
  const { setTimeout: delay } = await import('node:timers/promises');
  return { NativeAudioDecode: class implements Decoder {
    readonly finished: Promise<DecodeResult>;
    exit: (result: DecodeResult) => void = () => undefined;
    refuse = false;
    private result: DecodeResult | null = null;
    private cancelled = false;
    constructor(options: { output: string; rate: number; maximumBytes: number }) {
      writeFileSync(options.output, Buffer.alloc(options.maximumBytes - options.rate * 4));
      this.finished = new Promise(resolve => { this.exit = result => { this.result ??= result; resolve(this.result); }; });
      decoders.push(this);
    }
    // Checked every 10 ms like the growing file, until the start is decoded or the preparation is cancelled.
    async readyThrough(_bytes: number, signal: AbortSignal): Promise<void> {
      while (prefill.held) await delay(10, undefined, { signal });
    }
    cancel(): Promise<void> {
      if (this.result) return Promise.resolve();
      this.cancelled = true;
      // FFmpeg that has not exited 5 s after being asked to quit.
      if (this.refuse) return Promise.reject(new Error('音频解码还没退出，进程保留，不会强制结束，也不会开始新的解码'));
      this.exit({ ok: false, error: new Error('音频解码已取消') });
      return Promise.resolve();
    }
    get wasCancelled(): boolean { return this.cancelled; }
  } };
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-audio-release-'));
  const audio = Buffer.from('audio fixture'), sourcePath = join(directory, 'source.wav'); await writeFile(sourcePath, audio);
  const input = { sourcePath, sourceSha256: createHash('sha256').update(audio).digest('hex'), expectedDurationMs: 1000, sampleRate: 48000 as const };
  return { cache: new NativeAudioCache(join(directory, 'cache'), 'ffmpeg'), input, signal: new AbortController().signal };
}

it('解码完成后存缓存时改名失败一次：错误交给释放的一方；同一音源同一起点可以再准备，之后照常存成缓存', async () => {
  const { cache, input, signal } = await fixture();
  const first = await cache.prepare(input, signal);
  decoders.at(-1)!.exit({ ok: true }); expect(await first.completion).toEqual({ ok: true });
  vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }));
  await expect(first.release()).rejects.toThrow('EPERM');
  // Already let go: asking again does not throw the old error a second time.
  await first.release();
  const again = await cache.prepare(input, signal);
  expect(again.streaming).toBe(true);
  decoders.at(-1)!.exit({ ok: true }); expect(await again.completion).toEqual({ ok: true });
  await again.release();
  const cached = await cache.prepare(input, signal);
  expect(cached.streaming).toBe(false); await cached.release();
});

it('解码进程不肯退出：同一音源明确说正在释放、不开新的解码；进程真正退出后同一起点可以再准备', async () => {
  const { cache, input, signal } = await fixture();
  const first = await cache.prepare(input, signal);
  const decoder = decoders.at(-1)!; decoder.refuse = true;
  await expect(first.release()).rejects.toThrow('还没退出');
  const started = decoders.length;
  await expect(cache.prepare(input, signal)).rejects.toThrow('正在释放');
  expect(decoders).toHaveLength(started);
  decoder.exit({ ok: false, error: new Error('音频解码已取消') }); await decoder.finished;
  const again = await cache.prepare(input, signal);
  expect(decoders).toHaveLength(started + 1);
  await again.release(); await first.release();
  await (await cache.prepare(input, signal)).release();
});

it('下一首还在预填充时换歌，解码进程不肯退出：运行日志里有这一条；同一音源说正在释放，进程退出后可以再准备', async () => {
  const { cache, input, signal } = await fixture();
  const error = vi.fn(), cleanupError = vi.fn();
  const preload = new NativeAudioPreload({ cache, resolveAudio: () => input.sourcePath, error, cleanupError });
  const snapshot: PlaybackSnapshot = { version: 1, projectId: 'p', itemId: 'next', revision: 1,
    audio: { relativePath: 'source.wav', sha256: input.sourceSha256, durationMs: input.expectedDurationMs },
    startMs: 0, endMs: input.expectedDurationMs, positionMs: 0, offsetMs: 0, frameRate: 30, sampleRate: input.sampleRate, volume: 1 };
  prefill.held = true;
  const started = decoders.length;
  preload.start('p.tblink', snapshot);
  await vi.waitFor(() => expect(decoders).toHaveLength(started + 1));
  const decoder = decoders.at(-1)!; decoder.refuse = true;
  // The operator plays another song while this one is still decoding its start.
  expect(await preload.take('p.tblink', { ...snapshot, itemId: 'other' })).toBeNull();
  expect(cleanupError).toHaveBeenCalledOnce(); expect(cleanupError).toHaveBeenCalledWith(expect.stringContaining('还没退出'));
  expect(error).not.toHaveBeenCalled();
  prefill.held = false;
  await expect(cache.prepare(input, signal)).rejects.toThrow('正在释放');
  decoder.exit({ ok: false, error: new Error('音频解码已取消') }); await decoder.finished;
  await (await cache.prepare(input, signal)).release();
});
