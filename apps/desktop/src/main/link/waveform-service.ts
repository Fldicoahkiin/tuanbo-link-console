import { Worker } from 'node:worker_threads';
import { basename, join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { waveformWorkerRequestSchema, waveformWorkerResultSchema } from './waveform-worker-contract';
import { waveformBucketCount } from './waveform-accumulator';
export { WaveformAccumulator, waveformBucketCount } from './waveform-accumulator';
import { hashFile, type LinkProjectService } from './link-project-service';
import { VerifiedMediaFiles } from './verified-media-files';

const verifiedSources = new VerifiedMediaFiles(hashFile);
/** Song audio and a clip's audio preview are named after the sha256 they belong to; any other name is hashed. */
export async function waveformSourceMatches(path: string, sha256: string): Promise<boolean> {
  return basename(path).startsWith(`${sha256}.`) || await verifiedSources.verify(path, sha256);
}

export class WaveformService {
  private readonly pending = new Map<string, Promise<number[]>>();
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly projects: Pick<LinkProjectService, 'loadWaveformCache' | 'saveWaveformCache'>,
    private readonly decode: typeof decodeWaveform = decodeWaveform,
    private readonly matches: (path: string, sha256: string) => Promise<boolean> = waveformSourceMatches) {}

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
    if (cached?.length === waveformBucketCount(durationMs)) return cached;
    // The cache is kept by the song's sha256, so only that very file may fill it. 2026-11-11 the home
    // player asked with the previous song's link: that song's peaks were saved under the next song.
    if (!await this.matches(sourcePath, sha256)) throw new Error('波形没有生成：读到的不是这首歌的音频。请重新选一下这首歌');
    const peaks = await this.decode(sourcePath, durationMs);
    await this.projects.saveWaveformCache(projectPath, sha256, peaks);
    return peaks;
  }
}

export function decodeWaveform(sourcePath: string, durationMs: number, workerPath = join(__dirname, 'waveform-worker.cjs')): Promise<number[]> {
  if (!ffmpegPath) throw new Error('FFmpeg 运行时未安装');
  const request = waveformWorkerRequestSchema.parse({ version: 1, sourcePath, durationMs, executable: ffmpegPath.replace('app.asar', 'app.asar.unpacked') });
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: request });
    let result: number[] | null = null, failure: Error | null = null;
    worker.on('message', (value: unknown) => {
      try {
        const message = waveformWorkerResultSchema.parse(value);
        if (message.ok) result = message.peaks; else failure = new Error(message.error);
      } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
    });
    worker.on('error', (error: unknown) => { failure = error instanceof Error ? error : new Error(String(error)); });
    worker.on('exit', code => {
      if (failure) reject(failure);
      else if (code !== 0 || !result) reject(new Error(`波形后台任务退出且没有完整结果（${code}）`));
      else resolve(result);
    });
  });
}
