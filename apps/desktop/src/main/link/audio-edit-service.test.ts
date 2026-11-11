import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AudioEditService, composeAudioPcm, mixCacheKey } from './audio-edit-service';
import { LinkProjectService } from './link-project-service';
import { readExtractedAudioDuration } from './reference-audio-extractor';

it('音频编辑按源位置复制采样，并在时间线空隙写入静音', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-pcm-'));
  const source = join(directory, 'source.pcm'); const output = join(directory, 'edit.pcm');
  const pcm = Buffer.concat([Buffer.alloc(192, 1), Buffer.alloc(192, 2), Buffer.alloc(192, 3)]);
  await writeFile(source, pcm);
  try {
    await composeAudioPcm(source, output, [
      { id: 'a', startMs: 0, sourceOffsetMs: 2, durationMs: 1 },
      { id: 'b', startMs: 2, sourceOffsetMs: 0, durationMs: 1 }
    ]);
    expect(await readFile(output)).toEqual(Buffer.concat([Buffer.alloc(192, 3), Buffer.alloc(192), Buffer.alloc(192, 1)]));
  } finally { await unlink(source); await unlink(output); await rmdir(directory); }
});

/** A 48 kHz stereo 16-bit WAV of `ms` milliseconds; every sample is (left, right). */
function stereoWav(left: number, right: number, ms = 300): Buffer {
  const pcm = Buffer.alloc(ms * 192);
  for (let index = 0; index < pcm.length; index += 4) { pcm.writeInt16LE(left, index); pcm.writeInt16LE(right, index + 2); }
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22); header.writeUInt32LE(48000, 24); header.writeUInt32LE(192000, 28);
  header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function source(directory: string, name: string, buffer: Buffer, durationMs: number) {
  await writeFile(join(directory, name), buffer);
  return { assetId: name, relativePath: name, sha256: createHash('sha256').update(buffer).digest('hex'), durationMs };
}

async function clean(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await clean(path); else await unlink(path);
  }
  await rmdir(directory);
}

const silent = (bytes: Buffer): boolean => bytes.every((byte) => byte === 0);

describe('音乐后面的空白渲染成 WAV 里的静音（0.5.9 E13）', () => {
  it('composeAudioPcm 补静音到歌曲总长；片段超出总长就不写', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tblink-pcm-tail-'));
    try {
      const path = join(directory, 'source.pcm');
      await writeFile(path, Buffer.alloc(3 * 192, 5));
      await composeAudioPcm(path, join(directory, 'edit.pcm'), [{ id: 'a', startMs: 1, sourceOffsetMs: 0, durationMs: 2 }], undefined, 6);
      expect(await readFile(join(directory, 'edit.pcm'))).toEqual(Buffer.concat([Buffer.alloc(192), Buffer.alloc(2 * 192, 5), Buffer.alloc(3 * 192)]));
      await expect(composeAudioPcm(path, join(directory, 'short.pcm'), [{ id: 'a', startMs: 1, sourceOffsetMs: 0, durationMs: 2 }], undefined, 2)).rejects.toThrow('超出了歌曲总长');
    } finally { await clean(directory); }
  });

  it('单轨：字节数 = 总长 × 192 + 头，前后空白全是 0，中间是原来的采样', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tblink-tail-single-'));
    try {
      const buffer = stereoWav(1200, -900);
      const sound = await source(directory, 'source.wav', buffer, 300);
      const segments = [{ id: 'music', startMs: 40, sourceOffsetMs: 50, durationMs: 100 }];
      const result = await new AudioEditService(new LinkProjectService()).mix(join(directory, 'show.tblink'), [{ id: 'track', title: '歌曲音频', source: sound, segments }], 400);
      const wav = await readFile(join(directory, result.relativePath));
      expect(wav.length).toBe(44 + 400 * 192);
      expect(silent(wav.subarray(44, 44 + 40 * 192))).toBe(true);
      expect(wav.subarray(44 + 40 * 192, 44 + 140 * 192)).toEqual(buffer.subarray(44 + 50 * 192, 44 + 150 * 192));
      expect(silent(wav.subarray(44 + 140 * 192))).toBe(true);
      expect(await readExtractedAudioDuration(join(directory, result.relativePath))).toBe(400);
      expect(result.durationMs).toBe(400);
      expect(result.timeline?.durationMs).toBe(400);
      expect(result.timeline?.tracks?.[0]?.segments).toEqual(segments);
    } finally { await clean(directory); }
  });

  it('快速路径照旧：整段、从 0 开始、没有尾空白时直接用源文件；有尾空白才渲染新文件', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tblink-tail-fast-'));
    try {
      const buffer = stereoWav(32767, -32768);
      const sound = await source(directory, 'source.wav', buffer, 300);
      const tracks = [{ id: 'track', title: '歌曲音频', source: sound, segments: [{ id: 'whole', startMs: 0, sourceOffsetMs: 0, durationMs: 300 }] }];
      const service = new AudioEditService(new LinkProjectService());
      const project = join(directory, 'show.tblink');
      const plain = await service.mix(project, tracks);
      expect(plain.relativePath).toBe('source.wav');
      expect(plain.sha256).toBe(sound.sha256);
      expect(plain.timeline?.durationMs).toBeUndefined();
      await expect(readdir(join(directory, 'assets'))).rejects.toThrow();
      expect((await service.mix(project, tracks, 300)).relativePath).toBe('source.wav');
      const padded = await service.mix(project, tracks, 500);
      expect(padded.relativePath).not.toBe('source.wav');
      const wav = await readFile(join(directory, padded.relativePath));
      expect(wav.length).toBe(44 + 500 * 192);
      expect(wav.subarray(44, 44 + 300 * 192)).toEqual(buffer.subarray(44));
      expect(silent(wav.subarray(44 + 300 * 192))).toBe(true);
      expect(await readFile(join(directory, 'source.wav'))).toEqual(buffer);
    } finally { await clean(directory); }
  });

  it('混音缓存的名字带上总长；没有总长时和 0.5.8 的名字一样，已渲染的混音照旧找得到', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tblink-tail-cache-'));
    try {
      const sound = await source(directory, 'source.wav', stereoWav(1000, 2000), 300);
      const tracks = [{ id: 'track', title: '歌曲音频', source: sound, segments: [{ id: 'cut', startMs: 10, sourceOffsetMs: 20, durationMs: 100 }] }];
      const before = createHash('sha256').update(JSON.stringify([{ source: sound.sha256, durationMs: 300, segments: [{ startMs: 10, sourceOffsetMs: 20, durationMs: 100 }] }])).digest('hex');
      expect(mixCacheKey(tracks, undefined)).toBe(before);
      expect(new Set([mixCacheKey(tracks, undefined), mixCacheKey(tracks, 200), mixCacheKey(tracks, 300)]).size).toBe(3);
      const service = new AudioEditService(new LinkProjectService());
      const project = join(directory, 'show.tblink');
      const short = await service.mix(project, tracks, 200);
      const long = await service.mix(project, tracks, 300);
      expect(long.relativePath).not.toBe(short.relativePath);
      expect((await service.mix(project, tracks, 200)).relativePath).toBe(short.relativePath);
      expect((await readdir(join(directory, 'cache', 'audio-mixes'))).sort()).toEqual([`${mixCacheKey(tracks, 200)}.json`, `${mixCacheKey(tracks, 300)}.json`].sort());
    } finally { await clean(directory); }
  });

  it('多音轨：短的那条补齐到总长，最后一段音乐之后全是 0', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tblink-tail-multi-'));
    try {
      const first = await source(directory, 'first.wav', stereoWav(1000, 0), 300);
      const second = await source(directory, 'second.wav', stereoWav(0, 2000), 300);
      const tracks = [
        { id: 'long', title: '歌曲音频', source: first, segments: [{ id: 'a', startMs: 0, sourceOffsetMs: 0, durationMs: 300 }] },
        { id: 'short', title: '原声', source: second, segments: [{ id: 'b', startMs: 100, sourceOffsetMs: 0, durationMs: 50 }] }
      ];
      const result = await new AudioEditService(new LinkProjectService()).mix(join(directory, 'show.tblink'), tracks, 450);
      const wav = await readFile(join(directory, result.relativePath));
      const data = wav.indexOf(Buffer.from('data')) + 8;
      const sample = (ms: number, channel: number): number => wav.readInt16LE(data + ms * 192 + channel * 2);
      expect(wav.length - data).toBe(450 * 192);
      expect(await readExtractedAudioDuration(join(directory, result.relativePath))).toBe(450);
      expect(sample(120, 1)).toBe(2000);
      expect(sample(200, 0)).toBe(1000);
      expect(sample(200, 1)).toBe(0);
      expect(silent(wav.subarray(data + 300 * 192))).toBe(true);
      expect(result.timeline?.durationMs).toBe(450);
    } finally { await clean(directory); }
  });

  it('多音轨要限幅、走 FFmpeg 时，每条轨也补齐到总长', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tblink-tail-limiter-'));
    try {
      const first = await source(directory, 'first.wav', stereoWav(30000, 30000), 300);
      const second = await source(directory, 'second.wav', stereoWav(30000, 30000), 300);
      const tracks = [
        { id: 'one', title: '歌曲音频', source: first, segments: [{ id: 'a', startMs: 0, sourceOffsetMs: 0, durationMs: 200 }] },
        { id: 'two', title: '原声', source: second, segments: [{ id: 'b', startMs: 50, sourceOffsetMs: 0, durationMs: 100 }] }
      ];
      const result = await new AudioEditService(new LinkProjectService()).mix(join(directory, 'show.tblink'), tracks, 500);
      expect(await readExtractedAudioDuration(join(directory, result.relativePath))).toBe(500);
      const wav = await readFile(join(directory, result.relativePath));
      const data = wav.indexOf(Buffer.from('data')) + 8;
      expect(wav.length - data).toBe(500 * 192);
      expect(silent(wav.subarray(data + 250 * 192))).toBe(true);
    } finally { await clean(directory); }
  }, 30000);

  it('总长比最后一段音乐还短时不渲染', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tblink-tail-short-'));
    try {
      const sound = await source(directory, 'source.wav', stereoWav(1, 1), 300);
      const tracks = [{ id: 'track', title: '歌曲音频', source: sound, segments: [{ id: 'cut', startMs: 100, sourceOffsetMs: 0, durationMs: 100 }] }];
      await expect(new AudioEditService(new LinkProjectService()).mix(join(directory, 'show.tblink'), tracks, 150)).rejects.toThrow('歌曲总长比最后一段音频还短');
      await expect(readdir(join(directory, 'cache'))).rejects.toThrow();
    } finally { await clean(directory); }
  });
});
