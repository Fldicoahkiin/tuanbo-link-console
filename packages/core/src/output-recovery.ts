import type { OutputChannel } from './output-failure';

/**
 * The one table of automatic recoveries and their limits in the whole application
 * (2026-11-10 decision 2; numbers fixed 2026-11-11, design 00 §8 item 2; one table,
 * design 00 §2 item 10). Nothing else may retry on its own: a new kind of recovery
 * adds a row here. Every recovery is marked red and logged by its caller; at the
 * limit it stops and waits for the operator.
 *
 * A row counts either
 * - `attempts`: recoveries made; the one past `max` is refused, or
 * - `faults`: faults seen; the `max`-th fault reaches the limit (no recovery after it).
 * A limit is a plain count, a count inside a sliding window, or a duration from the
 * first attempt. Once reached, a key stays at its limit until it is reset.
 */
export type RecoveryLimit =
  | { kind: 'count'; max: number }
  | { kind: 'window'; max: number; windowMs: number }
  | { kind: 'duration'; maxMs: number };
/** When the counters start again: each song, each outage (a successful reconnect), or each item when it is done. */
export type RecoveryReset = 'song' | 'outage' | 'item';
/** What happens at the limit. */
export type RecoveryStop = 'no-more-repair' | 'stop-song' | 'stop-timecode-for-song' | 'stop-reconnecting' | 'leave-owed' | 'stop-channel';
export type RecoveryRule = { channel: OutputChannel; counts: 'attempts' | 'faults'; limit: RecoveryLimit; reset: RecoveryReset;
  atLimit: RecoveryStop; limitText: string };

/** OBS reconnect waits: 1, 2, 4, 8 s, then 15 s each, ten attempts, about two minutes in all. */
export const OBS_RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15_000, 15_000, 15_000, 15_000, 15_000, 15_000] as const;

export const OUTPUT_RECOVERY_RULES = {
  /** Each picture element once per wanted state; the key carries the state, so a cut point starts afresh. */
  'picture.element': { channel: 'obs', counts: 'attempts', limit: { kind: 'count', max: 1 }, reset: 'song', atLimit: 'no-more-repair',
    limitText: '这一项画面补发了一次还是没成功，到下一段会按时间线照常切换。请检查 OBS 里的这个场景或来源' },
  'picture.song': { channel: 'obs', counts: 'attempts', limit: { kind: 'count', max: 20 }, reset: 'song', atLimit: 'no-more-repair',
    limitText: '这首歌自动补画面已到上限，后面只按时间线切换。请检查 OBS 是否卡顿' },
  /** Clip and music drifting apart: one correction per clip per minute (01 §4.6). */
  'picture.drift': { channel: 'obs', counts: 'attempts', limit: { kind: 'window', max: 1, windowMs: 60_000 }, reset: 'song', atLimit: 'no-more-repair',
    limitText: '素材和音乐一直对不上，请检查 OBS 是否卡顿' },
  'obs.reconnect': { channel: 'obs', counts: 'attempts', limit: { kind: 'count', max: OBS_RECONNECT_DELAYS_MS.length }, reset: 'outage', atLimit: 'stop-reconnecting',
    limitText: 'OBS 自动重连没成功，请检查 OBS 后点连接' },
  /** Picture restored after a reconnect, per song (01 §4.6). */
  'obs.restore': { channel: 'obs', counts: 'attempts', limit: { kind: 'count', max: 5 }, reset: 'song', atLimit: 'no-more-repair',
    limitText: 'OBS 重连后恢复画面的次数已到上限，这首歌的画面不再自动恢复，音乐和时间码照常' },
  'ma2.relogin': { channel: 'ma2', counts: 'attempts', limit: { kind: 'duration', maxMs: 5 * 60_000 }, reset: 'outage', atLimit: 'stop-reconnecting',
    limitText: '控台断线 5 分钟还没能自动重新登录，请检查控台和网络后手动连接' },
  'ma2.webRemote.relogin': { channel: 'ma2', counts: 'attempts', limit: { kind: 'duration', maxMs: 5 * 60_000 }, reset: 'outage', atLimit: 'stop-reconnecting',
    limitText: '网页遥控断线 5 分钟还没能自动重新登录，请检查控台和网络后手动连接' },
  'audio.underrun': { channel: 'audio', counts: 'faults', limit: { kind: 'window', max: 5, windowMs: 60_000 }, reset: 'song', atLimit: 'stop-song',
    limitText: '声卡 1 分钟内断流 5 次，这首歌已停下。请检查声卡后重新播放' },
  'mtc.sendFailure': { channel: 'mtc', counts: 'faults', limit: { kind: 'count', max: 3 }, reset: 'song', atLimit: 'stop-timecode-for-song',
    limitText: '时间码多次发送失败，这首歌不再发时间码。请检查接口' },
  /** Action MIDI replies that the previous SysEx is still sending (-6), one after another: each skips its own message;
   * at the limit the driver counts as stuck and the port stops. The key is the run of -6 replies: any other reply
   * forgets it (design 00 §10). */
  'actionMidi.stuckSysex': { channel: 'actionMidi', counts: 'faults', limit: { kind: 'count', max: 3 }, reset: 'item', atLimit: 'stop-channel',
    limitText: 'MIDI 输出失败：上一条 SysEx 连续 3 次没有发完，接口的驱动可能卡住了。这个输出已停止，请检查接口后重新播放' },
  /** An unconfirmed lights-off is sent once more after MA2 connects; the key is the owed off. */
  'lighting.offResend': { channel: 'ma2', counts: 'attempts', limit: { kind: 'count', max: 1 }, reset: 'item', atLimit: 'leave-owed',
    limitText: '关灯补发了一次控台还是没确认，已留在还欠着的关灯里。请检查控台后再按一次停止' }
} as const satisfies Record<string, RecoveryRule>;
export type RecoveryRow = keyof typeof OUTPUT_RECOVERY_RULES;

export type RecoveryResult = { row: RecoveryRow; key: string; channel: OutputChannel; outcome: 'recover' | 'limit';
  /** Attempts or faults so far, this one included. */
  count: number; limit: RecoveryLimit; atLimit: RecoveryStop; limitText: string };

/** What the reconcile planner may ask without counting anything. */
export type RecoveryBudgetView = { allows(row: RecoveryRow, key: string, now: number): boolean };

type Counter = { row: RecoveryRow; key: string; times: number[]; firstAt: number; exhausted: boolean };
const counterKey = (row: RecoveryRow, key: string): string => `${row}\u0000${key}`;

/** The pure ledger of recoveries: one per song for the song rows, owned by its host. Time comes from the caller. */
export class OutputRecovery implements RecoveryBudgetView {
  private readonly counters = new Map<string, Counter>();

  allows(row: RecoveryRow, key: string, now: number): boolean {
    const counter = this.counters.get(counterKey(row, key));
    return !counter || judge(OUTPUT_RECOVERY_RULES[row], live(OUTPUT_RECOVERY_RULES[row], counter, now).length, counter, now) === 'recover';
  }

  /** One attempt or fault happened now. `limit`: stop, as the row says. */
  record(row: RecoveryRow, key: string, now: number): RecoveryResult {
    const rule: RecoveryRule = OUTPUT_RECOVERY_RULES[row];
    const name = counterKey(row, key);
    const counter = this.counters.get(name) ?? { row, key, times: [], firstAt: now, exhausted: false };
    const before = live(rule, counter, now);
    const outcome = judge(rule, before.length, counter, now);
    const times = [...before, now];
    this.counters.set(name, { ...counter, times, exhausted: counter.exhausted || outcome === 'limit' });
    return { row, key, channel: rule.channel, outcome, count: times.length, limit: rule.limit, atLimit: rule.atLimit, limitText: rule.limitText };
  }

  /** A new song: every song row starts again. Outage and item rows are kept. */
  resetSong(): void {
    for (const [name, counter] of [...this.counters]) if (OUTPUT_RECOVERY_RULES[counter.row].reset === 'song') this.counters.delete(name);
  }
  /** The outage ended (reconnected): its attempts start again next time. */
  endOutage(row: RecoveryRow, key: string): void { this.counters.delete(counterKey(row, key)); }
  /** The item is done (an owed off confirmed or dropped). */
  forget(row: RecoveryRow, key: string): void { this.counters.delete(counterKey(row, key)); }

  /** Counts for the status DTO and the diagnostics. */
  counts(): { row: RecoveryRow; key: string; count: number; exhausted: boolean }[] {
    return [...this.counters.values()].map(counter => ({ row: counter.row, key: counter.key, count: counter.times.length, exhausted: counter.exhausted }));
  }
}

/** The OBS reconnect wait before attempt `attempt` (1-based), or null past the limit. */
export function obsReconnectDelayMs(attempt: number): number | null {
  return Number.isInteger(attempt) && attempt >= 1 ? OBS_RECONNECT_DELAYS_MS[attempt - 1] ?? null : null;
}

/** A picture element may be sent once more against `target` while the song still has repairs left. */
export function pictureRepairAllowed(budget: RecoveryBudgetView, element: string, target: string, now: number): boolean {
  return budget.allows('picture.element', pictureRepairKey(element, target), now) && budget.allows('picture.song', 'song', now);
}
export function pictureRepairKey(element: string, target: string): string { return `${element}@${target}`; }
/** Counts one picture repair on the element and on the song. */
export function recordPictureRepair(recovery: OutputRecovery, element: string, target: string, now: number): RecoveryResult[] {
  return [recovery.record('picture.element', pictureRepairKey(element, target), now), recovery.record('picture.song', 'song', now)];
}

/** Times still inside the row's window. */
function live(rule: RecoveryRule, counter: Counter, now: number): number[] {
  const limit = rule.limit;
  return limit.kind === 'window' ? counter.times.filter(time => now - time < limit.windowMs) : counter.times;
}

/** Would one more attempt or fault, after `before` that still count, recover? */
function judge(rule: RecoveryRule, before: number, counter: Counter, now: number): 'recover' | 'limit' {
  if (counter.exhausted) return 'limit';
  const limit = rule.limit;
  if (limit.kind === 'duration') return now - counter.firstAt < limit.maxMs ? 'recover' : 'limit';
  const count = before + 1;
  return rule.counts === 'attempts' ? (count <= limit.max ? 'recover' : 'limit') : (count < limit.max ? 'recover' : 'limit');
}
