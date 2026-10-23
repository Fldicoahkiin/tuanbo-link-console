import type { ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';

/**
 * Bounds one FFmpeg run. When `timeoutMs` passes, `fail` receives an error
 * naming the work and FFmpeg is asked to quit ('q' on stdin); a run that has
 * still not exited 5 seconds later is ended. These are the program's own
 * helper processes, not the operator's external programs.
 */
export function ffmpegDeadline(child: ChildProcess, work: string, timeoutMs: number, fail: (error: Error) => void): void {
  let ending: NodeJS.Timeout | undefined;
  const deadline = setTimeout(() => {
    fail(new Error(`${work}超过 ${describe(timeoutMs)}仍未完成，已停止 FFmpeg`));
    if (child.stdin?.writable) child.stdin.write('q\n');
    ending = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); }, 5_000);
  }, timeoutMs);
  child.once('close', () => { clearTimeout(deadline); clearTimeout(ending); });
}

/**
 * For an FFmpeg run that streams into a file over a long time (playback decoding): calls `stalled`
 * once when the file has not grown for `stallMs`. Returns a function that stops watching.
 */
export function watchOutputGrowth(output: string, timing: { intervalMs: number; stallMs: number }, stalled: (error: Error) => void): () => void {
  let size = -1, since = Date.now(), checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    void stat(output).then(file => file.size, (error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 0;
      throw error;
    }).then(next => {
      if (next > size) { size = next; since = Date.now(); return; }
      if (Date.now() - since < timing.stallMs) return;
      clearInterval(timer);
      stalled(new Error(`FFmpeg 输出超过 ${describe(timing.stallMs)}没有增长，判定为卡住：${output}`));
    }, (error: unknown) => {
      clearInterval(timer);
      stalled(new Error(`无法检查 FFmpeg 输出：${error instanceof Error ? error.message : String(error)}`, { cause: error }));
    }).finally(() => { checking = false; });
  }, timing.intervalMs);
  return () => clearInterval(timer);
}

function describe(milliseconds: number): string {
  return milliseconds >= 60_000 ? `${Math.round(milliseconds / 60_000)} 分钟` : `${Math.ceil(milliseconds / 1000)} 秒`;
}
