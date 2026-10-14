import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, readdir, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { alignExtractedAudioDuration, extractReferenceAudioTrack, readExtractedAudioDuration } from './reference-audio-extractor';
import { AudioEditService, composeAudioPcm } from './audio-edit-service';
import { LinkProjectService } from './link-project-service';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';

it.each([2, 43.733, 65.033])('真实 %s 秒 MP4 视频长于 AAC 音轨时按解码采样导入，非整帧落点混音不越界', async seconds => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-short-audio-'));
  try {
    if (!ffmpegPath) throw new Error('测试缺少 FFmpeg');
    const video = join(directory, 'short-audio.mp4');
    await promisify(execFile)(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=s=64x64:r=30:d=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds - 0.75}`, '-c:v', 'mpeg4', '-c:a', 'aac', video], { windowsHide: true });
    const projects = new LinkProjectService();
    const project = join(directory, 'show.tblink');
    const source = await projects.importReferenceAudio(project, video, Math.round(seconds * 1000));
    const reused = await projects.importReferenceAudio(project, video, Math.round(seconds * 1000));
    expect(reused.relativePath).toBe(source.relativePath);
    expect(reused.durationMs).toBe(source.durationMs);
    expect(source.durationMs).toBeGreaterThanOrEqual(Math.floor((seconds - 0.75) * 1000));
    expect(source.durationMs).toBeLessThan((seconds - 0.6) * 1000);
    const segments = [{ id: 'audio', startMs: 1033, sourceOffsetMs: 0, durationMs: source.durationMs }];
    const result = await new AudioEditService(projects).mix(project, [{ id: 'track', title: '视频原声', source, segments }]);
    expect(result.durationMs).toBe(1033 + source.durationMs);
    expect(result.timeline?.tracks?.[0]?.segments).toEqual(segments);
  } finally { await cleanOwnedFixture(directory); }
}, 30000);

function stereoWav(left: number, right: number, seconds = 0.3): Buffer {
  const pcm = Buffer.alloc(48000 * 4 * seconds);
  for (let index = 0; index < pcm.length; index += 4) { pcm.writeInt16LE(left, index); pcm.writeInt16LE(right, index + 2); }
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22); header.writeUInt32LE(48000, 24); header.writeUInt32LE(192000, 28);
  header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

it.each([8000, 24000, -24000])('多轨优化逐采样等同 FFmpeg 基线，含跨块裁剪、间隙和限幅：%s', async level => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-mix-parity-'));
  try {
    if (!ffmpegPath) throw new Error('测试缺少 FFmpeg');
    const tracks = [];
    const inputs: string[] = [];
    for (let index = 0; index < 2; index++) {
      const buffer = stereoWav(level, -level, 6);
      // Transients and opposite stereo polarity exercise limiter attack/release.
      for (let sample = 0; sample < 6 * 48000; sample++) {
        const amplitude = Math.round(level * Math.sin(sample / (index + 3)));
        buffer.writeInt16LE(amplitude, 44 + sample * 4); buffer.writeInt16LE(-amplitude, 46 + sample * 4);
      }
      const name = `source-${index}.wav`; const path = join(directory, name); await writeFile(path, buffer);
      const source = { assetId: name, relativePath: name, durationMs: 6000, sha256: createHash('sha256').update(buffer).digest('hex') };
      const segments = [{ id: `${index}-a`, startMs: index * 137, sourceOffsetMs: index * 251, durationMs: 1733 },
        { id: `${index}-b`, startMs: 2103, sourceOffsetMs: 1991, durationMs: 2837 }];
      tracks.push({ id: `track-${index}`, title: name, source, segments });
      const raw = join(directory, `baseline-${index}.pcm`);
      await composeAudioPcm(path, raw, segments, { offset: 44, bytes: buffer.length - 44 });
      inputs.push('-f', 's16le', '-ar', '48000', '-ac', '2', '-i', raw);
    }
    const baseline = join(directory, 'baseline.wav');
    await promisify(execFile)(ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...inputs, '-filter_complex',
      'amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.98:level=0:latency=1', '-c:a', 'pcm_s16le', baseline], { windowsHide: true });
    const mixed = await new AudioEditService(new LinkProjectService()).mix(join(directory, 'show.tblink'), tracks);
    const expected = await readFile(baseline); const actual = await readFile(join(directory, mixed.relativePath));
    expect(actual.subarray(actual.indexOf(Buffer.from('data')) + 8)).toEqual(expected.subarray(expected.indexOf(Buffer.from('data')) + 8));
    expect(mixed.timeline?.tracks).toEqual(tracks);
    expect(mixed.durationMs).toBe(4940);
    expect(await readdir(join(directory, 'cache', 'audio-edit'))).toEqual([]);
  } finally { await cleanOwnedFixture(directory); }
}, 30000);

it('完整 PCM 原声音轨直接复用，保留满幅声道和可编辑片段，不生成混音文件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-pcm-reuse-'));
  try {
    const buffer = stereoWav(32767, -32768); await writeFile(join(directory, 'source.wav'), buffer);
    const source = { assetId: 'sound', relativePath: 'source.wav', sha256: createHash('sha256').update(buffer).digest('hex'), durationMs: 300 };
    const tracks = [{ id: 'track', title: '原声', source, segments: [{ id: 'segment', startMs: 0, sourceOffsetMs: 0, durationMs: 300 }] }];
    const projects = new LinkProjectService(); const imported = vi.spyOn(projects, 'importReferenceAudio');
    const result = await new AudioEditService(projects).mix(join(directory, 'show.tblink'), tracks);
    expect(result.relativePath).toBe(source.relativePath);
    expect(result.sha256).toBe(source.sha256);
    expect(result.timeline?.tracks).toEqual(tracks);
    expect(imported).not.toHaveBeenCalled();
    await expect(readdir(join(directory, 'cache', 'audio-edit'))).rejects.toThrow();
    await writeFile(join(directory, 'source.wav'), stereoWav(1, 2));
    await expect(new AudioEditService(projects).mix(join(directory, 'show.tblink'), tracks)).rejects.toThrow('音频源文件已改变');
  } finally { await cleanOwnedFixture(directory); }
});

it('源文件实际长于声明范围时仍裁剪渲染，不把多余尾音带入节目', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-pcm-subrange-'));
  try {
    const buffer = stereoWav(1000, 2000); await writeFile(join(directory, 'source.wav'), buffer);
    const source = { assetId: 'sound', relativePath: 'source.wav', sha256: createHash('sha256').update(buffer).digest('hex'), durationMs: 150 };
    const result = await new AudioEditService(new LinkProjectService()).mix(join(directory, 'show.tblink'),
      [{ id: 'track', title: '原声', source, segments: [{ id: 'segment', startMs: 0, sourceOffsetMs: 0, durationMs: 150 }] }]);
    expect(result.relativePath).not.toBe(source.relativePath);
    expect(await readExtractedAudioDuration(join(directory, result.relativePath))).toBe(150);
  } finally { await cleanOwnedFixture(directory); }
});

it('单轨 PCM 直接裁剪保留入点、左右声道、满幅和真实静音间隔', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-pcm-edit-'));
  try {
    const buffer = stereoWav(32767, -32768); await writeFile(join(directory, 'source.wav'), buffer);
    const source = { assetId: 'sound', relativePath: 'source.wav', sha256: createHash('sha256').update(buffer).digest('hex'), durationMs: 300 };
    const segments = [{ id: 'first', startMs: 20, sourceOffsetMs: 50, durationMs: 30 }, { id: 'second', startMs: 100, sourceOffsetMs: 200, durationMs: 50 }];
    const result = await new AudioEditService(new LinkProjectService()).mix(join(directory, 'show.tblink'), [{ id: 'track', title: '原声', source, segments }]);
    const wav = await readFile(join(directory, result.relativePath));
    const expected = Buffer.concat([Buffer.alloc(20 * 192), buffer.subarray(44 + 50 * 192, 44 + 80 * 192), Buffer.alloc(50 * 192), buffer.subarray(44 + 200 * 192, 44 + 250 * 192)]);
    expect(wav.subarray(44)).toEqual(expected);
    expect(await readExtractedAudioDuration(join(directory, result.relativePath))).toBe(150);
    expect(result.timeline?.tracks?.[0]?.segments).toEqual(segments);
    expect(await readdir(join(directory, 'cache', 'audio-edit'))).toEqual([]);
  } finally { await cleanOwnedFixture(directory); }
});

it('相同内容和编排跨服务复用，轨道身份不复用；更改位置重新生成，损坏缓存不接受', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-mix-reuse-'));
  try {
    const buffer = stereoWav(1000, 2000); await writeFile(join(directory, 'source.wav'), buffer);
    const source = { assetId: 'source', relativePath: 'source.wav', sha256: createHash('sha256').update(buffer).digest('hex'), durationMs: 300 };
    const tracks = [{ id: 'track', title: '原声', source, segments: [{ id: 'segment', startMs: 10, sourceOffsetMs: 20, durationMs: 100 }] }];
    const project = join(directory, 'show.tblink');
    const first = await new AudioEditService(new LinkProjectService()).mix(project, tracks);
    const projects = new LinkProjectService(); const imported = vi.spyOn(projects, 'importReferenceAudio');
    const renamed = tracks.map(track => ({ ...track, id: 'new-track', title: '新名称', segments: track.segments.map(segment => ({ ...segment, id: 'new-segment' })) }));
    const second = await new AudioEditService(projects).mix(project, renamed);
    expect(second.relativePath).toBe(first.relativePath); expect(imported).not.toHaveBeenCalled();
    expect(second.timeline?.tracks).toEqual(renamed);
    const moved = await new AudioEditService(projects).mix(project, tracks.map(track => ({ ...track, segments: track.segments.map(segment => ({ ...segment, startMs: 20 })) })));
    expect(moved.relativePath).not.toBe(first.relativePath);
    await writeFile(join(directory, second.relativePath), 'corrupted');
    await expect(new AudioEditService(projects).mix(project, tracks)).rejects.toThrow('音频源文件已改变');
  } finally { await cleanOwnedFixture(directory); }
});

async function cleanOwnedFixture(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await cleanOwnedFixture(path); else await unlink(path);
  }
  await rmdir(directory);
}

it('真实 FFmpeg 混合两条独立音轨，保留声道、增益、素材入点和时间线间隙', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-mix-'));
  try {
    const sources = await Promise.all([[1000, 0], [0, 2000]].map(async (levels, index) => {
      const buffer = stereoWav(levels[0]!, levels[1]!);
      const name = `source-${index}.wav`; await writeFile(join(directory, name), buffer);
      return { assetId: name, relativePath: name, durationMs: 300, sha256: createHash('sha256').update(buffer).digest('hex') };
    }));
    const service = new AudioEditService(new LinkProjectService());
    const tracks = sources.map((source, index) => ({ id: `track-${index}`, title: source.assetId, source, segments: [{ id: `clip-${index}`, startMs: index * 100, sourceOffsetMs: index * 50, durationMs: index ? 100 : 300 }] }));
    const result = await service.mix(join(directory, 'show.tblink'), tracks);
    const wav = await readFile(join(directory, result.relativePath));
    const offset = wav.indexOf(Buffer.from('data')) + 8;
    const sample = (ms: number, channel: number): number => wav.readInt16LE(offset + ms * 192 + channel * 2);
    expect(result.durationMs).toBe(300);
    expect(result.timeline?.tracks).toEqual(tracks);
    expect(sample(50, 0)).toBeCloseTo(1000, 0);
    expect(sample(50, 1)).toBe(0);
    expect(sample(150, 0)).toBeCloseTo(1000, 0);
    expect(sample(150, 1)).toBeCloseTo(2000, 0);
    expect(sample(250, 1)).toBe(0);
    expect(await readdir(join(directory, 'cache', 'audio-edit'))).toEqual([]);
  } finally { await cleanOwnedFixture(directory); }
}, 30000);

it.each([[32167, 32158], [33200, 33133], [65300, 65248], [46718, 46763]])('P1 声明 %s ms、采样 %s ms 保持原长度，仅对齐尾部', async (expected, actual) => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-p1-tail-'));
  try {
    const path = join(directory, 'tail.wav');
    const header = stereoWav(1000, 1000).subarray(0, 44);
    const pcm = Buffer.alloc(actual * 192, 1);
    header.writeUInt32LE(36 + pcm.length, 4); header.writeUInt32LE(pcm.length, 40);
    await writeFile(path, Buffer.concat([header, pcm]));
    await alignExtractedAudioDuration(path, expected, 250);
    expect(await readExtractedAudioDuration(path)).toBe(expected);
    const result = await readFile(path);
    expect(result.length).toBe(44 + expected * 192);
    expect(result.subarray(44, 44 + Math.min(actual, expected) * 192).equals(pcm.subarray(0, Math.min(actual, expected) * 192))).toBe(true);
    if (expected > actual) expect(result.subarray(44 + actual * 192).every(byte => byte === 0)).toBe(true);
  } finally { await cleanOwnedFixture(directory); }
});
it('真实 MP4 的 AAC 尾差在 P1 导入时补齐静音，非零裁剪逐采样精确', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-p1-aac-'));
  try {
    if (!ffmpegPath) throw new Error('测试缺少 FFmpeg');
    const video = join(directory, 'source.mp4');
    await promisify(execFile)(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=s=64x64:r=30:d=44.733', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=44.666', '-c:v', 'mpeg4', '-c:a', 'aac', video], { windowsHide: true });
    const source = await new LinkProjectService().importReferenceAudio(join(directory, 'show.tblink'), video, 44733, 0, true);
    expect(source.durationMs).toBe(44733);
    expect(await readExtractedAudioDuration(join(directory, source.relativePath))).toBe(44733);
    const cut = join(directory, 'cut.wav');
    await extractReferenceAudioTrack(video, cut, { startMs: 1250, durationMs: 1003 });
    expect(await readExtractedAudioDuration(cut)).toBe(1003);
    await expect(extractReferenceAudioTrack(video, cut, { startMs: 0, durationMs: 46000, tailToleranceMs: 250 })).rejects.toThrow('未缩短节目');
  } finally { await cleanOwnedFixture(directory); }
}, 30000);
