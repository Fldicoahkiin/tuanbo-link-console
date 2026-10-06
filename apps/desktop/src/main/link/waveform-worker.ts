import { parentPort, workerData } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { WaveformAccumulator, waveformBucketCount } from './waveform-accumulator';
import { waveformWorkerRequestSchema, waveformWorkerResultSchema } from './waveform-worker-contract';

/** PCM reduction must never run on Electron's control/event loop. The service
 * admits one job at a time; this worker retains only peaks and one partial float. */
async function decode(): Promise<number[]> {
  const request = waveformWorkerRequestSchema.parse(workerData);
  const accumulator = new WaveformAccumulator(Math.round(request.durationMs * 48), waveformBucketCount(request.durationMs));
  return new Promise((resolve, reject) => {
    const child = spawn(request.executable, ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-filter_threads', '1', '-i', request.sourcePath,
      '-map', '0:a:0', '-vn', '-af', 'pan=mono|c0=c0', '-ar', '48000', '-f', 'f32le', 'pipe:1'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let errorOutput = '', failure: Error | null = null;
    child.stdout.on('data', (chunk: Buffer) => accumulator.push(chunk));
    child.stdout.on('error', error => { failure = error; });
    child.stderr.on('error', error => { failure = error; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { errorOutput = (errorOutput + chunk).slice(-8000); });
    child.on('error', error => { failure = new Error(`波形解码启动失败：${error.message}`, { cause: error }); });
    child.on('close', code => {
      if (failure) { reject(failure); return; }
      if (code !== 0) { reject(new Error(`波形解码失败（${String(code)}）：${errorOutput.trim() || '没有错误输出'}`)); return; }
      try { resolve(accumulator.finish()); } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
    });
  });
}

void decode().then(peaks => {
  parentPort?.postMessage(waveformWorkerResultSchema.parse({ version: 1, ok: true, peaks }));
}, error => {
  parentPort?.postMessage(waveformWorkerResultSchema.parse({ version: 1, ok: false, error: String(error instanceof Error ? error.message : error).slice(0, 8192) }));
});
