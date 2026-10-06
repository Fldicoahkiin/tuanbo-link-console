import { AsyncLocalStorage } from 'node:async_hooks';

export type ObsRequestPriority = 'urgent' | 'control' | 'background' | 'preview';
export type ObsOperationRunner = <T>(operation: () => Promise<T>) => Promise<T>;
type Context = { generation: number; priority?: ObsRequestPriority; canSend?: () => boolean };
type Job = { priority: ObsRequestPriority; generation: number; started: boolean; settled: boolean;
  timer: ReturnType<typeof setTimeout>; start: () => void; reject: (error: Error) => void };
export type ObsRequestTiming = { label: string; priority: ObsRequestPriority; queuedAt: number;
  startedAt: number | null; finishedAt: number; queueMs: number; executionMs: number; failed: boolean };
const priorities: ObsRequestPriority[] = ['urgent', 'control', 'background', 'preview'];

/** Deferred calls, bounded work and connection generations. A timeout never retries a write. */
export class ObsRequestScheduler {
  private readonly context = new AsyncLocalStorage<Context>();
  private readonly queue: Job[] = [];
  private readonly active = new Set<Job>();
  private generation = 0;
  private failure: Error | null = new Error('OBS 请求通道尚未连接');
  private requestCount = 0;
  private maximumQueued = 0;
  private maximumActive = 0;
  private readonly timings: ObsRequestTiming[] = [];

  constructor(private readonly timeoutMs: number, private readonly onTimeout: (error: Error) => void) {}

  connect(): void { this.invalidate(new Error('OBS 连接会话已更换')); this.failure = null; }

  invalidate(error: Error): void {
    this.generation++; this.failure = error;
    const pending = [...this.queue, ...this.active]; this.queue.length = 0; this.active.clear();
    for (const job of pending) job.reject(error);
  }

  run<T>(priority: ObsRequestPriority, operation: () => Promise<T>): Promise<T> {
    const current = this.context.getStore();
    return this.context.run({ ...current, generation: current?.generation ?? this.generation,
      priority: priority === 'urgent' ? 'urgent' : current?.priority ?? priority }, operation);
  }

  /** The guard follows every awaited sub-request, including time spent in this
   * scheduler's queue. Checking only before calling the adapter is too early. */
  guarded<T>(canSend: () => boolean, operation: () => Promise<T>): Promise<T> {
    const current = this.context.getStore() ?? { generation: this.generation };
    const guard = current.canSend ? () => current.canSend!() && canSend() : canSend;
    return this.context.run({ ...current, canSend: guard }, operation);
  }

  getStats(): { queued: number; active: number; requests: number; maximumQueued: number; maximumActive: number } {
    return { queued: this.queue.length, active: this.active.size, requests: this.requestCount,
      maximumQueued: this.maximumQueued, maximumActive: this.maximumActive };
  }

  getTimings(): ObsRequestTiming[] { return this.timings.map(timing => ({ ...timing })); }

  request<T>(operation: () => Promise<T>, label: string): Promise<T> {
    const inherited = this.context.getStore();
    const context = { ...inherited, generation: inherited?.generation ?? this.generation, priority: inherited?.priority ?? 'control' };
    if (context.generation !== this.generation) return Promise.reject(new Error('OBS 旧连接的请求已取消'));
    if (this.failure) return Promise.reject(this.failure);
    if (context.canSend && !context.canSend()) return Promise.reject(new Error(`OBS 动作已取消或超过执行边界；尚未发送：${label}`));
    if (this.queue.length >= 128) return Promise.reject(new Error(`OBS 请求队列已满：${label}`));
    return new Promise<T>((resolve, reject) => {
      const queuedAt = performance.now(); let startedAt: number | null = null;
      const finish = (error: unknown, result?: T): void => {
        if (job.settled) return;
        const finishedAt = performance.now();
        this.timings.push({ label, priority: context.priority, queuedAt, startedAt, finishedAt,
          queueMs: (startedAt ?? finishedAt) - queuedAt, executionMs: startedAt === null ? 0 : finishedAt - startedAt, failed: error !== null });
        if (this.timings.length > 128) this.timings.shift();
        job.settled = true; clearTimeout(job.timer); this.active.delete(job);
        const index = this.queue.indexOf(job); if (index >= 0) this.queue.splice(index, 1);
        if (error !== null) reject(error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'OBS 返回了非标准错误', { cause: error }));
        else resolve(result!);
        this.pump();
      };
      const job: Job = { ...context, started: false, settled: false, reject: error => finish(error),
        timer: setTimeout(() => {
          const error = new Error(`OBS ${label} 请求超过 ${this.timeoutMs}ms${job.started ? '；执行结果不明，请核对后重新连接' : '；尚未发送'}`);
          if (job.started) { this.invalidate(error); this.onTimeout(error); }
          else finish(error);
        }, this.timeoutMs),
        start: () => {
          this.active.add(job);
          this.maximumActive = Math.max(this.maximumActive, this.active.size);
          // Preserve the operation's original generation through its continuation.
          Promise.resolve().then(() => {
            if (job.settled || job.generation !== this.generation) throw new Error('OBS 请求在发送前已取消');
            if (context.canSend && !context.canSend()) throw new Error(`OBS 动作已取消或超过执行边界；尚未发送：${label}`);
            job.started = true; startedAt = performance.now(); this.requestCount++;
            return this.context.run(context, operation);
          }).then(value => finish(null, value), error => finish(error));
        }
      };
      this.queue.push(job); this.maximumQueued = Math.max(this.maximumQueued, this.queue.length); this.pump();
    });
  }

  private pump(): void {
    if (this.failure) return;
    while (this.active.size < 4) {
      const background = [...this.active].filter(job => job.priority === 'background' || job.priority === 'preview').length;
      const preview = [...this.active].some(job => job.priority === 'preview');
      const priority = priorities.find(value => this.queue.some(job => job.priority === value)
        && ((value !== 'background' && value !== 'preview') || background < 3)
        && (value !== 'preview' || !preview));
      if (!priority) break;
      const index = this.queue.findIndex(job => job.priority === priority);
      const job = this.queue.splice(index, 1)[0]!;
      if (!job.settled) job.start();
    }
  }
}
