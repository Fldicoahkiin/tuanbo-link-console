import { expect, it } from 'vitest';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import ffmpeg from 'ffmpeg-static';
import { NativeAudioCache } from './native-audio-cache';

async function source(directory: string, level: number, seconds = 2): Promise<{ sourcePath: string; sourceSha256: string; expectedDurationMs: number; sampleRate: 48000 }> {
  const wav = Buffer.alloc(44 + 48000 * 4 * seconds);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(48000 * 4, 28);
  wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 44; i < wav.length; i += 2) wav.writeInt16LE(i < 44 + 48000 * 4 ? level : -level, i);
  const sourcePath = join(directory, `source-${level}.wav`); await writeFile(sourcePath, wav);
  return { sourcePath, sourceSha256: createHash('sha256').update(wav).digest('hex'), expectedDurationMs: seconds * 1000, sampleRate: 48000 };
}

it('实际 FFmpeg 分块解码保留整个原音源，不重复裁剪；复用缓存校验指纹', async () => {
  if (!ffmpeg) throw new Error('测试缺少 FFmpeg');
  const directory = await mkdtemp(join(tmpdir(), 'native-pcm-'));
  const input = await source(directory, 512);
  const cache = new NativeAudioCache(join(directory, 'cache'), ffmpeg);
  const lease = await cache.prepare(input, new AbortController().signal);
  expect(lease.frames).toBe(96000); expect(lease.durationMs).toBe(2000);
  expect(lease.availableMs).toBe(1999);
  expect(await lease.completion).toEqual({ ok: true });
  const pcm = await readFile(lease.path);
  expect(pcm.readInt16LE(0)).toBe(512); expect(pcm.readInt16LE(1500 * 192)).toBe(-512);
  const initial = await stat(lease.path); await lease.release();
  const restored = await cache.prepare(input, new AbortController().signal);
  expect((await stat(restored.path)).mtimeMs).toBe(initial.mtimeMs); expect(restored.availableMs).toBe(2000); await restored.release();
  await writeFile(restored.path, Buffer.alloc(4));
  await expect(cache.prepare(input, new AbortController().signal)).rejects.toThrow('缓存校验失败');
  expect(createHash('sha256').update(await readFile(input.sourcePath)).digest('hex')).toBe(input.sourceSha256);
});

it('未完成的后台解码显式取消并退出，不发布残缺缓存；下一首可继续准备', async () => {
  if (!ffmpeg) throw new Error('测试缺少 FFmpeg');
  const directory = await mkdtemp(join(tmpdir(), 'native-pcm-cancel-'));
  const input = await source(directory, 96, 30);
  const cache = new NativeAudioCache(join(directory, 'cache'), ffmpeg);
  const lease = await cache.prepare(input, new AbortController().signal);
  expect((await stat(lease.path)).size).toBeLessThan(lease.frames * 4);
  await lease.release();
  expect((await lease.completion).ok).toBe(false);
  await expect(stat(lease.path)).rejects.toMatchObject({ code: 'ENOENT' });
  const next = await cache.prepare({ ...input, positionMs: 29000 }, new AbortController().signal);
  expect(await next.completion).toEqual({ ok: true }); await next.release();
  expect((await stat(input.sourcePath)).size).toBe(44 + 30 * 192000);
});

it('预填充完成不能把声明时长错误的音源冒充完整缓存', async () => {
  if (!ffmpeg) throw new Error('测试缺少 FFmpeg');
  const directory = await mkdtemp(join(tmpdir(), 'native-pcm-truncated-'));
  const input = await source(directory, 144);
  const lease = await new NativeAudioCache(join(directory, 'cache'), ffmpeg).prepare({ ...input, expectedDurationMs: 4000 }, new AbortController().signal);
  const result = await lease.completion; expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.message).toContain('长度和工程记录对不上');
  await lease.release(); expect(lease.path).toMatch(/\.partial$/);
});

it('缓存容量不足不能淘汰播放租约；释放后只回收解码结果，源文件和预取消任务不变', async () => {
  if (!ffmpeg) throw new Error('测试缺少 FFmpeg');
  const directory = await mkdtemp(join(tmpdir(), 'native-pcm-budget-'));
  const a = await source(directory, 100), b = await source(directory, 200);
  const cache = new NativeAudioCache(join(directory, 'cache'), ffmpeg, 1024 * 1024, 1);
  const first = await cache.prepare(a, new AbortController().signal);
  await expect(cache.prepare(b, new AbortController().signal)).rejects.toThrow('已经占满缓存');
  expect(await first.completion).toEqual({ ok: true });
  expect((await stat(first.path)).size).toBe(384000); await first.release(); await first.release();
  const second = await cache.prepare(b, new AbortController().signal); await second.release();
  await expect(stat(first.path)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await stat(a.sourcePath)).size).toBe(384044);
  await expect(cache.prepare(a, AbortSignal.abort())).rejects.toBeDefined();
  await expect(cache.prepare({ ...a, sourceSha256: '0'.repeat(64) }, new AbortController().signal)).rejects.toThrow('原文件和工程记录的不一致');
});

it('当前音源和下一音源独立预填充；取消下一首不会终止当前音源，同源租约不重复解码', async () => {
  if (!ffmpeg) throw new Error('测试缺少 FFmpeg');
  const directory = await mkdtemp(join(tmpdir(), 'native-pcm-next-'));
  const a = await source(directory, 310, 30), b = await source(directory, 410, 30), c = await source(directory, 510, 30);
  const cache = new NativeAudioCache(join(directory, 'cache'), ffmpeg);
  const current = await cache.prepare(a, new AbortController().signal);
  const next = await cache.prepare(b, new AbortController().signal);
  const shared = await cache.prepare(a, new AbortController().signal);
  expect(shared.path).toBe(current.path);
  try {
    await expect(cache.prepare(c, new AbortController().signal)).rejects.toThrow('都在解码');
    await next.release();
    expect((await next.completion).ok).toBe(false);
    const replacement = await cache.prepare(c, new AbortController().signal);
    await replacement.release();
    await shared.release();
    expect(await current.completion).toEqual({ ok: true });
    expect((await stat(current.path)).size).toBe(30 * 192000);
  } finally { await shared.release(); await next.release(); await current.release(); }
});

it('下一音源预热按完整解码预算预留空间，不用增长文件的当前大小绕过容量', async () => {
  if (!ffmpeg) throw new Error('测试缺少 FFmpeg');
  const directory = await mkdtemp(join(tmpdir(), 'native-pcm-next-budget-'));
  const a = await source(directory, 610, 30), b = await source(directory, 710, 30);
  const cache = new NativeAudioCache(join(directory, 'cache'), ffmpeg, 9 * 1024 * 1024);
  const current = await cache.prepare(a, new AbortController().signal);
  try {
    expect((await stat(current.path)).size).toBeLessThan(30 * 192000);
    await expect(cache.prepare(b, new AbortController().signal)).rejects.toThrow('已经占满缓存');
  } finally { await current.release(); }
});

it('非零冷定位按源帧定位，PCM 从基址开始但输出位置不归零', async () => {
  if (!ffmpeg) throw new Error('测试缺少 FFmpeg');
  const directory = await mkdtemp(join(tmpdir(), 'native-pcm-seek-'));
  const input = await source(directory, 768);
  const cache = new NativeAudioCache(join(directory, 'cache'), ffmpeg);
  const lease = await cache.prepare({ ...input, positionMs: 1250 }, new AbortController().signal);
  try {
    expect(await lease.completion).toEqual({ ok: true });
    expect(lease).toMatchObject({ baseMs: 1000, durationMs: 2000, frames: 48000 });
    const pcm = await readFile(lease.path);
    expect(pcm.length).toBe(192000); expect(pcm.readInt16LE(0)).toBe(-768);
    expect(pcm.readInt16LE(250 * 192)).toBe(-768);
  } finally { await lease.release(); }
});

it('音频原文件缺失时报告为音频读取失败，界面据此提示修复或更换音频', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-pcm-missing-'));
  const cache = new NativeAudioCache(join(directory, 'cache'), ffmpeg ?? 'ffmpeg');
  await expect(cache.prepare({ sourcePath: join(directory, 'missing.wav'), sourceSha256: 'a'.repeat(64), expectedDurationMs: 2000, sampleRate: 48000 },
    new AbortController().signal)).rejects.toThrow(/^音频解码或读取失败：.*missing\.wav/);
});
