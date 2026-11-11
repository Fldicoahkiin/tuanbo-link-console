import type { LightingDocument, Ma2NetworkTarget, Ma2PlaybackAction } from '@tb/schema';
import { OUTPUT_RECOVERY_RULES, OutputRecovery } from './output-recovery';
import type { LightingReleaseSong } from './program-player';

/**
 * The lights-off still owed, in one list for the whole application (design 01 §4.11, R13; 第 4 题 2026-11-11). The
 * program, its song changes, and the editor's and lighting workbench's own previews all owe their Offs here; the main
 * process holds the one ledger (lighting-off-service.ts). Nothing is stored in the project.
 *
 * - A stop owes every executor of the song (lightingReleaseActions). A song change owes only what the previous song used
 *   and the next does not (songChangeOffs). An executor in use is never switched off: a song or preview that starts
 *   names its executors (use), whatever was owed them is struck, and nothing is owed them while its timecode runs them.
 * - Each Off goes out at once. One that did not go out (no console, refused, timed out) stays owed and red. When the
 *   console connects again (a new connection number) it is sent once more, as the `lighting.offResend` row of
 *   OUTPUT_RECOVERY_RULES says; past that it stays owed. Pressing stop again sends every unconfirmed Off once more: the
 *   operator asked, so it does not count.
 * - An Off counts as confirmed when the console answered it without error ("控台已收到关闭指令"); whether the executor
 *   really went off is a later read-back (p1-ma2).
 */

/** Scope Stop to the selected song: the executors its console timeline runs. No global Off, Master or
 * blackout command. This is the only lighting command a playing song sends besides timecode. */
export function lightingReleaseActions(document: LightingDocument): Ma2PlaybackAction[] {
  const actions: Ma2PlaybackAction[] = [];
  for (const binding of document.ma2Bindings ?? []) {
    for (const mapping of [...binding.mappings, ...binding.trackMappings ?? []]) actions.push({ target: 'executor', executor: mapping.executor, action: 'off' });
  }
  // The song's own console sequence keeps its last Cue on after the timecode stops.
  if (document.consoleSong?.executor) actions.push({ target: 'executor', executor: document.consoleSong.executor, action: 'off' });
  return [...new Map(actions.map(action => [JSON.stringify(action), action])).values()];
}

/** The executors a song's console timeline runs: the ones its stop switches off. */
export function lightingExecutors(document: LightingDocument | null): string[] {
  return document ? lightingReleaseActions(document).flatMap(action => action.target === 'executor' ? [action.executor] : []) : [];
}

/** A song change (第 4 题): the Offs of what `previous` used and `next` does not. What both use stays on, with the next
 * song's timecode; without `next` (a song without lighting) every executor of `previous` goes off. */
export function songChangeOffs(previous: LightingDocument, next: LightingDocument | null): Ma2PlaybackAction[] {
  const kept = new Set(lightingExecutors(next));
  return lightingReleaseActions(previous).filter(action => action.target !== 'executor' || !kept.has(action.executor));
}

/** Why an Off is owed. */
export type LightingOffCause = 'stop' | 'song-change' | 'preview' | 'close';
/** One owed Off. `sending`: on its way, waiting for the console's answer; `failed`: it did not go out, `reason` says
 * why. A confirmed Off leaves the list. `failedOn`: the console connection it failed on (Ma2NetworkStatus.connection);
 * a different one that is connected sends it once more. `resent`: the one resend after a connect was made. */
export type OwedOff = { executor: string; action: Ma2PlaybackAction; song: LightingReleaseSong | null; cause: LightingOffCause;
  network: Ma2NetworkTarget | null; state: 'sending' | 'failed'; reason: string | null; resent: boolean; failedOn: number | null;
  /** Each send gets a new number: an answer to an earlier send of the same executor does not settle this one. */
  attempt: number };
/** One Off to send now, as the ledger hands it out. */
export type OffSend = Pick<OwedOff, 'executor' | 'action' | 'song' | 'network' | 'attempt' | 'resent'>;
/** Who runs executors from its timecode: the program, or what the window runs itself (a preview, P1 following). */
export type LightingUser = 'program' | 'window';

const resendRow = 'lighting.offResend' as const;

export class LightingOffLedger {
  private readonly entries = new Map<string, OwedOff>();
  private readonly recovery = new OutputRecovery();
  private readonly users = new Map<LightingUser, ReadonlySet<string>>();
  private attempts = 0;

  /** `actions` are owed for `song`, sent now: each replaces what the list owed for that executor (a fresh Off, which may
   * be resent again). An executor in use (`use`) is never owed. `network`: the console they are for, when one is known. */
  owe(actions: readonly Ma2PlaybackAction[], song: LightingReleaseSong | null, cause: LightingOffCause, network: Ma2NetworkTarget | null): OffSend[] {
    return actions.flatMap(action => {
      if (action.target !== 'executor' || this.used(action.executor)) return [];
      this.recovery.forget(resendRow, action.executor);
      const entry: OwedOff = { executor: action.executor, action, song, cause, network, state: 'sending', reason: null, resent: false,
        failedOn: null, attempt: ++this.attempts };
      this.entries.set(action.executor, entry);
      return [send(entry)];
    });
  }

  /** `user`'s timecode runs these executors from now on, in place of what it ran before (none: it stopped). Whatever the
   * list owed them is dropped, never sent, and nothing is owed them while they are in use. */
  use(user: LightingUser, executors: Iterable<string>): void {
    const using = new Set(executors);
    this.users.set(user, using);
    for (const executor of using) if (this.entries.delete(executor)) this.recovery.forget(resendRow, executor);
  }
  /** The executors `user`'s timecode runs now. */
  using(user: LightingUser): string[] { return [...this.users.get(user) ?? []]; }
  /** Some timecode runs this executor now. */
  used(executor: string): boolean { return [...this.users.values()].some(using => using.has(executor)); }

  /** The console answered this send without error: the Off leaves the list. False when the list moved on meanwhile. */
  ack(executor: string, attempt: number): boolean {
    if (this.entries.get(executor)?.attempt !== attempt) return false;
    this.entries.delete(executor); this.recovery.forget(resendRow, executor);
    return true;
  }

  /** This send did not go out: it stays owed, with why. `connection`: the connected console it failed on, null when none
   * was connected (any connection then sends it once more). `network`: the console it was meant for, kept for the resend.
   * Null when the list moved on meanwhile. */
  fail(executor: string, attempt: number, reason: string, connection: number | null, network: Ma2NetworkTarget | null): OwedOff | null {
    const entry = this.entries.get(executor);
    if (entry?.attempt !== attempt) return null;
    const failed: OwedOff = { ...entry, state: 'failed', reason, failedOn: connection, network: entry.network ?? network };
    this.entries.set(executor, failed);
    return failed;
  }

  /** The console is connected as `connection`: each failed Off that failed on another connection is sent once more
   * (OUTPUT_RECOVERY_RULES `lighting.offResend`); one past the limit stays owed and is not sent. */
  onConnected(connection: number, now: number): OffSend[] {
    return [...this.entries.values()].flatMap(entry => {
      if (entry.state !== 'failed' || entry.failedOn === connection) return [];
      // A recovery made now: counted, and past the limit it waits for the operator.
      if (this.recovery.record(resendRow, entry.executor, now).outcome === 'limit') return [];
      const resent: OwedOff = { ...entry, state: 'sending', resent: true, attempt: ++this.attempts };
      this.entries.set(entry.executor, resent);
      return [send(resent)];
    });
  }

  /** The operator pressed stop again (第 4 题): every Off not confirmed is sent once more. It does not count as an
   * automatic resend. One still on its way is left to its answer. */
  resendOnStop(): OffSend[] {
    return [...this.entries.values()].flatMap(entry => {
      if (entry.state !== 'failed') return [];
      const again: OwedOff = { ...entry, state: 'sending', attempt: ++this.attempts };
      this.entries.set(entry.executor, again);
      return [send(again)];
    });
  }

  /** Every Off not confirmed, in the order owed. */
  owed(): readonly OwedOff[] { return [...this.entries.values()]; }
  /** An Off is on its way to the console. */
  sending(): boolean { return [...this.entries.values()].some(entry => entry.state === 'sending'); }
  /** An Off did not go out and waits. */
  waiting(): boolean { return [...this.entries.values()].some(entry => entry.state === 'failed'); }
}

function send(entry: OwedOff): OffSend {
  return { executor: entry.executor, action: entry.action, song: entry.song, network: entry.network, attempt: entry.attempt, resent: entry.resent };
}

/** An Off did not go out (2026-11-09): what happened, why, and what the operator does. It names the song the Off was
 * for; "这首歌" when none is named (a preview). The reason is only the reason: the last sentence says what to do. */
export function lightsLeftOnText(song: LightingReleaseSong | null, reason: string): string {
  return `${songName(song)}的灯光没能完全关闭，控台上可能还亮着。原因：${trimReason(reason)}。请在控台上关掉这首歌的执行器。`;
}

/** The one resend after a connect did not go out either: the Off stays owed (OUTPUT_RECOVERY_RULES says what to do). */
export function lightsLeftOnAfterResendText(song: LightingReleaseSong | null, reason: string): string {
  return `${songName(song)}的灯光没能完全关闭，控台上可能还亮着。原因：${trimReason(reason)}。${OUTPUT_RECOVERY_RULES[resendRow].limitText}。`;
}

/** What the quit asks about (programLightsQuitPrompt): one sentence per song that still owes an Off. */
export function owedOffTexts(owed: readonly OwedOff[]): string[] {
  const bySong = new Map<string, OwedOff>();
  for (const entry of owed) bySong.set(entry.song?.itemId ?? '', bySong.get(entry.song?.itemId ?? '') ?? entry);
  return [...bySong.values()].map(entry => lightsLeftOnText(entry.song, entry.reason ?? '没有收到控台的确认'));
}

function songName(song: LightingReleaseSong | null): string { return song?.title ? `「${song.title}」` : '这首歌'; }
function trimReason(reason: string): string { return reason.replace(/[。.；;\s]+$/u, '') || '未知错误'; }
