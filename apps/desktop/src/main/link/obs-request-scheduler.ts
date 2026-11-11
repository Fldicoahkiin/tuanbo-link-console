import { AsyncLocalStorage } from 'node:async_hooks';

/** OBS 请求谁先发（2026-11-10）. `program` is the song's picture going on air:
 * scene switches, material scenes, shown sources, and the drift check the picture
 * session waits for. `control` is the live canvas, beauty and source management;
 * `background` prepares ahead and reads inventories; `preview` takes screenshots. */
export type ObsRequestPriority = 'urgent' | 'program' | 'control' | 'background' | 'preview';
export type ObsOperationRunner = <T>(operation: () => Promise<T>) => Promise<T>;
type Context = { generation: number; priority?: ObsRequestPriority; canSend?: () => boolean; dispatched?: () => void };
type Job = { priority: ObsRequestPriority; generation: number; started: boolean; settled: boolean;
  timer: ReturnType<typeof setTimeout> | undefined; start: () => void; reject: (error: Error) => void };
export type ObsRequestTiming = { label: string; priority: ObsRequestPriority; queuedAt: number;
  startedAt: number | null; finishedAt: number; queueMs: number; executionMs: number; failed: boolean };
const priorities: ObsRequestPriority[] = ['urgent', 'program', 'control', 'background', 'preview'];
/** Requests in flight at once, and how many of them `control`, `background`
 * and `preview` may hold together: the other two are always free for `urgent`
 * and `program`. */
export const OBS_REQUEST_SLOTS = 4;
export const OBS_SHARED_REQUEST_SLOTS = 2;
/** How long after the last `program` request ended no new screenshot goes out.
 * One cut is several requests sent one after the other; without this a screenshot
 * would slip in between two of them and hold up the rest of the cut. */
export const OBS_PROGRAM_QUIET_MS = 100;
const shared = (priority: ObsRequestPriority): boolean => priority === 'control' || priority === 'background' || priority === 'preview';

/** Deferred calls, bounded work and connection generations. A timeout never retries a write. */
export class ObsRequestScheduler {
  private readonly context = new AsyncLocalStorage<Context>();
  private readonly queue: Job[] = [];
  private readonly active = new Set<Job>();
  private generation = 0;
  private failure: Error | null = new Error('OBS 还没连接');
  private requestCount = 0;
  private maximumQueued = 0;
  private maximumActive = 0;
  private readonly timings: ObsRequestTiming[] = [];
  private programQuiet: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly timeoutMs: number, private readonly onTimeout: (error: Error) => void) {}

  connect(): void { this.invalidate(new Error('OBS 连接已更换')); this.failure = null; }

  invalidate(error: Error): void {
    this.generation++; this.failure = error;
    clearTimeout(this.programQuiet); this.programQuiet = undefined;
    const pending = [...this.queue, ...this.active]; this.queue.length = 0; this.active.clear();
    for (const job of pending) job.reject(error);
  }

  /** Runs `operation` at `priority`. Inside another operation it keeps the outer
   * tier, except that `urgent` always wins: a screenshot's own sub-requests do not
   * jump the queue, and a `program` operation's are never held back as background. */
  run<T>(priority: ObsRequestPriority, operation: () => Promise<T>): Promise<T> {
    const current = this.context.getStore();
    return this.context.run({ ...current, generation: current?.generation ?? this.generation,
      priority: priority === 'urgent' ? 'urgent' : current?.priority ?? priority }, operation);
  }

  /** The guard follows every awaited sub-request, including time spent in this
   * scheduler's queue. Checking only before calling the adapter is too early.
   * `dispatched` runs each time one of the operation's requests is sent. */
  guarded<T>(canSend: () => boolean, operation: () => Promise<T>, dispatched?: () => void): Promise<T> {
    const current = this.context.getStore() ?? { generation: this.generation };
    const guard = current.canSend ? () => current.canSend!() && canSend() : canSend;
    const outer = current.dispatched;
    const notify = outer && dispatched ? () => { outer(); dispatched(); } : dispatched ?? outer;
    return this.context.run({ ...current, canSend: guard, ...(notify ? { dispatched: notify } : {}) }, operation);
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
    if (context.canSend && !context.canSend()) return Promise.reject(new Error(`OBS 动作已取消或已过时，没有发送：${label}`));
    if (this.queue.length >= 128) return Promise.reject(new Error(`OBS 请求排队已满：${label}`));
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
        if (job.priority === 'program' && job.started) this.holdScreenshots();
        if (error !== null) reject(error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'OBS 返回了非标准错误', { cause: error }));
        else resolve(result!);
        this.pump();
      };
      // Waiting here only fails this request. The connection ends only when OBS
      // leaves a request that went out unanswered for the whole limit: a busy
      // OBS that answers late is not a lost one. A screenshot has no time by which
      // it must go out and is held back on purpose while the picture goes on air,
      // so it waits its turn: failing it would blank the preview with an error
      // every time a song is made ready.
      const job: Job = { ...context, started: false, settled: false, reject: error => finish(error),
        timer: context.priority === 'preview' ? undefined
          : setTimeout(() => finish(new Error(`OBS ${label} 请求排队超时（${this.timeoutMs} ms）；还没发送`)), this.timeoutMs),
        start: () => {
          this.active.add(job);
          this.maximumActive = Math.max(this.maximumActive, this.active.size);
          // Preserve the operation's original generation through its continuation.
          Promise.resolve().then(() => {
            if (job.settled || job.generation !== this.generation) throw new Error('OBS 请求在发送前已取消');
            if (context.canSend && !context.canSend()) throw new Error(`OBS 动作已取消或已过时，没有发送：${label}`);
            job.started = true; startedAt = performance.now(); this.requestCount++;
            clearTimeout(job.timer);
            job.timer = setTimeout(() => {
              const error = new Error(`OBS ${label} 请求超时（${this.timeoutMs} ms）；不确定是否已执行，请检查 OBS 后重新连接`);
              this.invalidate(error); this.onTimeout(error);
            }, this.timeoutMs);
            context.dispatched?.();
            return this.context.run(context, operation);
          }).then(value => finish(null, value), error => finish(error));
        }
      };
      this.queue.push(job); this.maximumQueued = Math.max(this.maximumQueued, this.queue.length); this.pump();
    });
  }

  /** One place decides what goes out next. `urgent` and `program` may use every
   * slot; the shared tiers together hold at most two, so a cut never waits for a
   * slot. A screenshot holds OBS's graphics thread, so no new one goes out while a
   * `program` request is queued or in flight or has only just ended
   * (`OBS_PROGRAM_QUIET_MS`), and at most one is in flight; one already sent
   * keeps waiting for its answer. `background` is not held back that
   * way: it prepares the playing song's next material, and held behind a long run
   * of `program` requests (another song being made ready) it would miss its cut.
   * A nested operation runs at its outer tier (see `run`), so a `program`
   * operation never waits for a `preview` request of its own. */
  private pump(): void {
    if (this.failure) return;
    while (this.active.size < OBS_REQUEST_SLOTS) {
      const active = [...this.active];
      const sharedActive = active.filter(job => shared(job.priority)).length;
      const preview = active.some(job => job.priority === 'preview');
      const program = this.programQuiet !== undefined || active.some(job => job.priority === 'program') || this.queue.some(job => job.priority === 'program');
      const admits = (value: ObsRequestPriority): boolean => {
        switch (value) {
          case 'urgent': case 'program': return true;
          case 'control': case 'background': return sharedActive < OBS_SHARED_REQUEST_SLOTS;
          case 'preview': return sharedActive < OBS_SHARED_REQUEST_SLOTS && !program && !preview;
        }
      };
      const priority = priorities.find(value => admits(value) && this.queue.some(job => job.priority === value));
      if (!priority) break;
      const index = this.queue.findIndex(job => job.priority === priority);
      const job = this.queue.splice(index, 1)[0]!;
      if (!job.settled) job.start();
    }
  }

  private holdScreenshots(): void {
    clearTimeout(this.programQuiet);
    this.programQuiet = setTimeout(() => { this.programQuiet = undefined; this.pump(); }, OBS_PROGRAM_QUIET_MS);
  }
}
