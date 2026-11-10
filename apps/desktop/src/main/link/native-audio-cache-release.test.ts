import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { toUserErrorMessage } from '@tb/core/link';
import type { PlaybackSnapshot } from '@tb/schema';
import type { DecodeResult } from './native-audio-decode';
import { NativeAudioCache } from './native-audio-cache';
import { NativeAudioPreload } from './native-audio-preload';

// A release's rename, or removing a file, can be refused, the way Windows refuses one while another program holds the file.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename), unlink: vi.fn(actual.unlink) };
});

type Decoder = { readonly finished: Promise<DecodeResult>; exit: (result: DecodeResult) => void; refuse: boolean };
const decoders = vi.hoisted(() => [] as Decoder[]);
/** While held, a prefill has not decoded the start yet: it ends once let go, or when its preparation is cancelled. */
const prefill = vi.hoisted(() => ({ held: false }));
/** Off: FFmpeg has started but not created its output file yet. */
const output = vi.hoisted(() => ({ written: true }));
afterEach(() => { prefill.held = false; output.written = true; });
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
      if (output.written) writeFileSync(options.output, Buffer.alloc(options.maximumBytes - options.rate * 4));
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

async function fixture(budgetBytes?: number) {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-audio-release-'));
  const audio = Buffer.from('audio fixture'), sourcePath = join(directory, 'source.wav'); await writeFile(sourcePath, audio);
  const input = { sourcePath, sourceSha256: createHash('sha256').update(audio).digest('hex'), expectedDurationMs: 1000, sampleRate: 48000 as const };
  return { cache: new NativeAudioCache(join(directory, 'cache'), 'ffmpeg', budgetBytes), input, signal: new AbortController().signal, directory: join(directory, 'cache') };
}
async function song(directory: string, text: string) {
  const audio = Buffer.from(text), sourcePath = join(dirname(directory), `${text}.wav`); await writeFile(sourcePath, audio);
  return { sourcePath, sourceSha256: createHash('sha256').update(audio).digest('hex'), expectedDurationMs: 1000, sampleRate: 48000 as const };
}
/** A decode file nobody writes any more, the way a crash or a killed app leaves one. */
async function leftover(directory: string, bytes: number): Promise<string> {
  const path = join(directory, `${'c'.repeat(64)}-48000-0.0f0e0d0c-0b0a-4908-8706-050403020100.partial`);
  await mkdir(directory, { recursive: true }); await writeFile(path, Buffer.alloc(bytes)); return path;
}
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);
// One whole decode of the 1 s fixture reserves 384 000 bytes.
const budget = 600_000;

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
  const error = vi.fn();
  const preload = new NativeAudioPreload({ cache, resolveAudio: () => input.sourcePath, error });
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
  expect(error).toHaveBeenCalledExactlyOnceWith(
    '下一首提前准备的音频已放下，放下时出了错，这份音频不会再用。如果反复出现，请导出诊断包发给售后。原因：音频解码还没退出，进程保留，不会强制结束，也不会开始新的解码');
  prefill.held = false;
  await expect(cache.prepare(input, signal)).rejects.toThrow('正在释放');
  decoder.exit({ ok: false, error: new Error('音频解码已取消') }); await decoder.finished;
  await (await cache.prepare(input, signal)).release();
});

it('切走的下一首解码进程还没写出文件就不肯退出：之后别的歌照常准备，不报找不到文件（2026-11-09）', async () => {
  const { cache, input, signal } = await fixture();
  const audio = Buffer.from('another song'), sourcePath = join(dirname(input.sourcePath), 'another.wav'); await writeFile(sourcePath, audio);
  const other = { ...input, sourcePath, sourceSha256: createHash('sha256').update(audio).digest('hex') };
  output.written = false; prefill.held = true;
  const abort = new AbortController(), started = decoders.length;
  const pending = cache.prepare(input, abort.signal);
  await vi.waitFor(() => expect(decoders).toHaveLength(started + 1));
  const stuck = decoders.at(-1)!; stuck.refuse = true;
  // The operator moves on before FFmpeg has written anything, and FFmpeg does not exit.
  abort.abort();
  await expect(pending).rejects.toThrow('还没退出');
  output.written = true; prefill.held = false;
  const next = await cache.prepare(other, signal);
  expect(next.streaming).toBe(true);
  decoders.at(-1)!.exit({ ok: true }); expect(await next.completion).toEqual({ ok: true });
  await next.release();
  stuck.exit({ ok: false, error: new Error('音频解码已取消') }); await stuck.finished;
});

it('解码进程不肯退出、后来自己退出了：它没写完的文件跟着删掉，不再占缓存（2026-11-10）', async () => {
  const { cache, input, signal } = await fixture();
  const first = await cache.prepare(input, signal);
  const decoder = decoders.at(-1)!; decoder.refuse = true;
  const path = first.path;
  await expect(first.release()).rejects.toThrow('还没退出');
  expect(await exists(path)).toBe(true);
  decoder.exit({ ok: false, error: new Error('音频解码已取消') }); await decoder.finished;
  await vi.waitFor(async () => expect(await exists(path)).toBe(false));
});

it('崩溃或被结束时留下的没写完的文件：下次准备新的歌时删掉，不再算进缓存上限（2026-11-10）', async () => {
  const { cache, input, signal, directory } = await fixture(budget);
  await (await cache.prepare(input, signal)).release();
  const left = await leftover(directory, 300_000);
  const next = await cache.prepare(await song(directory, 'next song'), signal);
  expect(next.streaming).toBe(true);
  expect(await exists(left)).toBe(false);
  decoders.at(-1)!.exit({ ok: true }); await next.release();
});

it('解码失败的文件放下后留着：下次准备新的歌时删掉（2026-11-10）', async () => {
  const { cache, input, signal, directory } = await fixture();
  const first = await cache.prepare(input, signal);
  decoders.at(-1)!.exit({ ok: false, error: new Error('音频解码失败（1）') });
  const failed = first.path;
  await first.release();
  expect(await exists(failed)).toBe(true);
  const next = await cache.prepare(await song(directory, 'next song'), signal);
  expect(await exists(failed)).toBe(false);
  decoders.at(-1)!.exit({ ok: true }); await next.release();
});

it('上一个播放服务的解码进程还在写：新的缓存不删它的文件，它退出后才删（2026-11-10）', async () => {
  const { cache, input, signal, directory } = await fixture();
  const first = await cache.prepare(input, signal);
  const stuck = decoders.at(-1)!; stuck.refuse = true;
  const writing = first.path;
  await expect(first.release()).rejects.toThrow('还没退出');
  // link-main gives the next player service its own cache on the same directory.
  const replacement = new NativeAudioCache(directory, 'ffmpeg');
  const next = await replacement.prepare(await song(directory, 'next song'), signal);
  expect(await exists(writing)).toBe(true);
  decoders.at(-1)!.exit({ ok: true }); await next.release();
  expect(await exists(writing)).toBe(true);
  stuck.exit({ ok: false, error: new Error('音频解码已取消') }); await stuck.finished;
  await vi.waitFor(async () => expect(await exists(writing)).toBe(false));
  expect((await readdir(directory)).filter(name => name.endsWith('.partial'))).toEqual([]);
});

it('没写完的文件删不掉：照样算进缓存，缓存满了时说明原因；能删时照常准备（2026-11-10）', async () => {
  const { cache, input, signal, directory } = await fixture(budget);
  const left = await leftover(directory, 300_000);
  vi.mocked(unlink).mockRejectedValueOnce(Object.assign(new Error('EBUSY: resource busy or locked, unlink'), { code: 'EBUSY' }));
  const started = decoders.length;
  const full = '正在播放和准备的音频已经占满缓存，其中有用不上的临时音频文件删不掉，可能正被别的程序打开。请过一会儿再试；一直这样的话，重启电脑后再试。';
  const refused = await cache.prepare(input, signal).then(() => null, (error: unknown) => error);
  expect(refused).toMatchObject({ message: full, cause: { code: 'EBUSY' } });
  // The window shows it as written.
  expect(toUserErrorMessage(refused)).toBe(full);
  expect(decoders).toHaveLength(started);
  expect(await exists(left)).toBe(true);
  const lease = await cache.prepare(input, signal);
  expect(await exists(left)).toBe(false);
  decoders.at(-1)!.exit({ ok: true }); await lease.release();
});
