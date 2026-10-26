import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { automaticMusicStatusSchema, type AutomaticMusicJob, type AutomaticMusicRequest, type AutomaticMusicStatus } from '@tb/schema';
import type { LinkProjectService } from './link-project-service';
import { AutomaticMusicProcess } from './automatic-music-process';
import { AutomaticMusicService } from './automatic-music-service';

type Options = { python: string; worker: string; bundle: string; ffmpeg: string; root: string; device: 'cpu' | 'cuda'; devices: ('cpu' | 'cuda')[] };

export class AutomaticMusicRuntime {
  private readonly service: AutomaticMusicService;
  constructor(projects: Pick<LinkProjectService, 'resolveReferenceAudio'>, private readonly options: Options,
    changed: (job: AutomaticMusicJob) => void) {
    const worker = new AutomaticMusicProcess(options.python, options.worker, progress => this.service.progress(progress));
    this.service = new AutomaticMusicService(projects, worker, options, changed);
  }

  async status(): Promise<AutomaticMusicStatus> {
    let available = true; let reason = '离线识别可以使用，识别准确度还在验证中';
    try { await Promise.all([this.options.python, this.options.worker, this.options.ffmpeg, join(this.options.bundle, 'manifest.json')].map(path => access(path))); }
    catch (cause) { available = false; reason = `缺少离线识别组件（不会联网下载）：${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 16_384); }
    return automaticMusicStatusSchema.parse({ version: 1, available, device: this.options.device, devices: this.options.devices, reason, publication: 'not-validated', jobs: this.service.list() });
  }

  async start(request: AutomaticMusicRequest): Promise<AutomaticMusicJob> {
    const status = await this.status();
    if (!status.available) throw new Error(status.reason);
    if (!status.devices.includes(request.device)) throw new Error('选择的设备和已安装的识别组件不匹配，没有切换');
    return this.service.enqueue(request);
  }

  cancel(taskId: string): Promise<void> { return this.service.cancel(taskId); }
  resume(taskId: string): void { this.service.resume(taskId); }
  close(): Promise<void> { return this.service.close(); }
}
