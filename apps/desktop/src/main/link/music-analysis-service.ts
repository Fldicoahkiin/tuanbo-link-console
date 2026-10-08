import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import ffmpegPath from 'ffmpeg-static';
import { analyzeMusicEnvelope } from '@tb/core/link';
import { musicAnalysisResultSchema, type MusicAnalysisProgress, type MusicAnalysisResult, type ReferenceAudio } from '@tb/schema';
import type { LinkProjectService } from './link-project-service';

export class MusicAnalysisService {
  private task: { id: string; cancelled: boolean; child: ChildProcessWithoutNullStreams | null } | null = null;
  constructor(private readonly projects: Pick<LinkProjectService, 'resolveReferenceAudio'>, private readonly changed: (progress: MusicAnalysisProgress) => void) {}
  close(): void { if (this.task) this.cancel(this.task.id); }
  cancel(id: string): void {
    if (this.task?.id !== id) return;
    this.task.cancelled = true;
    // FFmpeg handles q as a normal shutdown; never terminate an unrelated process.
    if (this.task.child?.stdin.writable) this.task.child.stdin.write('q\n');
  }
  async analyze(taskId: string, projectPath: string, source: ReferenceAudio): Promise<MusicAnalysisResult> {
    if (this.task) throw new Error('已有音乐分析任务，请等待完成或取消');
    if (!ffmpegPath) throw new Error('音频分析组件缺失');
    const task = { id: taskId, cancelled: false, child: null as ChildProcessWithoutNullStreams | null }; this.task = task;
    const progress = (phase: MusicAnalysisProgress['phase'], value: number, message: string): void => this.changed({ version: 1, taskId, phase, progress: value, message });
    try {
      progress('checking', 0, '核对音源');
      const path = this.projects.resolveReferenceAudio(projectPath, source.relativePath); const hash = createHash('sha256');
      for await (const data of createReadStream(path)) { if (task.cancelled) throw new Error('分析已取消'); if (!Buffer.isBuffer(data)) throw new Error('音源数据格式无效'); hash.update(data); }
      if (task.cancelled) throw new Error('分析已取消');
      if (hash.digest('hex') !== source.sha256) throw new Error('音源已改变，请重新导入后分析');
      const envelope: number[] = []; let remainder = Buffer.alloc(0); let sum = 0; let samples = 0; let lastProgress = 0;
      progress('decoding', .05, '分析音频');
      if (task.cancelled) throw new Error('分析已取消');
      await new Promise<void>((resolveRun, reject) => {
        const child = spawn(ffmpegPath!.replace('app.asar', 'app.asar.unpacked'), ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-i', path, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '22050', '-f', 'f32le', 'pipe:1'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); task.child = child;
        let error = ''; let failed: Error | null = null;
        const deadline = setTimeout(() => { failed = new Error('音乐分析超时，已请求正常停止；未应用结果'); if (child.stdin.writable) child.stdin.write('q\n'); }, Math.max(120000, source.durationMs));
        child.stdout.on('data', (chunk: Buffer) => {
          if (task.cancelled || failed) return;
          const data = remainder.length ? Buffer.concat([remainder, chunk]) : chunk; const length = data.length - data.length % 4;
          for (let offset = 0; offset < length; offset += 4) { const sample = data.readFloatLE(offset); if (!Number.isFinite(sample)) { failed = new Error('音频解码出现无效采样'); child.stdin.write('q\n'); break; } sum += sample * sample; samples++; if (samples === 441) { envelope.push(Math.sqrt(sum / 441)); sum = 0; samples = 0; } }
          if (envelope.length * 20 > source.durationMs + 2000 && !failed) { failed = new Error('音源实际长度与工程记录不一致，请重新导入'); if(child.stdin.writable)child.stdin.write('q\n'); }
          remainder = Buffer.from(data.subarray(length));
          const now = performance.now(); if (now - lastProgress >= 250) { progress('decoding', Math.min(.9, .05 + envelope.length * 20 / source.durationMs * .85), '分析音频'); lastProgress = now; }
        });
        child.stderr.on('data', (data: Buffer) => { error = (error + data.toString()).slice(-4000); });
        child.on('error', cause => { clearTimeout(deadline); reject(cause); });
        child.stdin.on('error', cause => { failed = cause; }); child.stdout.on('error', cause => { failed = cause; }); child.stderr.on('error', cause => { failed = cause; });
        child.on('close', code => { clearTimeout(deadline); if (task.cancelled) reject(new Error('分析已取消')); else if (failed) reject(failed); else if (code !== 0) reject(new Error(`音频分析失败：${error || code}`)); else resolveRun(); });
      });
      if (task.cancelled) throw new Error('分析已取消');
      progress('analyzing', .95, '整理候选标记');
      const result = musicAnalysisResultSchema.parse({ version: 1, taskId, sourceSha256: source.sha256, durationMs: source.durationMs, ...analyzeMusicEnvelope(envelope, source.durationMs) });
      progress('complete', 1, '等待确认'); return result;
    } catch (error) { progress(task.cancelled ? 'cancelled' : 'failed', 0, error instanceof Error ? error.message : String(error)); throw error; }
    finally { if (this.task === task) this.task = null; }
  }
}
