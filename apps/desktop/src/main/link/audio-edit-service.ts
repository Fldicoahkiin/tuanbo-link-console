import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, open, stat, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { AudioBeatDetector } from '@tb/core/link';
import { referenceAudioSchema, type AudioBeatAnalysis, type AudioSegment, type ReferenceAudio } from '@tb/schema';
import type { LinkProjectService } from './link-project-service';

export class AudioEditService {
  constructor(private readonly projects: LinkProjectService) {}

  async analyze(projectPath: string, source: ReferenceAudio): Promise<AudioBeatAnalysis> {
    const path = await this.sourcePath(projectPath, source);
    const detector = new AudioBeatDetector();
    let remainder = Buffer.alloc(0);
    await ffmpeg(['-i', path, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '22050', '-f', 'f32le', 'pipe:1'], (chunk) => {
      const data = remainder.length ? Buffer.concat([remainder, chunk]) : chunk;
      const complete = data.length - data.length % 4;
      for (let offset = 0; offset < complete; offset += 4) detector.push(data.readFloatLE(offset));
      remainder = Buffer.from(data.subarray(complete));
    });
    if (remainder.length) throw new Error('音频节拍解码数据不完整');
    return detector.finish(source.durationMs);
  }

  async render(projectPath: string, source: ReferenceAudio, segments: AudioSegment[]): Promise<ReferenceAudio> {
    const durationMs = Math.max(...segments.map((segment) => segment.startMs + segment.durationMs));
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
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(path)) { const data: unknown = chunk; if (!Buffer.isBuffer(data)) throw new Error('音频源读取格式无效'); digest.update(data); }
    if (digest.digest('hex') !== source.sha256) throw new Error('音频源文件已改变，请重新导入后编辑');
    return path;
  }
}

/** Copy sample-aligned ranges; intentional timeline gaps become actual PCM silence. */
export async function composeAudioPcm(sourcePath: string, outputPath: string, segments: readonly AudioSegment[]): Promise<void> {
  const source = await open(sourcePath, 'r');
  const output = await open(outputPath, 'wx');
  const bytesPerMs = 192; // stereo signed 16-bit at 48 kHz
  const sourceBytes = (await stat(sourcePath)).size;
  const buffer = Buffer.alloc(64 * 1024);
  const silence = Buffer.alloc(buffer.length);
  let timelineBytes = 0;
  try {
    for (const segment of [...segments].sort((a, b) => a.startMs - b.startMs)) {
      const start = segment.startMs * bytesPerMs;
      const length = segment.durationMs * bytesPerMs;
      let position = segment.sourceOffsetMs * bytesPerMs;
      if (start < timelineBytes || position + length > sourceBytes + bytesPerMs) throw new Error('音频片段范围无效或超出已解码音频');
      while (timelineBytes < start) {
        const count = Math.min(silence.length, start - timelineBytes);
        await output.writeFile(silence.subarray(0, count)); timelineBytes += count;
      }
      let remaining = length;
      while (remaining > 0) {
        const count = Math.min(buffer.length, remaining);
        buffer.fill(0, 0, count);
        const { bytesRead } = await source.read(buffer, 0, Math.min(count, Math.max(0, sourceBytes - position)), position);
        if (bytesRead < count && position + count - sourceBytes > bytesPerMs) throw new Error('音频源数据提前结束');
        await output.writeFile(buffer.subarray(0, count));
        position += count; remaining -= count; timelineBytes += count;
      }
    }
  } finally { await source.close(); await output.close(); }
}

function ffmpeg(args: string[], onData?: (data: Buffer) => void): Promise<void> {
  if (!ffmpegPath) throw new Error('FFmpeg 运行时未安装');
  const executable = ffmpegPath.includes('app.asar') ? ffmpegPath.replace('app.asar', 'app.asar.unpacked') : ffmpegPath;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-n', ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
