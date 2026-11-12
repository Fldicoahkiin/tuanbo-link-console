import { OUTPUT_RECOVERY_RULES, OutputRecovery, obsReconnectDelayMs, type LinkObsSnapshot, type ObsAutoReconnect } from '@tb/core/link';

const RULE = OUTPUT_RECOVERY_RULES['obs.reconnect'];
const KEY = 'obs';

export type ObsReconnectLog = { level: 'warning' | 'info' | 'error'; message: string; result: 'succeeded' | 'failed';
  details: { channel: 'obs'; item: 'obs.reconnect'; attempt: number; max: number; reason: string | null; recoveries: { row: 'obs.reconnect'; key: string; count: number; max: number }[] } };
type Dependencies = {
  /** Connects with the address and password of this computer's device settings, as the operator's own connect does. */
  connect: () => Promise<LinkObsSnapshot>;
  /** Runs `run` after `ms`; the result cancels it. */
  schedule: (ms: number, run: () => void) => () => void;
  now: () => number;
  log: (entry: ObsReconnectLog) => void;
  /** The automatic reconnect's state changed (null: none), for the status the windows show. */
  changed: (state: ObsAutoReconnect | null) => void;
};

/**
 * OBS reconnected by itself after it dropped (0.5.9 R7, design 01 §4.7; 2026-11-10 decision 2). Only once the operator
 * connected OBS and only when they did not disconnect it themselves; the waits and the number of attempts are the
 * `obs.reconnect` row of output-recovery.ts and nowhere else. Every attempt is logged with its number and the limit;
 * at the limit it stops, in red, until the operator connects. It never starts OBS and never asks for elevation: an OBS
 * running as administrator is reconnected the same way (2026-10-25).
 *
 * The operator comes first: while their own connect runs nothing is attempted, and one in flight is waited for, not
 * raced; their disconnect stops reconnecting until they connect again; their successful connect starts the count
 * again. A failed connect of theirs during an outage leaves the attempts where they were and goes on with the next.
 */
export class ObsReconnector {
  private readonly recovery = new OutputRecovery();
  /** The operator connected OBS and has not disconnected it since. */
  private armed = false;
  /** The operator's own connects in flight: they own every OBS state change meanwhile. */
  private manualRuns = 0;
  /** The automatic attempt in flight, if any. */
  private attempt: Promise<void> | null = null;
  private cancel: (() => void) | null = null;
  /** Bumped when an outage ends or the operator takes over: a timer or an attempt from before does nothing. */
  private outage = 0;
  private current: ObsAutoReconnect | null = null;
  private lastReason: string | null = null;

  constructor(private readonly dependencies: Dependencies) {}

  get state(): ObsAutoReconnect | null { return this.current; }

  /** Every OBS connection state. Only a loss nobody asked for, after the operator connected, starts reconnecting. */
  observe(snapshot: LinkObsSnapshot): void {
    if (this.manualRuns > 0 || this.attempt) return;
    if (snapshot.status === 'connected' || snapshot.status === 'connecting' || snapshot.status === 'reconnecting') return;
    this.lastReason = snapshot.error;
    if (!this.armed || this.current) return;
    this.outage++;
    this.next();
  }

  /** The operator's connect (the 连接 button, one-click connect, a repair's reconnect): attempted alone, waiting for an
   * automatic attempt already in flight. Connected, OBS is reconnected after a later loss and the count starts again. */
  async manual<T>(connect: () => Promise<T>): Promise<T> {
    this.manualRuns++;
    this.stopTimer();
    const resume = this.current?.state === 'waiting' || this.current?.state === 'connecting';
    try {
      await Promise.allSettled(this.attempt ? [this.attempt] : []);
      const result = await connect();
      this.armed = true; this.outage++;
      this.recovery.endOutage('obs.reconnect', KEY); this.set(null);
      return result;
    } catch (error) {
      // The operator's attempt failed: an outage in progress goes on from the attempt it was at; one that had given up
      // stays given up, and the operator's own error says why.
      if (!resume) this.set(null);
      throw error;
    } finally {
      this.manualRuns--;
      if (this.manualRuns === 0 && resume && this.current) this.next();
    }
  }

  /** The operator's disconnect: OBS is not reconnected until they connect again. */
  async manualDisconnect<T>(disconnect: () => Promise<T>): Promise<T> {
    this.armed = false; this.outage++; this.stopTimer(); this.set(null);
    await Promise.allSettled(this.attempt ? [this.attempt] : []);
    return disconnect();
  }

  /** The next attempt after its wait, or the limit. */
  private next(): void {
    const attempt = (this.recovery.counts().find(count => count.row === 'obs.reconnect' && count.key === KEY)?.count ?? 0) + 1;
    const delay = obsReconnectDelayMs(attempt);
    if (delay === null || !this.recovery.allows('obs.reconnect', KEY, this.dependencies.now())) { this.giveUp(attempt - 1); return; }
    const outage = this.outage;
    this.set({ state: 'waiting', attempt, max: RULE.limit.max });
    this.cancel = this.dependencies.schedule(delay, () => { this.cancel = null; if (outage === this.outage) this.run(outage); });
  }

  private run(outage: number): void {
    if (!this.armed || this.manualRuns > 0) return;
    const result = this.recovery.record('obs.reconnect', KEY, this.dependencies.now());
    if (result.outcome === 'limit') { this.giveUp(result.count - 1); return; }
    const attempt = result.count, max = RULE.limit.max;
    this.set({ state: 'connecting', attempt, max });
    this.log('warning', `OBS 断开了，正在自动重连（第 ${attempt} 次，最多 ${max} 次）`, 'succeeded', attempt);
    this.attempt = this.dependencies.connect().then(snapshot => {
      if (outage !== this.outage) return;
      if (snapshot.status !== 'connected') throw new Error(snapshot.error ?? 'OBS 没有连上');
      this.recovery.endOutage('obs.reconnect', KEY); this.outage++; this.set(null);
      this.log('info', `OBS 已自动重新连上（第 ${attempt} 次）`, 'succeeded', attempt);
    }).catch((error: unknown) => {
      if (outage !== this.outage) return;
      this.lastReason = error instanceof Error ? error.message : String(error);
      // The operator's connect waited for this one: it goes on with the next attempt if theirs fails.
      if (this.manualRuns === 0) this.next();
    }).finally(() => { this.attempt = null; });
  }

  private giveUp(attempts: number): void {
    this.set({ state: 'gave-up', attempts, max: RULE.limit.max, text: RULE.limitText });
    this.log('error', `${RULE.limitText}（自动重连了 ${attempts} 次）`, 'failed', attempts);
  }

  private log(level: ObsReconnectLog['level'], message: string, result: ObsReconnectLog['result'], attempt: number): void {
    const max = RULE.limit.max;
    this.dependencies.log({ level, message, result, details: { channel: 'obs', item: 'obs.reconnect', attempt, max, reason: this.lastReason,
      recoveries: [{ row: 'obs.reconnect', key: KEY, count: attempt, max }] } });
  }
  private stopTimer(): void { this.cancel?.(); this.cancel = null; }
  private set(state: ObsAutoReconnect | null): void {
    if (JSON.stringify(state) === JSON.stringify(this.current)) return;
    this.current = state; this.dependencies.changed(state);
  }
}
