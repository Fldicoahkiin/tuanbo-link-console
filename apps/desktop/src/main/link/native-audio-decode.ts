import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

export type DecodeResult = { ok: true } | { ok: false; error: Error };
type Options = { executable: string; source: string; output: string; rate: number; baseMs: number; maximumBytes: number };

/** Owns exactly one decoder. Its growing file is only a temporary playback
 * source; a completed and checked cache is published separately. */
export class NativeAudioDecode {
  readonly finished: Promise<DecodeResult>;
  private result: DecodeResult | null = null;
  private cancelled = false;
  private readonly child;

  constructor(private readonly options: Options) {
    this.child = spawn(options.executable, ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-filter_threads', '1', '-n',
      '-readrate', '8', '-readrate_initial_burst', '5', '-ss', String(options.baseMs / 1000), '-i', options.source,
      '-map', '0:a:0', '-vn', '-ac', '2', '-ar', String(options.rate), '-f', 's16le', '-fs', String(options.maximumBytes + 4), options.output],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.finished = new Promise<DecodeResult>(resolve => {
      let diagnostic = '', failure: Error | null = null;
      this.child.stderr.setEncoding('utf8'); this.child.stderr.on('data', (data: string) => { diagnostic = (diagnostic + data).slice(-4096); });
      this.child.stdout.resume();
      this.child.on('error', error => { failure = error; });
      this.child.stdin.on('error', error => { failure = error; });
      this.child.once('close', code => {
        this.result = failure ? { ok: false, error: failure } : code === 0 && !this.cancelled ? { ok: true }
          : { ok: false, error: new Error(this.cancelled ? '音频解码已取消' : `音频解码失败（${code}）：${diagnostic}`) };
        resolve(this.result);
      });
    });
  }

  async readyThrough(bytes: number, signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      if (this.cancelled) throw new Error('音频解码已取消');
      if (this.result && !this.result.ok) throw this.result.error;
      let size = 0;
      try { size = (await stat(this.options.output)).size; }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
      if (size >= bytes) return;
      if (this.result) throw new Error('实际解码音频短于节目播放范围');
      await delay(10, undefined, { signal });
    }
  }

  async cancel(): Promise<void> {
    if (this.result) return;
    if (!this.cancelled) { this.cancelled = true; this.child.stdin.write('q\n'); }
    const deadline = new AbortController();
    try {
      const finished = await Promise.race([this.finished.then(() => true), delay(5000, false, { signal: deadline.signal })]);
      if (!finished) throw new Error('音频解码尚未退出；保留进程，不强杀，也不启动后续解码');
    } finally { deadline.abort(); }
  }

  get wasCancelled(): boolean { return this.cancelled; }
}
