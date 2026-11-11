import type { LightingDocument, Ma2NetworkTarget, Ma2PlaybackAction } from '@tb/schema';
import { LIGHTING_OFF_READ_BACK, OUTPUT_RECOVERY_RULES, OutputRecovery } from './output-recovery';
import type { LightingReleaseSong, LitSong } from './program-player';

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
 * - An Off counts as confirmed when the console answered it without error ("控台已收到关闭指令") and leaves the list.
 * - Read-back (M8, 2026-11-11): a confirmed Off may then be read back on a web remote session already connected
 *   (lighting-off-service.ts, LIGHTING_OFF_READ_BACK). `off`: done, as confirmed. `unknown` (nothing read, or the read
 *   failed): done, as confirmed, with the reason noted. `running`: the executor still runs, so it is owed again in state
 *   `running` (shown in yellow, not red): pressing stop again sends it once more; a connect does not, and the quit does
 *   not ask about it. An executor in use or owed afresh meanwhile is no longer waiting for its read-back.
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

/** The versions of a song's lighting the console may have run in this pass, oldest first (0.5.9 S8a). */
export function litDocuments(lit: LitSong): LightingDocument[] { return [...lit.earlier ?? [], lit.document]; }
/** Every executor any version of the song's lighting in this pass runs: what its stop switches off. */
export function litExecutors(lit: LitSong | null): string[] {
  return lit ? [...new Set(litDocuments(lit).flatMap(document => lightingExecutors(document)))] : [];
}
/** The Offs of every version of the song's lighting in this pass, once per executor. */
export function litReleaseActions(lit: LitSong): Ma2PlaybackAction[] {
  const actions = litDocuments(lit).flatMap(document => lightingReleaseActions(document));
  return [...new Map(actions.map(action => [JSON.stringify(action), action])).values()];
}
/** A song change (第 4 题) after a pass that may have run several versions of the previous song's lighting: the Offs of
 * every executor those versions used and the next song does not. */
export function litChangeOffs(previous: LitSong, next: LitSong | null): Ma2PlaybackAction[] {
  const kept = new Set(litExecutors(next));
  return litReleaseActions(previous).filter(action => action.target !== 'executor' || !kept.has(action.executor));
}
/** The song on air with a newer version of its lighting (0.5.9 S8a): the versions before it stay part of this pass, so
 * the executors it holds only grow until it stops. The same document again changes nothing. */
export function litAlso(lit: LitSong | null, document: LightingDocument, song: LightingReleaseSong): LitSong {
  if (!lit) return { document, song };
  if (litDocuments(lit).includes(document)) return lit;
  return { document, song: lit.song, earlier: litDocuments(lit) };
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
 * why; `running`: confirmed, but read back still running (M8). A confirmed Off leaves the list. `failedOn`: the console connection it failed on (Ma2NetworkStatus.connection);
 * a different one that is connected sends it once more. `resent`: the one resend after a connect was made. */
export type OwedOff = { executor: string; action: Ma2PlaybackAction; song: LightingReleaseSong | null; cause: LightingOffCause;
  network: Ma2NetworkTarget | null; state: 'sending' | 'failed' | 'running'; reason: string | null; resent: boolean; failedOn: number | null;
  /** Each send gets a new number: an answer to an earlier send of the same executor does not settle this one. */
  attempt: number };
/** One Off to send now, as the ledger hands it out. */
export type OffSend = Pick<OwedOff, 'executor' | 'action' | 'song' | 'network' | 'attempt' | 'resent'>;
/** What reading a confirmed Off back found (M8): `unknown` carries why. `read`: a read was made and failed; false when
 * nothing was read (no web remote session connected for it, or a slot it does not read), which shows nothing. */
export type LightingReadBack = { verified: 'off' } | { verified: 'running' } | { verified: 'unknown'; reason: string; read: boolean };
/** A read-back that settled an Off, as the log and the status details show it. `during`: some timecode ran then. */
export type LightingReadBackResult = { executor: string; song: LightingReleaseSong | null; during: boolean } & LightingReadBack;
/** What the status details show of the read-back (lighting-off-check DTO): the Offs read back still running, and the
 * ones read while no timecode ran that could not be confirmed. Each `unconfirmed` lasts until its executor is read
 * again, in use again or owed afresh. */
export type LightingOffCheck = { running: { executor: string; song: LightingReleaseSong | null }[];
  unconfirmed: { executor: string; song: LightingReleaseSong | null; reason: string }[] };
/** Who runs executors from its timecode: the program, or what the window runs itself (a preview, P1 following). */
export type LightingUser = 'program' | 'window';

const resendRow = 'lighting.offResend' as const;

export class LightingOffLedger {
  private readonly entries = new Map<string, OwedOff>();
  private readonly recovery = new OutputRecovery();
  private readonly users = new Map<LightingUser, ReadonlySet<string>>();
  /** Confirmed Offs whose read-back has not settled, by executor (M8). */
  private readonly confirmed = new Map<string, OwedOff>();
  private readonly unconfirmed = new Map<string, LightingOffCheck['unconfirmed'][number]>();
  private attempts = 0;

  /** `actions` are owed for `song`, sent now: each replaces what the list owed for that executor (a fresh Off, which may
   * be resent again). An executor in use (`use`) is never owed. `network`: the console they are for, when one is known. */
  owe(actions: readonly Ma2PlaybackAction[], song: LightingReleaseSong | null, cause: LightingOffCause, network: Ma2NetworkTarget | null): OffSend[] {
    return actions.flatMap(action => {
      if (action.target !== 'executor' || this.used(action.executor)) return [];
      this.recovery.forget(resendRow, action.executor); this.confirmed.delete(action.executor); this.unconfirmed.delete(action.executor);
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
    for (const executor of using) {
      this.confirmed.delete(executor); this.unconfirmed.delete(executor);
      if (this.entries.delete(executor)) this.recovery.forget(resendRow, executor);
    }
  }
  /** `user`'s timecode may run these executors as well from now on (0.5.9 S8a: the song on air got a newer version of its
   * lighting). What it ran before stays in use. An executor that already owes an Off keeps owing it and is not taken
   * into use: the Off was owed before this version, and the console may not run the new version yet. */
  widen(user: LightingUser, executors: Iterable<string>): void {
    const using = new Set(this.users.get(user) ?? []);
    for (const executor of executors) if (!this.entries.has(executor)) using.add(executor);
    this.users.set(user, using);
  }
  /** The executors `user`'s timecode runs now. */
  using(user: LightingUser): string[] { return [...this.users.get(user) ?? []]; }
  /** Some timecode runs this executor now. */
  used(executor: string): boolean { return [...this.users.values()].some(using => using.has(executor)); }

  /** The console answered this send without error: the Off leaves the list, and waits for its read-back (M8) until
   * `readBack` settles it. False when the list moved on meanwhile. */
  ack(executor: string, attempt: number): boolean {
    const entry = this.entries.get(executor);
    if (entry?.attempt !== attempt) return false;
    this.entries.delete(executor); this.recovery.forget(resendRow, executor);
    this.confirmed.set(executor, entry);
    return true;
  }

  /** This confirmed Off still waits for its read-back: no executor in use or owed afresh took its place. */
  awaitsReadBack(executor: string, attempt: number): boolean { return this.confirmed.get(executor)?.attempt === attempt; }

  /** What the read-back of this confirmed Off found (M8), once, after the last read. `running`: owed again, in yellow.
   * `off` and `unknown`: it stays done. Null when the list moved on meanwhile: the answer settles nothing. Never sends. */
  readBack(executor: string, attempt: number, found: LightingReadBack): LightingReadBackResult | null {
    const entry = this.confirmed.get(executor);
    if (entry?.attempt !== attempt) return null;
    this.confirmed.delete(executor);
    const during = [...this.users.values()].some(using => using.size > 0);
    if (found.verified === 'running') this.entries.set(executor, { ...entry, state: 'running', reason: '控台读回这个执行器还在运行' });
    // While timecode runs a read that fails says nothing (01 §4.11 M8 item 5): logged only.
    this.unconfirmed.delete(executor);
    if (found.verified === 'unknown' && found.read && !during) this.unconfirmed.set(executor, { executor, song: entry.song, reason: found.reason });
    return { executor, song: entry.song, during, ...found };
  }

  /** The status details' part of the read-back. */
  check(): LightingOffCheck {
    return { running: [...this.entries.values()].flatMap(entry => entry.state === 'running' ? [{ executor: entry.executor, song: entry.song }] : []),
      unconfirmed: [...this.unconfirmed.values()] };
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

  /** The operator pressed stop again (第 4 题): every Off not confirmed, and every one read back still running, is sent
   * once more. It does not count as an automatic resend. One still on its way is left to its answer. */
  resendOnStop(): OffSend[] {
    return [...this.entries.values()].flatMap(entry => {
      if (entry.state === 'sending') return [];
      const again: OwedOff = { ...entry, state: 'sending', attempt: ++this.attempts };
      this.entries.set(entry.executor, again);
      return [send(again)];
    });
  }

  /** Every Off not confirmed, and every one read back still running, in the order owed. */
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

/** What the quit asks about (programLightsQuitPrompt): one sentence per song that still owes an Off. One read back
 * still running was confirmed by the console and is shown in yellow only (M8): the quit does not ask about it. */
export function owedOffTexts(owed: readonly OwedOff[]): string[] {
  const bySong = new Map<string, OwedOff>();
  for (const entry of owed) if (entry.state !== 'running') bySong.set(entry.song?.itemId ?? '', bySong.get(entry.song?.itemId ?? '') ?? entry);
  return [...bySong.values()].map(entry => lightsLeftOnText(entry.song, entry.reason ?? '没有收到控台的确认'));
}

/** An Off read back still running (M8), in yellow: what happened, the fade it may still be, and what to do. */
export function lightsStillRunningText(running: LightingOffCheck['running']): string {
  const songs = [...new Set(running.map(entry => songName(entry.song)))].join('、');
  return `关灯已发出，但控台读回${songs}的执行器 ${running.map(entry => entry.executor).join('、')} 还在运行（也可能是关灯的渐变还没走完）。再按一次停止会重发。`;
}

/** The read-backs that could not confirm anything (M8): one sentence in the status details, not a warning. */
export function lightsUnconfirmedText(unconfirmed: LightingOffCheck['unconfirmed']): string {
  return `控台已收到关灯指令；执行器 ${unconfirmed.map(entry => entry.executor).join('、')} 有没有真的关掉无法确认。原因：${reasonsOf(unconfirmed)}。`;
}

/** The run log's lines for one read-back round (M8): one per song and finding. What was not read writes nothing. */
export function lightingReadBackLogs(results: readonly LightingReadBackResult[]): { level: 'info' | 'warning'; message: string; song: LightingReleaseSong | null }[] {
  const groups = new Map<string, LightingReadBackResult[]>();
  for (const result of results) {
    if (result.verified === 'unknown' && !result.read) continue;
    const key = JSON.stringify([result.song?.itemId ?? '', result.verified]);
    groups.set(key, [...groups.get(key) ?? [], result]);
  }
  return [...groups.values()].map(group => {
    const first = group[0]!, executors = group.map(result => result.executor).join('、');
    switch (first.verified) {
      case 'off': return { level: 'info' as const, message: `控台读回已关：${songName(first.song)}的执行器 ${executors}`, song: first.song };
      case 'running': return { level: 'warning' as const, message: lightsStillRunningText(group), song: first.song };
      case 'unknown': return { level: 'info' as const, message: `关灯读回无法确认：${songName(first.song)}的执行器 ${executors}。原因：${reasonsOf(group.flatMap(result => result.verified === 'unknown' ? [result] : []))}`, song: first.song };
    }
  });
}
function reasonsOf(entries: readonly { reason: string }[]): string { return [...new Set(entries.map(entry => trimReason(entry.reason)))].join('；'); }

/** The waits before each read-back (LIGHTING_OFF_READ_BACK), one per read. */
export function lightingReadBackDelays(): readonly number[] { return LIGHTING_OFF_READ_BACK.delaysMs.slice(0, LIGHTING_OFF_READ_BACK.maxReads); }

function songName(song: LightingReleaseSong | null): string { return song?.title ? `「${song.title}」` : '这首歌'; }
function trimReason(reason: string): string { return reason.replace(/[。.；;\s]+$/u, '') || '未知错误'; }
