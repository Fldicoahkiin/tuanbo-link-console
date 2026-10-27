import { stat } from 'node:fs/promises';
import type { PlaybackSnapshot } from '@tb/schema';
import type { NativeAudioCache, NativeAudioLease } from './native-audio-cache';

type Identity = { size: number; mtimeMs: number; ctimeMs: number; ino: number };
type Prepared = { lease: NativeAudioLease; identity: Identity };
type Task = { projectPath: string; sourcePath: string; snapshot: PlaybackSnapshot; abort: AbortController;
  result: Prepared | null; promise: Promise<Prepared | null>; consumed: boolean; cleanup: Promise<void> | null };
type Options = { cache: Pick<NativeAudioCache, 'prepare'>; resolveAudio: (projectPath: string, relativePath: string) => string;
  error: (message: string) => void; measured?: (phase: string, elapsedMs: number) => void };

/** One pinned next-source lease. This never controls an audio/MIDI device or
 * starts output. The current player owns its separate lease throughout. */
export class NativeAudioPreload {
  private task: Task | null = null;
  constructor(private readonly options: Options) {}

  start(projectPath: string, snapshot: PlaybackSnapshot): void {
    if (this.task) return; // A pause/resume cannot duplicate the one pending job.
    const task: Task = { projectPath, sourcePath: '', snapshot, abort: new AbortController(), result: null,
      promise: Promise.resolve(null), consumed: false, cleanup: null };
    this.task = task;
    task.promise = this.prepare(task).catch(error => {
      if (!task.abort.signal.aborted) this.options.error(`预先准备下一首音频失败：${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
  }

  async take(projectPath: string, snapshot: PlaybackSnapshot): Promise<NativeAudioLease | null> {
    const started = performance.now();
    const task = this.task;
    if (!task) return null;
    const matches = task.projectPath === projectPath && audioIdentity(task.snapshot) === audioIdentity(snapshot);
    // Do not wait for an unfinished background decode at a user playback boundary.
    if (!matches || !task.result) { await this.cancel(); return null; }
    const actual = await stat(task.sourcePath);
    if (this.task !== task || task.abort.signal.aborted) return null;
    if (!sameIdentity(actual, task.result.identity)) {
      await this.cancel(); throw new Error('预先准备好的音频原文件变了，请重新导入；旧音频不会被使用');
    }
    task.consumed = true; this.task = null;
    this.options.measured?.('使用预先准备的下一首音频', performance.now() - started);
    return task.result.lease;
  }

  async cancel(): Promise<void> {
    const task = this.task;
    if (!task) return;
    task.abort.abort();
    task.cleanup ??= task.promise.then(async result => { if (result && !task.consumed) await result.lease.release(); });
    await task.cleanup;
    if (this.task === task) this.task = null;
  }

  private async prepare(task: Task): Promise<Prepared> {
    task.sourcePath = this.options.resolveAudio(task.projectPath, task.snapshot.audio.relativePath);
    const started = performance.now(), before = await stat(task.sourcePath), snapshot = task.snapshot;
    const lease = await this.options.cache.prepare({ sourcePath: task.sourcePath, sourceSha256: snapshot.audio.sha256,
      expectedDurationMs: snapshot.audio.durationMs, sampleRate: snapshot.sampleRate, positionMs: snapshot.positionMs }, task.abort.signal);
    try {
      const after = await stat(task.sourcePath);
      if (!sameIdentity(before, after)) throw new Error('预先准备音频时文件发生了变化');
      const result = { lease, identity: after };
      task.result = result;
      this.options.measured?.('预先准备下一首音频', performance.now() - started);
      void lease.completion.then(outcome => {
        if (!outcome.ok && this.task === task && !task.abort.signal.aborted && !task.consumed) {
          task.result = null; this.options.error(`下一首音频解码失败：${outcome.error.message}`);
        }
      });
      return result;
    } catch (error) { await lease.release(); throw error; }
  }
}

function sameIdentity(a: Identity, b: Identity): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino;
}

function audioIdentity(snapshot: PlaybackSnapshot): string {
  return JSON.stringify([snapshot.projectId, snapshot.itemId, snapshot.revision, snapshot.audio.relativePath,
    snapshot.audio.sha256, snapshot.audio.durationMs, snapshot.sampleRate, snapshot.positionMs]);
}
