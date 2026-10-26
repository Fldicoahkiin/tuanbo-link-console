import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { automaticMusicWorkerEventSchema, type AutomaticMusicRun, type AutomaticMusicWorkerEvent } from '@tb/schema';

export type AutomaticMusicWorkerRequest = {
  version: 1; task_id: string; audio: string; source_sha256: string; bundle: string;
  ffmpeg: string; output: string; cache: string; cancel_file: string; device: 'cpu' | 'cuda';
};
type Progress = Extract<AutomaticMusicWorkerEvent, { type: 'progress' }>;
type ActiveJob = { id: string; cancelFile: string; cancelled: boolean; child: ChildProcessWithoutNullStreams };

/** Owns one worker only. No engine fallback, network access or process termination. */
export class AutomaticMusicProcess {
  private active: ActiveJob | null = null;
  constructor(private readonly python: string, private readonly worker: string,
    private readonly progress: (event: Progress) => void, private readonly timeoutMs = 240_000) {}

  get busy(): boolean { return this.active !== null; }

  async cancel(taskId: string): Promise<void> {
    const job = this.active;
    if (!job || job.id !== taskId) return;
    job.cancelled = true;
    await writeFile(job.cancelFile, 'cancel\n', { flag: 'w' });
  }

  run(request: AutomaticMusicWorkerRequest, timeoutMs = this.timeoutMs): Promise<AutomaticMusicRun> {
    if (this.active) return Promise.reject(new Error('已有音乐识别在进行，请等它结束或取消'));
    if (![this.python, this.worker, request.audio, request.bundle, request.ffmpeg, request.output, request.cache, request.cancel_file].every(isAbsolute)) return Promise.reject(new Error('音乐识别路径必须由主进程解析为绝对路径'));
    const encoded = JSON.stringify(request);
    if (Buffer.byteLength(encoded) > 65_536) return Promise.reject(new Error('音乐识别请求过大'));
    const child = spawn(this.python, ['-u', this.worker], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', PYTHONUTF8: '1' } });
    const job: ActiveJob = { id: request.task_id, cancelFile: request.cancel_file, cancelled: false, child };
    this.active = job;
    return new Promise<AutomaticMusicRun>((resolve, reject) => {
      let failure: Error | null = null;
      let terminal: Exclude<AutomaticMusicWorkerEvent, Progress> | null = null;
      let stderr = ''; let buffer = '';
      const decoder = new StringDecoder('utf8');
      const fail = (error: Error): void => {
        if (failure) return;
        failure = error;
        void this.cancel(job.id).catch((cause: unknown) => { failure = new Error(`${error.message}；无法写入取消信号`, { cause }); });
      };
      const accept = (line: string): void => {
        if (failure || !line) return;
        try {
          const event = automaticMusicWorkerEventSchema.parse(JSON.parse(line));
          if (event.taskId !== job.id) throw new Error('音乐识别任务身份不符');
          if (terminal) throw new Error('音乐识别进程在终态后继续返回数据');
          if (event.type === 'progress') { if (!job.cancelled) this.progress(event); }
          else terminal = event;
        } catch (cause) { fail(new Error('音乐识别返回的数据无法识别，结果没有保存', { cause })); }
      };
      const deadline = setTimeout(() => fail(new Error('音乐识别超时，已停止，结果没有保存')), timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        if (failure) return;
        buffer += decoder.write(chunk);
        if (Buffer.byteLength(buffer) > 32_000_000) { fail(new Error('音乐识别返回数据过大')); return; }
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) { accept(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
      });
      child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-16_384); });
      child.stdin.on('error', fail); child.stdout.on('error', fail); child.stderr.on('error', fail);
      child.on('error', error => { failure ??= error; });
      child.once('close', code => {
        clearTimeout(deadline);
        if (this.active === job) this.active = null;
        buffer += decoder.end(); if (buffer.trim()) accept(buffer);
        if (failure) { reject(failure); return; }
        if (job.cancelled || terminal?.type === 'cancelled') { reject(new Error('音乐识别已取消，结果没有保存')); return; }
        if (terminal?.type === 'error') { reject(new Error(terminal.message)); return; }
        if (code !== 0 || terminal?.type !== 'result') { reject(new Error(`音乐识别没有正常完成（${String(code)}）：${stderr || '缺少结果'}`)); return; }
        if (terminal.result.audio.source_sha256 !== request.source_sha256 || terminal.result.device !== request.device) { reject(new Error('音源或设备和识别开始时不一致，结果没有保存')); return; }
        resolve(terminal.result);
      });
      child.stdin.end(encoded);
    });
  }
}
