import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { dirname, join, relative } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { ffmpegDeadline } from './ffmpeg-deadline';
import { analyzeIbtAudio } from './ibt-beat-service';
import { audioTracksEndMs } from '@tb/core/link';
import { audioTracksSchema, referenceAudioSchema, referenceAudioSourceSchema, type AudioBeatAnalysis, type AudioSegment, type AudioTrack, type ReferenceAudio } from '@tb/schema';
import { hashFile, type LinkProjectService } from './link-project-service';
import { referencePcmLayout } from './reference-audio-extractor';
import { VerifiedMediaFiles } from './verified-media-files';
import { writeFileAtomically } from './atomic-file';
import { mixPcmTracks, pcmWaveHeader } from './pcm-track-mixer';

const mixCacheSchema = z.object({ version: z.literal(1), audio: referenceAudioSourceSchema }).strict();

export class AudioEditService {
  private readonly verified = new VerifiedMediaFiles(hashFile);
  private readonly pendingMixes = new Map<string, Promise<ReferenceAudio>>();
  constructor(private readonly projects: LinkProjectService, private readonly beatExecutable?: string) {}

  /** `songMs`: the song's length when it lasts past its last segment (silence after the music, 0.5.9 E13); left out,
   * the song ends with its music, as before. */
  async mix(projectPath: string, input: AudioTrack[], songMs?: number): Promise<ReferenceAudio> {
    const tracks = audioTracksSchema.parse(input);
    const expectedMs = songMs ?? audioTracksEndMs(tracks);
    if (!Number.isSafeInteger(expectedMs) || expectedMs < audioTracksEndMs(tracks)) throw new Error('歌曲总长比最后一段音频还短');
    // Every referenced path is verified even when another asset with the same
    // content already prepared this mix. IDs and titles do not alter samples.
    for (const track of tracks) await this.sourcePath(projectPath, track.source);
    const manifest = join(dirname(projectPath), 'cache', 'audio-mixes', `${mixCacheKey(tracks, songMs)}.json`);
    let operation = this.pendingMixes.get(manifest);
    if (!operation) {
      operation = this.cachedMix(projectPath, tracks, manifest, songMs).finally(() => this.pendingMixes.delete(manifest));
      this.pendingMixes.set(manifest, operation);
    }
    const audio = referenceAudioSourceSchema.parse(await operation);
    if (audio.durationMs !== expectedMs) throw new Error('音轨缓存的时长和当前编排对不上');
    const rendered = { ...audio, assetId: crypto.randomUUID() };
    return referenceAudioSchema.parse({ ...rendered, timeline: { source: rendered,
      segments: [{ id: `mix-${rendered.assetId}`, startMs: 0, sourceOffsetMs: 0, durationMs: rendered.durationMs }], tracks,
      ...(songMs === undefined ? {} : { durationMs: songMs }) } });
  }

  private async cachedMix(projectPath: string, tracks: AudioTrack[], manifest: string, songMs: number | undefined): Promise<ReferenceAudio> {
    let content: string | null;
    try { content = await readFile(manifest, 'utf8'); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      content = null;
    }
    if (content !== null) {
      const entry = mixCacheSchema.parse(JSON.parse(content));
      await this.sourcePath(projectPath, entry.audio);
      return entry.audio;
    }
    const audio = await this.renderMix(projectPath, tracks, songMs);
    for (const track of tracks) await this.sourcePath(projectPath, track.source);
    await this.sourcePath(projectPath, audio);
    await writeFileAtomically(manifest, JSON.stringify(mixCacheSchema.parse({ version: 1, audio })));
    return audio;
  }

  private async renderMix(projectPath: string, tracks: AudioTrack[], songMs: number | undefined): Promise<ReferenceAudio> {
    const track = tracks.length === 1 ? tracks[0] : undefined;
    const segment = track?.segments.length === 1 ? track.segments[0] : undefined;
    // The song's length: its music, plus any silence after it, which the WAV holds as samples of 0.
    const durationMs = songMs ?? audioTracksEndMs(tracks);
    if (track) {
      const path = await this.sourcePath(projectPath, track.source);
      const layout = await referencePcmLayout(path);
      // The source file itself, as every song without edits plays it: one whole segment from 0 and no silence after it.
      if (layout && segment && segment.startMs === 0 && segment.sourceOffsetMs === 0 && segment.durationMs === track.source.durationMs
        && Math.floor(layout.bytes / 192) === track.source.durationMs && durationMs === track.source.durationMs) {
        return referenceAudioSchema.parse({ ...track.source, timeline: { source: track.source, segments: track.segments, tracks } });
      }
      if (layout && durationMs * 192 + 36 <= 0xffffffff) {
        const directory = join(dirname(projectPath), 'cache', 'audio-edit');
        await mkdir(directory, { recursive: true });
        const output = join(directory, `${crypto.randomUUID()}.wav`);
        try {
          await composeAudioPcm(path, output, track.segments, { ...layout, durationMs });
          const rendered = await this.publishPcm(projectPath, output, durationMs);
          return referenceAudioSchema.parse({ ...rendered, timeline: { source: rendered,
            segments: [{ id: `mix-${rendered.assetId}`, startMs: 0, sourceOffsetMs: 0, durationMs }], tracks } });
        } finally {
          try { await unlink(output); }
          catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
        }
      }
    }
    const directory = join(dirname(projectPath), 'cache', 'audio-edit');
    await mkdir(directory, { recursive: true });
    const token = crypto.randomUUID();
    const cleanup: string[] = [];
    const inputs: string[] = [];
    try {
      if (tracks.length > 1 && durationMs * 192 + 36 <= 0xffffffff) {
        const pcm = [];
        for (const track of tracks) {
          const path = await this.sourcePath(projectPath, track.source);
          const layout = await referencePcmLayout(path);
          if (!layout) break;
          pcm.push({ path, ...layout, segments: track.segments });
        }
        if (pcm.length === tracks.length) {
          const output = join(directory, `${token}-direct.wav`);
          cleanup.push(output);
          if (await mixPcmTracks(pcm, output, durationMs) === 'complete') {
            return await this.publishPcm(projectPath, output, durationMs);
          }
        }
      }
      for (const [index, track] of tracks.entries()) {
        const path = await this.sourcePath(projectPath, track.source);
        const raw = join(directory, `${token}-${index}-source.pcm`);
        const edit = join(directory, `${token}-${index}-edit.pcm`);
        cleanup.push(edit);
        const layout = await referencePcmLayout(path);
        // Every track lasts the whole song, so the mix (amix, duration=longest) does too, silence after the music included.
        if (layout) await composeAudioPcm(path, edit, track.segments, layout, durationMs);
        else {
          cleanup.push(raw);
          await ffmpeg(['-i', path, '-map', '0:a:0', '-vn', '-ac', '2', '-ar', '48000', '-f', 's16le', raw]);
          await composeAudioPcm(raw, edit, track.segments, undefined, durationMs);
        }
        inputs.push('-f', 's16le', '-ar', '48000', '-ac', '2', '-i', edit);
      }
      const output = join(directory, `${token}-mix.wav`);
      cleanup.push(output);
      // Preserve single-track gain; only limit overlapping peaks, with latency
      // compensation so the mixed output remains aligned with lighting cues.
      await ffmpeg([...inputs, '-filter_complex', `amix=inputs=${tracks.length}:duration=longest:normalize=0,alimiter=limit=0.98:level=0:latency=1`, '-c:a', 'pcm_s16le', '-rf64', 'auto', output]);
      const rendered = await this.publishPcm(projectPath, output, durationMs);
      return referenceAudioSchema.parse({ ...rendered, timeline: { source: rendered, segments: [{ id: `mix-${rendered.assetId}`, startMs: 0, sourceOffsetMs: 0, durationMs }], tracks } });
    } finally {
      await Promise.all(cleanup.map(async file => { try { await unlink(file); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; } }));
    }
  }

  async analyze(projectPath: string, source: ReferenceAudio): Promise<AudioBeatAnalysis> {
    const path = await this.sourcePath(projectPath, source);
    return analyzeIbtAudio(path, source.durationMs, (input, output) => ffmpeg(['-i', input, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', output]), this.beatExecutable);
  }

  /** This service produced the temporary WAV in this project. Publish it with
   * a rename, rather than importing/copying the entire new mix a second time. */
  private async publishPcm(projectPath: string, output: string, durationMs: number): Promise<ReferenceAudio> {
    const digest = await this.verified.digest(output);
    const directory = join(dirname(projectPath), 'assets', 'reference-audio');
    await mkdir(directory, { recursive: true });
    const destination = join(directory, `${digest}.wav`);
    let exists: boolean;
    try { await stat(destination); exists = true; }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      exists = false;
    }
    if (exists) {
      if (!await this.verified.verify(destination, digest)) throw new Error('已有的混音文件校验失败，没有覆盖原文件');
    } else await rename(output, destination);
    return referenceAudioSchema.parse({ assetId: crypto.randomUUID(), relativePath: relative(dirname(projectPath), destination).replaceAll('\\', '/'), sha256: digest, durationMs });
  }

  async render(projectPath: string, source: ReferenceAudio, segments: AudioSegment[]): Promise<ReferenceAudio> {
    const durationMs = audioTracksEndMs([{ segments }]);
    referenceAudioSchema.parse({ ...source, durationMs, beats: undefined, timeline: { source, segments } });
    const path = await this.sourcePath(projectPath, source);
    const directory = join(dirname(projectPath), 'cache', 'audio-edit');
    await mkdir(directory, { recursive: true });
    const token = crypto.randomUUID();
    const rawSource = join(directory, `${token}-source.pcm`);
    const rawEdit = join(directory, `${token}-edit.pcm`);
    const output = join(directory, `${token}.wav`);
    await ffmpeg(['-i', path, '-map', '0:a:0', '-vn', '-ac', '2', '-ar', '48000', '-f', 's16le', rawSource]);
    await composeAudioPcm(rawSource, rawEdit, segments);
    await ffmpeg(['-f', 's16le', '-ar', '48000', '-ac', '2', '-i', rawEdit, '-c:a', 'pcm_s16le', '-rf64', 'auto', output]);
    const imported = await this.projects.importReferenceAudio(projectPath, output, durationMs);
    await Promise.all([rawSource, rawEdit, output].map((file) => unlink(file)));
    return imported;
  }

  private async sourcePath(projectPath: string, source: ReferenceAudio): Promise<string> {
    const path = this.projects.resolveReferenceAudio(projectPath, source.relativePath);
    if (!await this.verified.verify(path, source.sha256)) throw new Error('音频源文件已改变，请重新导入后编辑');
    return path;
  }
}

/** The cache name of a mix: the samples it is made of, and the song's length when it lasts past its music. A song
 * without that length keeps the name it had before 0.5.9, so the mixes already rendered are found again. */
export function mixCacheKey(tracks: readonly AudioTrack[], songMs: number | undefined): string {
  const parts = tracks.map(track => ({ source: track.source.sha256,
    durationMs: track.source.durationMs, segments: track.segments.map(({ startMs, sourceOffsetMs, durationMs }) => ({ startMs, sourceOffsetMs, durationMs })) }));
  return createHash('sha256').update(JSON.stringify(songMs === undefined ? parts : { tracks: parts, durationMs: songMs })).digest('hex');
}

/** Copy sample-aligned ranges; intentional timeline gaps become actual PCM silence, and so does the time after the
 * last segment up to `lengthMs` (the WAV header's length when there is one). */
export async function composeAudioPcm(sourcePath: string, outputPath: string, segments: readonly AudioSegment[],
  wav?: { offset: number; bytes: number; durationMs?: number }, lengthMs = wav?.durationMs): Promise<void> {
  const source = await open(sourcePath, 'r');
  const output = await open(outputPath, 'wx');
  const bytesPerMs = 192; // stereo signed 16-bit at 48 kHz
  const sourceBytes = wav?.bytes ?? (await stat(sourcePath)).size;
  const buffer = Buffer.alloc(64 * 1024);
  const silence = Buffer.alloc(buffer.length);
  let timelineBytes = 0;
  try {
    if (wav?.durationMs) await output.writeFile(pcmWaveHeader(wav.durationMs));
    for (const segment of [...segments].sort((a, b) => a.startMs - b.startMs)) {
      const start = segment.startMs * bytesPerMs;
      const length = segment.durationMs * bytesPerMs;
      let position = segment.sourceOffsetMs * bytesPerMs;
      if (start < timelineBytes || position + length > sourceBytes + bytesPerMs) throw new Error('音频片段的范围无效，或超出了音频长度');
      while (timelineBytes < start) {
        const count = Math.min(silence.length, start - timelineBytes);
        await output.writeFile(silence.subarray(0, count)); timelineBytes += count;
      }
      let remaining = length;
      while (remaining > 0) {
        const count = Math.min(buffer.length, remaining);
        buffer.fill(0, 0, count);
        const { bytesRead } = await source.read(buffer, 0, Math.min(count, Math.max(0, sourceBytes - position)), position + (wav?.offset ?? 0));
        if (bytesRead < count && position + count - sourceBytes > bytesPerMs) throw new Error('音频文件提前结束了，可能已损坏');
        await output.writeFile(buffer.subarray(0, count));
        position += count; remaining -= count; timelineBytes += count;
      }
    }
    if (lengthMs !== undefined) {
      const end = lengthMs * bytesPerMs;
      if (timelineBytes > end) throw new Error('音频片段超出了歌曲总长');
      while (timelineBytes < end) {
        const count = Math.min(silence.length, end - timelineBytes);
        await output.writeFile(silence.subarray(0, count)); timelineBytes += count;
      }
    }
  } finally { await source.close(); await output.close(); }
}

function ffmpeg(args: string[], onData?: (data: Buffer) => void): Promise<void> {
  if (!ffmpegPath) throw new Error('缺少 FFmpeg 组件，请重新安装联动台');
  const executable = ffmpegPath.includes('app.asar') ? ffmpegPath.replace('app.asar', 'app.asar.unpacked') : ffmpegPath;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-n', ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    ffmpegDeadline(child, '处理音频', 15 * 60_000, reject);
    let errorOutput = '';
    let failure: Error | null = null;
    child.stdout.on('data', (data: Buffer) => { try { onData?.(data); } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); } });
    child.stdout.on('error', reject); child.stderr.on('error', reject);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (data: string) => { errorOutput = (errorOutput + data).slice(-8000); });
    child.on('error', reject);
    child.on('close', (code) => { if (failure) reject(failure); else if (code !== 0) reject(new Error(`音频处理失败（${String(code)}）：${errorOutput || '没有错误输出'}`)); else resolve(); });
  });
}
