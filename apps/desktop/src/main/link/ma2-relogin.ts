import { OUTPUT_RECOVERY_RULES, OutputRecovery, ma2ReloginDelayMs, type RecoveryRow } from '@tb/core/link';
import type { Ma2WebRemoteSession } from '@tb/schema';

/** Logging in again cannot help, and a person has to act (no saved login, the secure store, another console or Show, …):
 * stop and say why. */
export class Ma2ReloginStop extends Error {}

/** Which line logs in again: the console page's two web remote sessions (C2), or the Telnet line to the console (M5). */
export type Ma2ReloginLine = 'fader' | 'buttons' | 'console';
/** One line for the run log (category device, device MA2). Waiting is never an error. */
export type Ma2ReloginLog = {
  level: 'info' | 'error'; result: 'queued' | 'succeeded' | 'failed'; message: string;
  details: { session: Ma2ReloginLine; attempt: number; outageMs: number; limitMs: number };
};
/** The words of one line's run log. `seconds`: how long the outage has lasted; `minutes`: the table's limit. */
export type Ma2ReloginWords = {
  attempt(attempt: number, seconds: number, minutes: number, first: boolean, reason: string): string;
  succeeded(attempt: number, seconds: number): string;
  /** `limitText`: the table's own words for the limit. */
  limit(limitText: string, tried: number): string;
  stopped(reason: string): string;
};
/** The rows of the recovery table that limit a relogin: a duration for one outage. */
type ReloginRow = { [K in RecoveryRow]: (typeof OUTPUT_RECOVERY_RULES)[K]['limit'] extends { kind: 'duration' } ? K : never }[RecoveryRow];
export type Ma2ReloginPlan = { row: ReloginRow; line: Ma2ReloginLine; words: Ma2ReloginWords;
  /** What the operator must deal with, so trying again is pointless. Anything else (network, timeout, the line not up) is tried again. */
  needsPerson(error: unknown): boolean };

/** A reason as the windows are told it: what the status schema takes (512 characters), so a long error never makes the state unreadable. */
export const ma2ReloginReason = (reason: string): string => reason.length > 512 ? `${reason.slice(0, 511)}…` : reason;
const seconds = (ms: number): number => Math.max(0, Math.round(ms / 1000));

type State<T> =
  | { kind: 'idle' }
  | { kind: 'connected'; scope: string; target: T }
  | { kind: 'relogin'; scope: string; target: T; attempt: number; since: number; reason: string }
  | { kind: 'stopped'; scope: string; reason: string; limit: boolean };

export type Ma2ReloginClock = { now(): number; after(ms: number, run: () => void): () => void };
const realClock: Ma2ReloginClock = { now: () => Date.now(), after: (ms, run) => { const timer = setTimeout(run, ms); timer.unref(); return () => clearTimeout(timer); } };

/**
 * The one way MA2 logs a line in again on its own after it dropped (C2 for the web remote, M5 for the Telnet line;
 * design 03 §4.2.5 and §10 question 2). Only a line that was connected in this run is logged in again (`connected` arms
 * it, `dropped` starts it), with `login`, which uses only the saved login. The waits come from `ma2ReloginDelayMs`, the
 * limit from the plan's row of the recovery table (five minutes for one outage, counted from the first attempt): at the
 * limit, or when `needsPerson` says so, it stops and waits for the operator. `stop` (the operator connects or disconnects,
 * another console or Show) gives way at once; a login still on its way is dropped by its caller's own generation check.
 * Nothing is resent: a login only makes the line usable again.
 */
export class Ma2Relogin<T> {
  private state: State<T> = { kind: 'idle' };
  private token = 0;
  private cancel: (() => void) | null = null;
  private readonly recovery = new OutputRecovery();
  private readonly limitMs: number;
  constructor(private readonly plan: Ma2ReloginPlan, private readonly login: (target: T) => Promise<void>,
    private readonly log: (entry: Ma2ReloginLog) => void, private readonly clock: Ma2ReloginClock = realClock) {
    this.limitMs = OUTPUT_RECOVERY_RULES[plan.row].limit.maxMs;
  }

  /** Logged in (by the operator, the saved login or this): a later drop is logged in again, with its counts from zero. */
  connected(scope: string, target: T): void {
    const was = this.state;
    this.reset();
    this.state = { kind: 'connected', scope, target };
    if (was.kind === 'relogin' && was.scope === scope) {
      const outageMs = this.clock.now() - was.since;
      this.log({ level: 'info', result: 'succeeded', message: this.plan.words.succeeded(was.attempt, seconds(outageMs)),
        details: { session: this.plan.line, attempt: was.attempt, outageMs, limitMs: this.limitMs } });
    }
  }
  /** The line ended on its own. Only one that was connected starts logging in again. */
  dropped(reason: string): void {
    if (this.state.kind !== 'connected') return;
    this.state = { kind: 'relogin', scope: this.state.scope, target: this.state.target, attempt: 1, since: this.clock.now(), reason };
    this.schedule(1);
  }
  /** Gives way: nothing more is tried, and the counts start again. */
  stop(): void { this.reset(); this.state = { kind: 'idle' }; }
  /** Logging in again now (between attempts or during one). */
  get outage(): boolean { return this.state.kind === 'relogin'; }
  /** What the windows are told for this console and Show. */
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
    this.recovery.endOutage(this.plan.row, this.plan.line);
  }
  private schedule(attempt: number): void {
    const token = this.token;
    this.cancel = this.clock.after(ma2ReloginDelayMs(attempt) ?? this.limitMs, () => { this.cancel = null; void this.run(attempt, token); });
  }
  private async run(attempt: number, token: number): Promise<void> {
    const state = this.state;
    if (token !== this.token || state.kind !== 'relogin') return;
    const { row, line, words } = this.plan;
    const now = this.clock.now(), outageMs = now - state.since;
    const details = { session: line, attempt, outageMs, limitMs: this.limitMs };
    // The table alone decides: its five minutes count from the first attempt, a second after the drop.
    if (this.recovery.record(row, line, now).outcome === 'limit') {
      const limitText = OUTPUT_RECOVERY_RULES[row].limitText;
      this.state = { kind: 'stopped', scope: state.scope, reason: limitText, limit: true };
      this.log({ level: 'error', result: 'failed', message: words.limit(limitText, attempt - 1), details: { ...details, attempt: attempt - 1 } });
      return;
    }
    this.log({ level: 'info', result: 'queued', message: words.attempt(attempt, seconds(outageMs), seconds(this.limitMs) / 60, attempt === 1, state.reason), details });
    try { await this.login(state.target); }
    catch (error) {
      if (token !== this.token) return;
      const reason = error instanceof Error ? error.message : String(error);
      if (this.plan.needsPerson(error)) {
        this.state = { kind: 'stopped', scope: state.scope, reason, limit: false };
        this.log({ level: 'error', result: 'failed', message: words.stopped(reason), details });
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
