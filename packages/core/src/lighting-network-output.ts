import { compileLightingNetworkActions, type LightingNetworkAction } from './lighting-playback';
import type { LinkDesktopApi } from './link-desktop-contract';
import { ma2NetworkStatusSchema, type LightingDocument, type Ma2NetworkTarget, type Ma2PlaybackAction } from '@tb/schema';

const actionKey = (action: Ma2PlaybackAction): string => action.target === 'executor' ? `executor:${action.executor}` : `sequence:${action.sequence}`;
const offAction = (action: Ma2PlaybackAction): Ma2PlaybackAction => action.target === 'executor'
  ? { target: 'executor', executor: action.executor, action: 'off' } : { target: 'sequence', sequence: action.sequence, action: 'off' };
const describeAction = (action: Ma2PlaybackAction): string => `${action.target === 'executor' ? `执行器 ${action.executor}` : `序列 ${action.sequence}`} ${action.action === 'off' ? '关闭' : action.cue ?? ''}`;

/** Explicit network output. Pausing or seeking invalidates unsent work; failures never retry.
 * A failed Cue is reported through takeFault() and later Cues still run (live mode). */
export class LightingNetworkOutput {
  private readonly started = new Map<string, Ma2PlaybackAction>();
  private document: LightingDocument | null = null;
  private actions: LightingNetworkAction[] = [];
  private cursor = 0;
  private position = 0;
  private sessionId: string | null = null;
  private target: Ma2NetworkTarget | null = null;
  private tail: Promise<void> = Promise.resolve();
  private failure: Error | null = null;
  private fault: string | null = null;
  private pending = 0;
  private generation = 0;
  private cancellation = 0;
  private readonly cancellations = new Set<Promise<void>>();

  constructor(private readonly api: Pick<LinkDesktopApi, 'getMa2NetworkStatus' | 'cancelMa2Playback' | 'playMa2Cue'>,
    private readonly reportError: (error: Error) => void) {}

  /** `restore` (internal playback) sends the executors' state at `positionMs`,
   * keeping what this song already put on the console; returns the commands sent. */
  async prepare(document: LightingDocument, positionMs: number, restore = false): Promise<number> {
    this.stop(); this.failure = null;
    if (document !== this.document) this.started.clear();
    this.document = document;
    const generation = this.generation;
    const actions = compileLightingNetworkActions(document);
    if (!actions.length) return 0;
    const status = ma2NetworkStatusSchema.parse(await this.api.getMa2NetworkStatus());
    if (generation !== this.generation) return 0;
    if (status.state !== 'connected' || !status.settings) throw new Error('序列池播放需要先在设备设置连接 MA2 网络');
    const { host, port, monitorPort, username } = status.settings;
    this.target = { host, port, monitorPort, username };
    this.actions = actions;
    if (restore) return this.restore(positionMs);
    this.locate(positionMs); return 0;
  }
  locate(positionMs: number): void {
    this.started.clear(); this.moveTo(positionMs);
  }
  /** Internal playback after a pause, seek or clock gap: send only what differs
   * from the executors the timeline prescribes at `positionMs`. Cues in between
   * are not replayed. Returns the number of commands sent. */
  restore(positionMs: number): number {
    this.moveTo(positionMs);
    const sessionId = this.sessionId, network = this.target;
    if (!sessionId || !network) return 0;
    const target = new Map<string, Ma2PlaybackAction>();
    for (const entry of this.actions.slice(0, this.cursor)) {
      if (entry.releasePrevious) target.clear();
      const key = actionKey(entry.action);
      if (entry.releaseOnlyIfStarted && !target.has(key)) continue;
      if (entry.action.action === 'off') target.delete(key); else target.set(key, entry.action);
    }
    const commands = [...[...this.started].filter(([key]) => !target.has(key)).map(([, action]) => offAction(action)),
      ...[...target].filter(([key, action]) => JSON.stringify(this.started.get(key)) !== JSON.stringify(action)).map(([, action]) => action)];
    const dueAt = Date.now();
    for (const action of commands) this.enqueue(sessionId, async () => {
      const sent = await this.play(sessionId, network, action, dueAt);
      if (this.sessionId === sessionId) { if (action.action === 'off') this.started.delete(actionKey(action)); else if (sent) this.started.set(actionKey(action), action); }
    });
    return commands.length;
  }
  private moveTo(positionMs: number): void {
    this.cancelSession(); this.failure = null; this.pending = 0; this.tail = Promise.resolve();
    this.sessionId = this.target ? crypto.randomUUID() : null;
    this.position = positionMs;
    const next = this.actions.findIndex(entry => entry.atMs >= positionMs);
    this.cursor = next < 0 ? this.actions.length : next;
  }
  tick(positionMs: number): void { this.advance(positionMs, false); }
  /** The latest live Cue failure since the previous call. */
  takeFault(): string | null { const fault = this.fault; this.fault = null; return fault; }
  async finish(positionMs: number): Promise<void> { this.advance(positionMs, true); await this.tail; if (this.failure) throw this.failure; }
  loop(startMs: number, endMs: number): void {
    this.advance(endMs, true);
    this.position = startMs;
    const next = this.actions.findIndex(entry => entry.atMs >= startMs);
    this.cursor = next < 0 ? this.actions.length : next;
  }
  stop(): void { this.generation += 1; this.cancelSession(); this.actions = []; this.target = null; this.cursor = 0; }
  /** The song's executors were released at stop; nothing of it is assumed on air. */
  forget(): void { this.started.clear(); this.document = null; }
  async close(): Promise<void> {
    this.stop();
    const results = await Promise.allSettled([this.tail, ...this.cancellations]);
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : []);
    if (errors.length) throw new AggregateError(errors, '灯光网络取消未完成');
  }
  private cancelSession(): void {
    const cancellation = ++this.cancellation;
    const id = this.sessionId; this.sessionId = null;
    if (!id) return;
    const pending = this.api.cancelMa2Playback(id); this.cancellations.add(pending);
    void pending.catch((error: unknown) => {
      if (cancellation === this.cancellation && this.sessionId === null) this.failure = error instanceof Error ? error : new Error(String(error));
      this.reportError(error instanceof Error ? error : new Error(String(error)));
    }).finally(() => { this.cancellations.delete(pending); });
  }
  private advance(positionMs: number, exclusive: boolean): void {
    if (this.failure) throw this.failure;
    if (positionMs < this.position) this.locate(positionMs);
    this.position = positionMs;
    const sessionId = this.sessionId; const network = this.target;
    if (!sessionId || !network) return;
    while (this.cursor < this.actions.length) {
      const entry = this.actions[this.cursor]!;
      if (entry.atMs > positionMs || exclusive && entry.atMs === positionMs) break;
      this.cursor += 1;
      const dueAt = Date.now();
      this.enqueue(sessionId, async () => {
        if (entry.releasePrevious) for (const [key, action] of this.started) {
          if (this.sessionId !== sessionId) return;
          // A release is attempted once; a failed one is reported, never resent.
          await this.play(sessionId, network, offAction(action), dueAt); this.started.delete(key);
        }
        const key = actionKey(entry.action);
        if (this.sessionId !== sessionId || entry.releaseOnlyIfStarted && !this.started.has(key)) return;
        const sent = await this.play(sessionId, network, entry.action, dueAt);
        if (this.sessionId === sessionId) { if (entry.action.action === 'off') this.started.delete(key); else if (sent) this.started.set(key, entry.action); }
      });
    }
  }
  private enqueue(sessionId: string, operation: () => Promise<void>): void {
    if (this.pending >= 32) { this.fault = '灯光网络指令积压超过 32 条，本条未发送；控台响应过慢，请减少同时调用的素材'; return; }
    this.pending += 1;
    this.tail = this.tail.then(async () => {
      if (this.sessionId !== sessionId || this.failure) return;
      await operation();
    }).finally(() => { if (this.sessionId === sessionId) this.pending -= 1; });
  }
  /** A late look change beats a missing one, so a Cue may run up to 1 s late;
   * anything past 150 ms is reported so the operator knows it was late. */
  private async play(sessionId: string, network: Ma2NetworkTarget, action: Ma2PlaybackAction, dueAt: number): Promise<boolean> {
    try {
      await this.api.playMa2Cue({ sessionId, network, action, deadlineAt: dueAt + 1000 });
      const lateMs = Date.now() - dueAt;
      if (lateMs > 150 && this.sessionId === sessionId) this.fault = `灯光网络 Cue 晚 ${lateMs} ms 执行：${describeAction(action)}`;
      return true;
    } catch (error) {
      if (this.sessionId === sessionId) this.fault = `灯光网络 Cue 未执行：${describeAction(action)} · ${error instanceof Error ? error.message : String(error)}`;
      return false;
    }
  }
}
