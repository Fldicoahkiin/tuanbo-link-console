import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { watchOutputGrowth } from './ffmpeg-deadline';

export type DecodeResult = { ok: true } | { ok: false; error: Error };
type Options = { executable: string; source: string; output: string; rate: number; baseMs: number; maximumBytes: number };

/** Owns exactly one decoder. Its growing file is only a temporary playback
 * source; a completed and checked cache is published separately. */
export class NativeAudioDecode {
  readonly finished: Promise<DecodeResult>;
  private result: DecodeResult | null = null;
  private cancelled = false;
  private stalled: Error | null = null;
  private readonly child;

  constructor(private readonly options: Options) {
    this.child = spawn(options.executable, ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-filter_threads', '1', '-n',
      '-readrate', '8', '-readrate_initial_burst', '5', '-ss', String(options.baseMs / 1000), '-i', options.source,
      '-map', '0:a:0', '-vn', '-ac', '2', '-ar', String(options.rate), '-f', 's16le', '-fs', String(options.maximumBytes + 4), options.output],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    // A decoder whose file stops growing is stuck (for example a source on a drive that stopped
    // answering): its readers fail at once, and it is asked to quit like a cancel, not ended.
    const stopWatching = watchOutputGrowth(options.output, { intervalMs: 2_000, stallMs: 30_000 }, error => {
      if (this.result || this.cancelled) return;
      this.stalled = new Error('音频解码 30 秒没有进展，已停止解码', { cause: error });
      if (this.child.stdin.writable) this.child.stdin.write('q\n');
    });
    this.finished = new Promise<DecodeResult>(resolve => {
      let diagnostic = '', failure: Error | null = null;
      this.child.stderr.setEncoding('utf8'); this.child.stderr.on('data', (data: string) => { diagnostic = (diagnostic + data).slice(-4096); });
      this.child.stdout.resume();
      this.child.on('error', error => { failure = error; });
      this.child.stdin.on('error', error => { failure = error; });
      this.child.once('close', code => {
        stopWatching();
        this.result = failure ? { ok: false, error: failure } : this.stalled ? { ok: false, error: this.stalled } : code === 0 && !this.cancelled ? { ok: true }
          : { ok: false, error: new Error(this.cancelled ? '音频解码已取消' : `音频解码失败（${code}）：${diagnostic}`) };
        resolve(this.result);
      });
    });
  }

  async readyThrough(bytes: number, signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      if (this.cancelled) throw new Error('音频解码已取消');
      if (this.stalled) throw this.stalled;
      if (this.result && !this.result.ok) throw this.result.error;
      let size = 0;
      try { size = (await stat(this.options.output)).size; }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
      if (size >= bytes) return;
      if (this.result) throw new Error('解码出的音频比节目的播放范围短');
      await delay(10, undefined, { signal });
    }
  }

  async cancel(): Promise<void> {
    if (this.result) return;
    if (!this.cancelled) { this.cancelled = true; this.child.stdin.write('q\n'); }
    const deadline = new AbortController();
    try {
      const finished = await Promise.race([this.finished.then(() => true), delay(5000, false, { signal: deadline.signal })]);
      if (!finished) throw new Error('音频解码还没退出，进程保留，不会强制结束，也不会开始新的解码');
    } finally { deadline.abort(); }
  }

  get wasCancelled(): boolean { return this.cancelled; }
}
