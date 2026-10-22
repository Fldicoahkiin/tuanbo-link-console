import type { LinkProject } from '@tb/schema';
import { projectCodecResponseSchema, type ProjectCodecResponse } from './project-codec-protocol';

const validated = new WeakSet<LinkProject>();
export function isWorkerValidatedProject(project: LinkProject): boolean { return validated.has(project); }
type Pending = { resolve: (value: ProjectCodecResponse) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

class ProjectCodec {
  private worker: Worker | null = null;
  private failure: Error | null = null;
  private sequence = 0;
  private pending = new Map<number, Pending>();

  async decode(content: string): Promise<LinkProject> {
    const result = await this.request({ kind: 'decode', content });
    if (result.kind !== 'decoded') throw new Error('工程解析返回了错误的结果类型');
    // Deserializing a large worker message already consumes this event-loop
    // turn. Let pending input/paint run before document subscribers mount UI.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    validated.add(result.project); return result.project;
  }
  async encode(project: LinkProject): Promise<string> {
    const result = await this.request({ kind: 'encode', project });
    if (result.kind !== 'encoded') throw new Error('工程序列化返回了错误的结果类型');
    return result.content;
  }
  /** Why encoding and decoding stopped; null while the worker works. */
  failureReason(): string | null { return this.failure?.message ?? null; }
  /** After the operator confirms: the failed worker is already gone; the next request starts a new one. */
  restart(): void {
    if (!this.failure) throw new Error('工程处理线程运行正常，无需重启');
    this.failure = null;
  }
  private request(payload: { kind: 'decode'; content: string } | { kind: 'encode'; project: LinkProject }): Promise<ProjectCodecResponse> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending.size >= 4) return Promise.reject(new Error('工程处理队列已满；此次操作未入队，请待当前任务结束后重试'));
    if (!this.worker) {
      this.worker = new Worker(new URL('./project-codec-worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = event => {
        try {
          const result = projectCodecResponseSchema.parse(event.data), pending = this.pending.get(result.id);
          if (!pending) throw new Error('工程处理返回了未知请求');
          this.pending.delete(result.id); clearTimeout(pending.timer);
          if (result.kind === 'error') pending.reject(new Error(result.message)); else pending.resolve(result);
        } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
      };
      this.worker.onerror = event => this.fail(new Error(`工程处理线程失效：${event.message}`));
      this.worker.onmessageerror = () => this.fail(new Error('工程处理结果无法传输'));
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('工程处理超过 30 秒；原文件未改变，可在提示中重启工程处理后重试')), 30000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.worker!.postMessage({ version: 1, id, ...payload }); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  private fail(error: Error): void {
    this.failure = error; this.worker?.terminate(); this.worker = null;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
}
export const projectCodec = new ProjectCodec();
