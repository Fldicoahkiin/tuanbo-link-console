import { Worker } from 'node:worker_threads';
import { basename, join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { waveformWorkerRequestSchema, waveformWorkerResultSchema } from './waveform-worker-contract';
import { waveformBucketCount } from './waveform-accumulator';
export { WaveformAccumulator, waveformBucketCount } from './waveform-accumulator';
import { decodeWaveformFile, encodeWaveformFile, waveformFromBase, waveformFromLegacyPeaks, type WaveformBase } from './waveform-levels';
import { hashFile, type LinkProjectService } from './link-project-service';
import { VerifiedMediaFiles } from './verified-media-files';
import type { LinkWaveform, LinkWaveformResult } from '@tb/schema';

/** One decode: the 0.5.8 cache (`<sha>.json`, absolute peaks) and the finest level of the waveform (`<sha>.levels.bin`). */
export type DecodedWaveform = { peaks: number[]; base: WaveformBase };

const verifiedSources = new VerifiedMediaFiles(hashFile);
/** Song audio and a clip's audio preview are named after the sha256 they belong to; any other name is hashed. */
export async function waveformSourceMatches(path: string, sha256: string): Promise<boolean> {
  return basename(path).startsWith(`${sha256}.`) || await verifiedSources.verify(path, sha256);
}

export class WaveformService {
  private readonly pending = new Map<string, Promise<LinkWaveformResult>>();
  /** Rebuilds of an old cache that failed, by project and song; kept until the app is started again. A new
   * audio file is a new sha256, so it is tried afresh. */
  private readonly failedRebuilds = new Map<string, string>();
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly projects: Pick<LinkProjectService, 'loadWaveformCache' | 'saveWaveformCache' | 'loadWaveformLevels' | 'saveWaveformLevels'>,
    private readonly decode: typeof decodeWaveform = decodeWaveform,
    private readonly matches: (path: string, sha256: string) => Promise<boolean> = waveformSourceMatches,
    private readonly reportRebuildFailure: (sha256: string, message: string) => void = () => undefined) {}

  ensure(projectPath: string, sourcePath: string, sha256: string, durationMs: number, rebuild: boolean): Promise<LinkWaveformResult> {
    const key = JSON.stringify([projectPath, sourcePath, sha256, durationMs, rebuild]);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const pending = this.tail.then(() => this.generate(projectPath, sourcePath, sha256, durationMs, rebuild)).finally(() => this.pending.delete(key));
    // A failed request is returned to its caller; independent later requests may proceed.
    this.tail = pending.then(() => undefined, () => undefined);
    this.pending.set(key, pending);
    return pending;
  }

  private async generate(projectPath: string, sourcePath: string, sha256: string, durationMs: number, rebuild: boolean): Promise<LinkWaveformResult> {
    const levels = await this.projects.loadWaveformLevels(projectPath, sha256);
    const base = levels ? decodeWaveformFile(levels, sha256, durationMs) : null;
    // Only this app writes levels, after checking the decoded file against the sha256 (decodeVerified).
    if (base) return { state: 'verified', waveform: waveformFromBase(base) };
    const cached = await this.projects.loadWaveformCache(projectPath, sha256);
    if (cached?.peaks.length === waveformBucketCount(durationMs)) {
      // A cache without levels: written by 0.5.8 (it may hold another song's peaks, the home player asked
      // with the previous song's link before 2026-11-11) or by a 0.5.9 before the levels. It is shown at once
      // and generated once from this song's file; a failed rebuild keeps it and is not retried in this run.
      const shown = waveformFromLegacyPeaks(cached.peaks, durationMs);
      const failedKey = JSON.stringify([projectPath, sha256]);
      const failure = this.failedRebuilds.get(failedKey);
      if (failure !== undefined) return { state: 'rebuild-failed', waveform: shown, error: failure };
      if (!rebuild) return { state: 'unverified', waveform: shown };
      try {
        return { state: 'verified', waveform: await this.decodeVerified(projectPath, sourcePath, sha256, durationMs) };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const message = `这首歌的波形可能不完整，重新生成没有成功，先显示之前保存的波形。重启联动台或更换这首歌的音频后会再试一次。原因：${reason}`;
        this.failedRebuilds.set(failedKey, message);
        this.reportRebuildFailure(sha256, message);
        return { state: 'rebuild-failed', waveform: shown, error: message };
      }
    }
    return { state: 'verified', waveform: await this.decodeVerified(projectPath, sourcePath, sha256, durationMs) };
  }

  private async decodeVerified(projectPath: string, sourcePath: string, sha256: string, durationMs: number): Promise<LinkWaveform> {
    // The cache is kept by the song's sha256, so only that very file may fill it. 2026-11-11 the home
    // player asked with the previous song's link: that song's peaks were saved under the next song.
    if (!await this.matches(sourcePath, sha256)) throw new Error('波形没有生成：读到的不是这首歌的音频。请重新选一下这首歌');
    const { peaks, base } = await this.decode(sourcePath, durationMs);
    // The 0.5.8 cache first: a stop between the two writes leaves no levels, so the song is generated again.
    await this.projects.saveWaveformCache(projectPath, sha256, peaks, true);
    await this.projects.saveWaveformLevels(projectPath, sha256, encodeWaveformFile(sha256, base));
    return waveformFromBase(base);
  }
}

export function decodeWaveform(sourcePath: string, durationMs: number, workerPath = join(__dirname, 'waveform-worker.cjs')): Promise<DecodedWaveform> {
  if (!ffmpegPath) throw new Error('FFmpeg 运行时未安装');
  const request = waveformWorkerRequestSchema.parse({ version: 2, sourcePath, durationMs, executable: ffmpegPath.replace('app.asar', 'app.asar.unpacked') });
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: request });
    let result: DecodedWaveform | null = null, failure: Error | null = null;
    worker.on('message', (value: unknown) => {
      try {
        const message = waveformWorkerResultSchema.parse(value);
        if (message.ok) result = { peaks: message.peaks, base: message.base }; else failure = new Error(message.error);
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
