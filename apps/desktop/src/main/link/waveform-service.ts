import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import type { LinkProjectService } from './link-project-service';

/** Streaming PCM reduction: retain only one incomplete float and the output peaks. */
export class WaveformAccumulator {
  readonly peaks: number[];
  private remainder = Buffer.alloc(0);
  private sample = 0;
  private bucket = 0;
  private invalid = false;

  constructor(private readonly sampleCount: number, buckets = 2400) {
    if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0 || !Number.isSafeInteger(buckets) || buckets <= 0) throw new Error('波形采样范围无效');
    this.peaks = Array.from({ length: buckets }, () => 0);
  }

  push(chunk: Buffer): void {
    const data = this.remainder.length ? Buffer.concat([this.remainder, chunk]) : chunk;
    const complete = data.length - data.length % 4;
    for (let offset = 0; offset < complete; offset += 4) {
      const value = data.readFloatLE(offset);
      while (this.bucket < this.peaks.length - 1 && this.sample >= Math.floor((this.bucket + 1) * this.sampleCount / this.peaks.length)) this.bucket += 1;
      if (!Number.isFinite(value)) this.invalid = true;
      else this.peaks[this.bucket] = Math.max(this.peaks[this.bucket]!, Math.min(1, Math.abs(value)));
      this.sample += 1;
    }
    this.remainder = Buffer.from(data.subarray(complete));
  }

  finish(): number[] {
    if (this.remainder.length || this.invalid || !this.sample) throw new Error('波形解码未返回完整有效的音频采样');
    return this.peaks;
  }
}

export class WaveformService {
  private readonly pending = new Map<string, Promise<number[]>>();
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly projects: Pick<LinkProjectService, 'loadWaveformCache' | 'saveWaveformCache'>,
    private readonly decode: typeof decodeWaveform = decodeWaveform) {}

  ensure(projectPath: string, sourcePath: string, sha256: string, durationMs: number): Promise<number[]> {
    const key = JSON.stringify([projectPath, sourcePath, sha256, durationMs]);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const pending = this.tail.then(() => this.generate(projectPath, sourcePath, sha256, durationMs)).finally(() => this.pending.delete(key));
    // A failed request is returned to its caller; independent later requests may proceed.
    this.tail = pending.then(() => undefined, () => undefined);
    this.pending.set(key, pending);
    return pending;
  }

  private async generate(projectPath: string, sourcePath: string, sha256: string, durationMs: number): Promise<number[]> {
    const cached = await this.projects.loadWaveformCache(projectPath, sha256);
    if (cached) return cached;
    const peaks = await this.decode(sourcePath, durationMs);
    await this.projects.saveWaveformCache(projectPath, sha256, peaks);
    return peaks;
  }
}

export function decodeWaveform(sourcePath: string, durationMs: number): Promise<number[]> {
  if (!ffmpegPath) throw new Error('FFmpeg 运行时未安装');
  const executable = ffmpegPath.includes('app.asar') ? ffmpegPath.replace('app.asar', 'app.asar.unpacked') : ffmpegPath;
  const accumulator = new WaveformAccumulator(Math.round(durationMs * 48));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-i', sourcePath,
      '-map', '0:a:0', '-vn', '-af', 'pan=mono|c0=c0', '-ar', '48000', '-f', 'f32le', 'pipe:1'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let errorOutput = '';
    child.stdout.on('data', (chunk: Buffer) => accumulator.push(chunk));
    child.stdout.on('error', reject);
    child.stderr.on('error', reject);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { errorOutput = (errorOutput + chunk).slice(-8000); });
    child.on('error', (error) => reject(new Error(`波形解码启动失败：${error.message}`, { cause: error })));
    child.on('close', (code) => {
      if (code !== 0) { reject(new Error(`波形解码失败（${String(code)}）：${errorOutput.trim() || '没有错误输出'}`)); return; }
      try { resolve(accumulator.finish()); } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
    });
  });
}
