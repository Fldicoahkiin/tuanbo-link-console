import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { projectDocumentRequestSchema, projectDocumentResponseSchema, type ProjectDocumentRequest, type ProjectDocumentResponse } from './project-document-contract';

type Payload = ProjectDocumentRequest extends infer T ? T extends ProjectDocumentRequest ? Omit<T, 'version' | 'id'> : never : never;
type Pending = { kind: Payload['kind']; resolve: (result: ProjectDocumentResponse) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
const resultKinds = { open: 'opened', save: 'saved', copy: 'saved', inspect: 'inspected' } as const;

export class ProjectDocumentService {
  private worker: Worker | null = null;
  private sequence = 0;
  private failure: Error | null = null;
  private readonly pending = new Map<number, Pending>();
  constructor(private readonly workerPath = join(__dirname, 'project-document-worker.cjs')) {}

  async read(path: string): Promise<string> {
    const response = await this.request({ kind: 'open', path });
    if (response.kind !== 'opened') throw new Error('工程读取返回类型不正确');
    return response.content;
  }
  async inspect(content: string): Promise<string> {
    const response = await this.request({ kind: 'inspect', content });
    if (response.kind !== 'inspected') throw new Error('工程检查返回类型不正确');
    return response.name;
  }
  async save(path: string, content: string): Promise<void> {
    const response = await this.request({ kind: 'save', path, content });
    if (response.kind !== 'saved') throw new Error('工程保存返回类型不正确');
  }
  async writeCopy(path: string, content: string): Promise<void> {
    const response = await this.request({ kind: 'copy', path, content });
    if (response.kind !== 'saved') throw new Error('工程副本写入返回类型不正确');
  }
  private request(payload: Payload): Promise<ProjectDocumentResponse> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending.size >= 64) return Promise.reject(new Error('工程处理队列已满；此次请求未入队'));
    const request = projectDocumentRequestSchema.parse({ version: 1, id: ++this.sequence, ...payload });
    if (!this.worker) {
      this.worker = new Worker(this.workerPath);
      this.worker.on('message', (value: unknown) => {
        try {
          const response = projectDocumentResponseSchema.parse(value), pending = this.pending.get(response.id);
          if (!pending) throw new Error('工程处理收到未知请求结果');
          if (response.kind !== 'error' && response.kind !== resultKinds[pending.kind]) throw new Error('工程处理返回类型与请求不一致；未确认的保存结果需重新核对');
          this.pending.delete(response.id); clearTimeout(pending.timer);
          if (!this.pending.size) this.worker?.unref();
          if (response.kind === 'error') pending.reject(new Error(response.error)); else pending.resolve(response);
        } catch (error) { this.fail(error); }
      });
      this.worker.on('error', (error: unknown) => this.fail(error));
      this.worker.on('exit', code => this.fail(new Error(`工程处理线程退出（${code}）；未确认的保存结果需重新核对`)));
    }
    this.worker.ref();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('工程处理超过 30 秒；未确认的保存可能已写入，请重开核对，不会自动重试')), 30000);
      this.pending.set(request.id, { kind: payload.kind, resolve, reject, timer });
      try { this.worker!.postMessage(request); }
      catch (error) { this.fail(error); }
    });
  }
  private fail(error: unknown): void {
    if (this.failure) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(this.failure); }
    this.pending.clear();
    // Do not terminate an in-flight atomic save on a timeout. Its result remains
    // unconfirmed and this service refuses new work until the app is restarted.
    this.worker?.removeAllListeners('message'); this.worker?.unref();
  }
}
