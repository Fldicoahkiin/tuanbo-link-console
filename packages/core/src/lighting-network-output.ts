import { compileLightingNetworkActions, type LightingNetworkAction } from './lighting-playback';
import type { LinkDesktopApi } from './link-desktop-contract';
import { ma2NetworkStatusSchema, type LightingDocument, type Ma2NetworkTarget } from '@tb/schema';

/** Explicit network output. Pausing or seeking invalidates unsent work; failures never retry. */
export class LightingNetworkOutput {
  private actions: LightingNetworkAction[] = [];
  private cursor = 0;
  private position = 0;
  private sessionId: string | null = null;
  private target: Ma2NetworkTarget | null = null;
  private tail: Promise<void> = Promise.resolve();
  private failure: Error | null = null;
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
    this.cancelSession(); this.failure = null; this.pending = 0; this.tail = Promise.resolve();
    this.sessionId = this.target ? crypto.randomUUID() : null;
    this.position = positionMs;
    const next = this.actions.findIndex(entry => entry.atMs >= positionMs);
    this.cursor = next < 0 ? this.actions.length : next;
  }
  tick(positionMs: number): void { this.advance(positionMs, false); }
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
      if (this.pending >= 32) { this.stop(); throw new Error('灯光网络指令积压，已停止输出；请减少同时调用的素材并重新定位'); }
      this.cursor += 1; this.pending += 1;
      const deadlineAt = Date.now() + 1000;
      this.tail = this.tail.then(async () => {
        if (this.sessionId !== sessionId || this.failure) return;
        await this.api.playMa2Cue({ sessionId, network, action: entry.action, deadlineAt });
      }).catch((error: unknown) => {
        if (this.sessionId !== sessionId) return;
        this.failure = error instanceof Error ? error : new Error(String(error)); this.cancelSession();
      }).finally(() => { if (this.sessionId === sessionId) this.pending -= 1; });
    }
  }
}
