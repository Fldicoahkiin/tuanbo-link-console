import type { LinkProject } from '@tb/schema';
import { projectCodecResponseSchema, type ProjectCodecResponse } from './project-codec-protocol';

const validated = new WeakSet<LinkProject>();
export function isWorkerValidatedProject(project: LinkProject): boolean { return validated.has(project); }
type Pending = { resolve: (value: ProjectCodecResponse) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
/** What a codec says when it took too long or has too much queued, in the words of what it does (0.5.9 S8a): the file
 * codec's words read wrong after 「这次修改没送进节目：」. */
type CodecWords = { timeout: string; busy: string };

class ProjectCodec {
  private worker: Worker | null = null;
  private failure: Error | null = null;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  constructor(private readonly words: CodecWords) {}

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
    if (!this.failure) throw new Error('工程处理正常，不需要重启');
    this.failure = null;
  }
  private request(payload: { kind: 'decode'; content: string } | { kind: 'encode'; project: LinkProject }): Promise<ProjectCodecResponse> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending.size >= 4) return Promise.reject(new Error(this.words.busy));
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
      this.worker.onerror = event => this.fail(new Error(`工程处理出错：${event.message}`));
      this.worker.onmessageerror = () => this.fail(new Error('工程处理结果无法返回'));
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(this.words.timeout)), 30000);
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
export const projectCodec = new ProjectCodec({
  timeout: '工程处理超过 30 秒还没完成。原文件没有改动，可以在提示里重启工程处理后重试',
  busy: '工程处理任务太多，这次操作没有执行，请等当前任务完成后重试'
});
/** The whole project as the background program gets it (0.5.9 S9): its own worker, so the versions sent while editing
 * never queue behind or ahead of opening and saving the file. Its words follow 「这次修改没送进节目：」 (0.5.9 S8a); the
 * next edit or play sends the newest version again and starts the worker again (encodeProgramDocument). */
export const programDocumentCodec = new ProjectCodec({
  timeout: '整理这一版工程超过 30 秒还没完成，节目还在用上一版。下一次修改或按播放时会再送一次',
  busy: '前面还有几版没整理完，这一版没有送。下一次修改或按播放时会再送一次'
});
