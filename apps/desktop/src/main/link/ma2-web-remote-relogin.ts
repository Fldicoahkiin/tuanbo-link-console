import { OUTPUT_RECOVERY_RULES, OutputRecovery, ma2ReloginDelayMs } from '@tb/core/link';
import type { Ma2WebRemoteSession } from '@tb/schema';
import { Ma2LoginRefused } from './ma2-live-playback';
import { Ma2ShowSourceChanged } from './ma2-show-probe';

/** Logging in again cannot help, and a person has to act (no saved user, the secure store, …): stop and say why. */
export class Ma2ReloginStop extends Error {}

/** Which web remote session of the console page: the fader view's, or the Button area's (C2). */
export type Ma2ReloginSession = 'fader' | 'buttons';
/** One line for the run log (category device, device MA2). Waiting is never an error. */
export type Ma2ReloginLog = {
  level: 'info' | 'error'; result: 'queued' | 'succeeded' | 'failed'; message: string;
  details: { session: Ma2ReloginSession; attempt: number; outageMs: number; limitMs: number };
};

const ROW = 'ma2.webRemote.relogin';
const RULE = OUTPUT_RECOVERY_RULES[ROW];
const LIMIT_MS = RULE.limit.maxMs;
const LABEL: Record<Ma2ReloginSession, string> = { fader: '推杆区', buttons: 'Button 区' };
const seconds = (ms: number): number => Math.max(0, Math.round(ms / 1000));
/** A reason as the windows are told it: what the status schema takes (512 characters), so a long error never makes the state unreadable. */
export const ma2ReloginReason = (reason: string): string => reason.length > 512 ? `${reason.slice(0, 511)}…` : reason;
/** What the operator must deal with, so trying again is pointless. Anything else (network, timeout, the Telnet line not up) is tried again. */
function needsPerson(error: unknown): boolean { return error instanceof Ma2ReloginStop || error instanceof Ma2LoginRefused || error instanceof Ma2ShowSourceChanged; }

type State<T> =
  | { kind: 'idle' }
  | { kind: 'connected'; scope: string; target: T }
  | { kind: 'relogin'; scope: string; target: T; attempt: number; since: number; reason: string }
  | { kind: 'stopped'; scope: string; reason: string; limit: boolean };

export type Ma2ReloginClock = { now(): number; after(ms: number, run: () => void): () => void };
const realClock: Ma2ReloginClock = { now: () => Date.now(), after: (ms, run) => { const timer = setTimeout(run, ms); return () => clearTimeout(timer); } };

/**
 * Logging one web remote session in again on its own after it dropped (C2, design 03 §10 question 2). Only a session that
 * was connected in this run is logged in again (`connected` arms it, `dropped` starts it), with `login`, which uses only the
 * saved user. The waits come from `ma2ReloginDelayMs`, the limit from the recovery table (`ma2.webRemote.relogin`, five
 * minutes for one outage): at the limit, or when the console refused or nothing is saved, it stops and waits for the
 * operator. `stop` (the operator connects, another console or Show, the keys go on the plugin) gives way at once; a login
 * still on its way is dropped by its caller's own generation check. Nothing is resent: a login only makes the session
 * usable again.
 */
export class Ma2WebRemoteRelogin<T> {
  private state: State<T> = { kind: 'idle' };
  private token = 0;
  private cancel: (() => void) | null = null;
  private readonly recovery = new OutputRecovery();
  constructor(private readonly session: Ma2ReloginSession, private readonly login: (target: T) => Promise<void>,
    private readonly log: (entry: Ma2ReloginLog) => void, private readonly clock: Ma2ReloginClock = realClock) {}

  /** Logged in (by the operator, the saved user or this): a later drop is logged in again, with its counts from zero. */
  connected(scope: string, target: T): void {
    const was = this.state;
    this.reset();
    this.state = { kind: 'connected', scope, target };
    if (was.kind === 'relogin' && was.scope === scope) {
      const outageMs = this.clock.now() - was.since;
      this.log({ level: 'info', result: 'succeeded', message: `网页遥控（${LABEL[this.session]}）自动重新登录成功：第 ${was.attempt} 次登上，断了 ${seconds(outageMs)} 秒`,
        details: { session: this.session, attempt: was.attempt, outageMs, limitMs: LIMIT_MS } });
    }
  }
  /** The session ended on its own. Only one that was connected starts logging in again. */
  dropped(reason: string): void {
    if (this.state.kind !== 'connected') return;
    this.state = { kind: 'relogin', scope: this.state.scope, target: this.state.target, attempt: 1, since: this.clock.now(), reason };
    this.schedule(1);
  }
  /** Gives way: nothing more is tried, and the counts start again. */
  stop(): void { this.reset(); this.state = { kind: 'idle' }; }
  /** What the console page is told for this console and Show. */
  view(scope: string): Ma2WebRemoteSession | null {
    const state = this.state;
    if (state.kind === 'idle' || state.scope !== scope) return null;
    switch (state.kind) {
      case 'connected': return { kind: 'connected' };
      case 'relogin': return { kind: 'relogin', attempt: state.attempt, since: state.since, reason: ma2ReloginReason(state.reason) };
      case 'stopped': return { kind: 'stopped', reason: ma2ReloginReason(state.reason), limit: state.limit };
    }
  }

  private reset(): void {
    this.token += 1; this.cancel?.(); this.cancel = null;
    this.recovery.endOutage(ROW, this.session);
  }
  private schedule(attempt: number): void {
    const token = this.token;
    this.cancel = this.clock.after(ma2ReloginDelayMs(attempt) ?? RULE.limit.maxMs, () => { this.cancel = null; void this.run(attempt, token); });
  }
  private async run(attempt: number, token: number): Promise<void> {
    const state = this.state;
    if (token !== this.token || state.kind !== 'relogin') return;
    const now = this.clock.now(), outageMs = now - state.since;
    const details = { session: this.session, attempt, outageMs, limitMs: LIMIT_MS };
    // The table alone decides: its five minutes count from the first attempt, a second after the drop.
    if (this.recovery.record(ROW, this.session, now).outcome === 'limit') {
      this.state = { kind: 'stopped', scope: state.scope, reason: RULE.limitText, limit: true };
      this.log({ level: 'error', result: 'failed', message: `${RULE.limitText}（${LABEL[this.session]}，试了 ${attempt - 1} 次）`, details: { ...details, attempt: attempt - 1 } });
      return;
    }
    this.log({ level: 'info', result: 'queued', message: `网页遥控（${LABEL[this.session]}）断了，第 ${attempt} 次自动重新登录：已经断了 ${seconds(outageMs)} 秒，最多试 ${seconds(LIMIT_MS) / 60} 分钟。${attempt === 1 ? '断开的原因' : '上一次没登上'}：${state.reason}`, details });
    try { await this.login(state.target); }
    catch (error) {
      if (token !== this.token) return;
      const reason = error instanceof Error ? error.message : String(error);
      if (needsPerson(error)) {
        this.state = { kind: 'stopped', scope: state.scope, reason, limit: false };
        this.log({ level: 'error', result: 'failed', message: `网页遥控（${LABEL[this.session]}）没有再自动重新登录：${reason}`, details });
        return;
      }
      this.state = { ...state, attempt: attempt + 1, reason };
      this.schedule(attempt + 1);
      return;
    }
    // `login` may have marked it connected itself (a key logged the Button session in at the same time): that said it already.
    if (token === this.token) this.connected(state.scope, state.target);
  }
}
