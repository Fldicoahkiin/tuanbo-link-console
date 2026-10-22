import { compileLightingNetworkActions, type LightingNetworkAction } from './lighting-playback';
import type { LinkDesktopApi } from './link-desktop-contract';
import { ma2NetworkStatusSchema, type LightingDocument, type Ma2NetworkTarget } from '@tb/schema';

/** Explicit network output. Pausing or seeking invalidates unsent work; failures never retry.
 * A failed Cue is reported through takeFault() and later Cues still run (live mode). */
export class LightingNetworkOutput {
  private readonly started = new Map<string, import('@tb/schema').Ma2PlaybackAction>();
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

  async prepare(document: LightingDocument, positionMs: number): Promise<void> {
    this.stop(); this.failure = null;
    const generation = this.generation;
    const actions = compileLightingNetworkActions(document);
    if (!actions.length) return;
    const status = ma2NetworkStatusSchema.parse(await this.api.getMa2NetworkStatus());
    if (generation !== this.generation) return;
    if (status.state !== 'connected' || !status.settings) throw new Error('序列池播放需要先在设备设置连接 MA2 网络');
    const { host, port, monitorPort, username } = status.settings;
    this.target = { host, port, monitorPort, username };
    this.actions = actions; this.locate(positionMs);
  }
  locate(positionMs: number): void {
    this.cancelSession(); this.started.clear(); this.failure = null; this.pending = 0; this.tail = Promise.resolve();
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
      if (this.pending >= 32) { this.fault = '灯光网络指令积压超过 32 条，本条未发送；控台响应过慢，请减少同时调用的素材'; continue; }
      this.pending += 1;
      const dueAt = Date.now(), deadlineAt = dueAt + 1000;
      // A late look change beats a missing one, so a Cue may run up to 1 s late;
      // anything past 150 ms is reported so the operator knows it was late.
      const play = async (action: import('@tb/schema').Ma2PlaybackAction): Promise<boolean> => {
        try {
          await this.api.playMa2Cue({ sessionId, network, action, deadlineAt });
          const lateMs = Date.now() - dueAt;
          if (lateMs > 150 && this.sessionId === sessionId) this.fault = `灯光网络 Cue 晚 ${lateMs} ms 执行：${action.target === 'executor' ? `执行器 ${action.executor}` : `序列 ${action.sequence}`} ${action.action === 'off' ? '关闭' : action.cue ?? ''}`;
          return true;
        }
        catch (error) {
          if (this.sessionId === sessionId) this.fault = `灯光网络 Cue 未执行：${action.target === 'executor' ? `执行器 ${action.executor}` : `序列 ${action.sequence}`} ${action.action === 'off' ? '关闭' : action.cue ?? ''} · ${error instanceof Error ? error.message : String(error)}`;
          return false;
        }
      };
      this.tail = this.tail.then(async () => {
        if (this.sessionId !== sessionId || this.failure) return;
        if (entry.releasePrevious) for (const [key, action] of this.started) {
          if (this.sessionId !== sessionId) return;
          const off = action.target === 'executor' ? { target: 'executor' as const, executor: action.executor, action: 'off' as const } : { target: 'sequence' as const, sequence: action.sequence, action: 'off' as const };
          // A release is attempted once; a failed one is reported, never resent.
          await play(off); this.started.delete(key);
        }
        const key = entry.action.target === 'executor' ? `executor:${entry.action.executor}` : `sequence:${entry.action.sequence}`;
        if (this.sessionId !== sessionId || entry.releaseOnlyIfStarted && !this.started.has(key)) return;
        const sent = await play(entry.action);
        if (this.sessionId === sessionId) { if (entry.action.action === 'off') this.started.delete(key); else if (sent) this.started.set(key, entry.action); }
      }).finally(() => { if (this.sessionId === sessionId) this.pending -= 1; });
    }
  }
}
