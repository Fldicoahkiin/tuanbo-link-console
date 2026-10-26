import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { automaticMusicCandidates } from '@tb/core/link';
import { automaticMusicJobSchema, automaticMusicRequestSchema, type AutomaticMusicJob, type AutomaticMusicRequest, type AutomaticMusicWorkerEvent } from '@tb/schema';
import type { AutomaticMusicProcess } from './automatic-music-process';
import type { LinkProjectService } from './link-project-service';

type Job = { request: AutomaticMusicRequest; status: AutomaticMusicJob };
type Configuration = { root: string; bundle: string; ffmpeg: string };
const pending = new Set<AutomaticMusicJob['state']>(['queued', 'checking', 'running', 'pausing', 'paused', 'cancelling']);
const stageNames: Record<Extract<AutomaticMusicWorkerEvent, { type: 'progress' }>['stage'], string> = {
  'verify-assets': '检查离线模型', 'decode-48000-stereo': '解码实际播放音频',
  'beat-this-final0': '识别节拍 · 1/3', 'beat-this-final1': '识别节拍 · 2/3', 'beat-this-final2': '识别节拍 · 3/3',
  'audio-structure': '分析声音变化并分段',
  'all-in-one-harmonix-all': '识别音乐结构', 'cached-research-only': '读取缓存', 'completed-research-only': '整理分析结果'
};

/** Queue and file ownership; candidate publication never changes a project. */
export class AutomaticMusicService {
  private readonly jobs = new Map<string, Job>();
  private active: Job | null = null;
  private completion: Promise<void> | null = null;
  private closed = false;
  constructor(private readonly projects: Pick<LinkProjectService, 'resolveReferenceAudio'>,
    private readonly process: Pick<AutomaticMusicProcess, 'run' | 'cancel'>,
    private readonly configuration: Configuration, private readonly changed: (status: AutomaticMusicJob) => void) {}

  list(): AutomaticMusicJob[] { return [...this.jobs.values()].map(job => automaticMusicJobSchema.parse(job.status)); }

  enqueue(input: AutomaticMusicRequest): AutomaticMusicJob {
    if (this.closed) throw new Error('音乐识别服务已关闭');
    const request = automaticMusicRequestSchema.parse(input);
    const duplicate = [...this.jobs.values()].find(job => pending.has(job.status.state) && job.request.projectPath === request.projectPath && job.request.source.sha256 === request.source.sha256 && job.request.source.durationMs === request.source.durationMs && job.request.source.relativePath === request.source.relativePath && job.request.device === request.device);
    if (duplicate) return automaticMusicJobSchema.parse(duplicate.status);
    if (this.jobs.has(request.taskId)) throw new Error('音乐识别任务编号已使用');
    if ([...this.jobs.values()].filter(job => pending.has(job.status.state)).length >= 100) throw new Error('音乐识别队列已满');
    while (this.jobs.size >= 200) {
      const oldest = [...this.jobs.values()].find(job => !pending.has(job.status.state));
      if (!oldest) throw new Error('音乐识别记录已满');
      this.jobs.delete(oldest.status.taskId);
    }
    // Resolve before accepting a task; only project-owned relative audio is allowed.
    this.projects.resolveReferenceAudio(request.projectPath, request.source.relativePath);
    const status = automaticMusicJobSchema.parse({ version: 1, taskId: request.taskId, projectPath: request.projectPath, sourceSha256: request.source.sha256, revision: 0, state: 'queued',
      device: request.device, message: '等待分析', stage: null, summary: null });
    const job = { request, status }; this.jobs.set(request.taskId, job);
    this.changed(status); this.drain();
    return automaticMusicJobSchema.parse(job.status);
  }

  progress(event: Extract<AutomaticMusicWorkerEvent, { type: 'progress' }>): void {
    const job = this.active;
    if (!job || job.status.taskId !== event.taskId || !['checking', 'running'].includes(job.status.state)) return;
    this.update(job, { state: 'running', stage: event.stage, message: stageNames[event.stage] });
  }

  async cancel(taskId: string): Promise<void> {
    const job = this.jobs.get(taskId); if (!job || !pending.has(job.status.state)) return;
    if (this.active === job) {
      this.update(job, { state: 'cancelling', message: '正在取消，当前这一步完成后停止' });
      await this.process.cancel(taskId);
    } else this.update(job, { state: 'cancelled', message: '已取消' });
  }

  resume(taskId: string): void {
    if (this.closed) throw new Error('音乐识别服务已关闭');
    const job = this.jobs.get(taskId); if (!job || job.status.state !== 'paused') throw new Error('这个识别任务还没暂停好');
    this.update(job, { state: 'queued', stage: null, message: '等待重新开始分析' }); this.drain();
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.jobs.values()) if (pending.has(job.status.state)) await this.cancel(job.status.taskId);
    await this.completion;
  }

  private update(job: Job, patch: Partial<AutomaticMusicJob>): void {
    job.status = automaticMusicJobSchema.parse({ ...job.status, ...patch, revision: job.status.revision + 1 }); this.changed(job.status);
  }

  private drain(): void {
    if (this.closed || this.active) return;
    const next = [...this.jobs.values()].find(job => job.status.state === 'queued'); if (!next) return;
    this.active = next; this.completion = this.run(next);
  }

  private async run(job: Job): Promise<void> {
    this.update(job, { state: 'checking', message: '检查音源和运行环境' });
    try {
      const { request } = job;
      const directory = join(this.configuration.root, request.taskId);
      await mkdir(directory, { recursive: true });
      if (this.interrupted(job)) return;
      const result = await this.process.run({ version: 1, task_id: request.taskId, device: request.device,
        audio: this.projects.resolveReferenceAudio(request.projectPath, request.source.relativePath), source_sha256: request.source.sha256,
        bundle: this.configuration.bundle, ffmpeg: this.configuration.ffmpeg, cache: join(this.configuration.root, 'cache'),
        output: join(directory, crypto.randomUUID()), cancel_file: join(directory, `${crypto.randomUUID()}.cancel`) }, Math.min(3_600_000, Math.max(240_000, request.source.durationMs * 8 + 60_000)));
      if (this.interrupted(job)) return;
      const candidates = automaticMusicCandidates(result);
      if (Math.abs(candidates.durationMs - request.source.durationMs) > 50) throw new Error('音源长度变了，请重新导入这首音乐后再分析');
      this.update(job, { state: 'completed', candidates, message: candidates.items.length ? '音乐分析完成' : '没有识别到节拍或段落，请检查音源是不是静音',
        summary: { runId: result.run_id, durationMs: result.audio.sample_count / result.audio.sample_rate * 1000,
          elapsedSeconds: result.timings.total_seconds, cached: result.timings.cached, publication: 'not-validated', visibleResults: candidates.items.length } });
    } catch (error) {
      if (!this.interrupted(job)) this.update(job, { state: 'failed', message: (error instanceof Error ? error.message : String(error)).slice(0, 16_384) });
    } finally {
      if (this.active === job) this.active = null;
      this.drain();
    }
  }

  private interrupted(job: Job): boolean {
    if (job.status.state === 'pausing') { this.update(job, { state: 'paused', message: '已暂停，继续时会重新开始，已完成的部分会复用' }); return true; }
    if (job.status.state === 'cancelling') { this.update(job, { state: 'cancelled', message: '已取消，结果没有保存' }); return true; }
    return false;
  }
}
