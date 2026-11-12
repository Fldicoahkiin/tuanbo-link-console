import { randomUUID } from 'node:crypto';
import { LightingOffLedger, lightingExecutors, litChangeOffs, litExecutors, litReleaseActions, lightingReadBackDelays, lightingReleaseActions, lightsLeftOnAfterResendText, lightsLeftOnText, owedOffTexts, toUserErrorReason,
  type LightingOffCheck, type LightingOffOutcome, type LightingReadBack, type LightingReadBackResult, type LightingReleaseSong, type LinkDesktopApi, type LitSong, type OffSend, type OwedOff,
  type ProgramLightingOutput } from '@tb/core/link';
import { lightingOffRequestSchema, type LightingOffResult, type Ma2NetworkSettings, type Ma2NetworkStatus, type Ma2NetworkTarget } from '@tb/schema';

/** As long as an Off may wait: a sync job already on the wire finishes first. */
const releaseDeadlineMs = 7000;
/** How often the console's connection number is read while an Off waits for it. */
const connectionPollMs = 1000;

type Dependencies = {
  /** The console as the program reaches it (program-license.ts): an Off is never refused for license, and each one sent is
   * logged there («MA2 关灯指令已发送», with how long it waited for the console line). */
  console: Pick<LinkDesktopApi, 'getMa2NetworkStatus' | 'playMa2Cue'>;
  /** The console connected again and owed Offs are sent once more: logged as a warning. */
  resending(count: number): void;
  /** A resend after the console connected did not go out either: no one waits for its answer, so it is logged as an
   * error and shown in red here. It stays owed. */
  failed(message: string, song: LightingReleaseSong | null): void;
  /** Reads executors back on web remote sessions that are connected already (Ma2LiveService.readBack, M8): it never
   * logs in and never sends a control. Without it nothing is read back. */
  readBack?: (network: Ma2NetworkTarget, executors: readonly string[]) => Promise<ReadonlyMap<string, LightingReadBack>>;
  /** One read-back round settled these Offs, each read (one not read is left out): logged by song (lightingReadBackLogs). */
  verified?: (results: readonly LightingReadBackResult[]) => void;
  now?: () => number;
};

/**
 * The one owner of the lights-off still owed in the whole application (design 01 R13, 第 4 题): the program's stops and
 * song changes (NativeProgramHost) and what the window runs itself (its previews, a stop while following P1, through
 * link:lighting-off) all go through this one ledger. The rules are LightingOffLedger's (packages/core
 * lighting-off-ledger.ts); this sends the Offs it hands out, with the stop priority of the console queue, and watches the
 * console's connection number (Ma2NetworkStatus.connection, which every new login and every disconnect changes) while an
 * Off waits, to send it once more when the console is connected again. Logging in again on its own is not this service's.
 * The one place that reads a confirmed Off back (M8): after the console's answer, never before it, so a read-back never
 * slows an Off or changes its result; it never sends an Off and never counts as a resend.
 */
export class LightingOffService implements ProgramLightingOutput {
  private readonly ledger = new LightingOffLedger();
  private readonly inFlight = new Set<Promise<unknown>>();
  /** Read-backs still waiting or reading: not part of `settled`, so the quit never waits for them. */
  private readonly reading = new Set<Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private poll: ReturnType<typeof setInterval> | null = null;
  private checking = false;
  private readonly now: () => number;

  constructor(private readonly dependencies: Dependencies) { this.now = dependencies.now ?? Date.now; }

  /** `next` starts in place of `previous`: the executors only `previous` used go off, and those of `next` are in use. */
  change(previous: LitSong | null, next: LitSong | null): Promise<LightingOffOutcome> {
    this.ledger.use('program', litExecutors(next));
    const offs = previous ? litChangeOffs(previous, next) : [];
    const sends = this.ledger.owe(offs, previous?.song ?? null, 'song-change', null);
    this.changed();
    return this.deliver(sends);
  }

  /** The program stopped `song` (null: nothing was lit): its executors go off, and every Off still owed goes once more. */
  stop(song: LitSong | null, cause: 'stop' | 'close'): Promise<LightingOffOutcome> {
    this.ledger.use('program', []);
    const sends = song ? this.ledger.owe(litReleaseActions(song), song.song, cause, null) : [];
    return this.deliver([...sends, ...this.ledger.resendOnStop()]);
  }

  /** The song on air got a newer version of its lighting (0.5.9 S8a): its executors in use only grow; nothing is sent. */
  widen(song: LitSong): void {
    this.ledger.widen('program', litExecutors(song));
    this.changed();
  }

  /** P1 followed in the main process (0.5.9 P3f): `next` is the song whose timecode P1 sends now, in place of `previous`.
   * As a song change of the program: the executors only `previous` used go off, those of `next` are in use. */
  followChange(previous: LitSong | null, next: LitSong | null): Promise<LightingOffOutcome> {
    this.ledger.use('p1', litExecutors(next));
    const sends = previous ? this.ledger.owe(litChangeOffs(previous, next), previous.song, 'song-change', null) : [];
    this.changed();
    return this.deliver(sends);
  }

  /** The operator stopped following P1 (or the follow closed): `song`'s executors go off, and every Off still owed goes
   * once more (00-order §8 item 4). P1 itself plays on. */
  followStop(song: LitSong | null, cause: 'stop' | 'close'): Promise<LightingOffOutcome> {
    this.ledger.use('p1', []);
    const sends = song ? this.ledger.owe(litReleaseActions(song), song.song, cause, null) : [];
    return this.deliver([...sends, ...this.ledger.resendOnStop()]);
  }

  /** What the window runs itself (link:lighting-off). */
  async receive(value: unknown): Promise<LightingOffResult> {
    const request = lightingOffRequestSchema.parse(value);
    if (request.phase === 'start') { this.ledger.use('window', lightingExecutors(request.document)); this.changed(); return { failed: [] }; }
    // The window's claim lasts only while its timecode runs: a paused preview must not hold back the Off of a program
    // that stops a song on the same executors.
    this.ledger.use('window', []);
    if (request.phase === 'pause') { this.changed(); return { failed: [] }; }
    return this.deliver(this.ledger.owe(lightingReleaseActions(request.document), request.song, 'preview', null));
  }

  /** The window's page is gone (its renderer exited, or it reloaded) and what it ran died with it: nothing there will
   * say stop any more, so the executors its timecode was running are owed their Off here. One that does not go out is
   * shown in red in the next window and stays owed. */
  pageGone(): void {
    const running = this.ledger.using('window');
    this.ledger.use('window', []);
    const sends = this.ledger.owe(running.map(executor => ({ target: 'executor', executor, action: 'off' })), null, 'preview', null);
    if (!sends.length) { this.changed(); return; }
    void this.deliver(sends).then(outcome => {
      const reasons = [...new Set(outcome.failed.map(failure => failure.reason))];
      if (reasons.length) this.dependencies.failed(lightsLeftOnText(null, reasons.join('；')), null);
    });
  }

  /** Every Off not confirmed. */
  owed(): readonly OwedOff[] { return this.ledger.owed(); }
  /** An Off is on its way to the console now (ShowStateService: the stop is still being finished). */
  sending(): boolean { return this.ledger.sending(); }
  /** What the quit asks about: one sentence per song with an Off still owed. */
  quitMessages(): string[] { return owedOffTexts(this.ledger.owed()); }
  /** Every Off on its way has been answered. */
  async settled(): Promise<void> { while (this.inFlight.size) await Promise.allSettled([...this.inFlight]); }
  /** Every read-back has settled (diagnostics and tests). */
  async readBacksSettled(): Promise<void> { while (this.reading.size) await Promise.allSettled([...this.reading]); }
  /** What the status details show of the read-back (link:lighting-off-check). */
  check(): LightingOffCheck { return this.ledger.check(); }
  onChanged(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  /** Stops watching the console. */
  close(): void { if (this.poll) clearInterval(this.poll); this.poll = null; }

  private deliver(sends: readonly OffSend[]): Promise<LightingOffOutcome> {
    if (!sends.length) return Promise.resolve({ failed: [] });
    this.changed();
    const job = this.send(sends).finally(() => { this.inFlight.delete(job); this.changed(); this.watch(); });
    this.inFlight.add(job);
    return job;
  }

  /** All Offs reach the console back to back, ahead of queued sync jobs, with one deadline; one failure never holds back
   * the rest. Each that did not go out stays owed. */
  private async send(sends: readonly OffSend[]): Promise<LightingOffOutcome> {
    let status: Ma2NetworkStatus | null = null, unreadable: string | null = null;
    try { status = await this.dependencies.console.getMa2NetworkStatus(); } catch (error) { unreadable = toUserErrorReason(error); }
    const connected = status?.state === 'connected' && status.settings ? status.settings : null;
    const connection = connected ? status?.connection ?? null : null;
    const sessionId = randomUUID(), deadlineAt = this.now() + releaseDeadlineMs;
    const confirmed: { off: OffSend; network: Ma2NetworkTarget }[] = [];
    const results = await Promise.all(sends.map(async (off): Promise<LightingOffOutcome['failed'][number] | null> => {
      const target = off.network ?? (status?.settings ? targetOf(status.settings) : null);
      const refused = unreadable ?? (!connected ? (off.resent ? '没有连接控台' : '没有连接控台，连上以后会自动补发一次')
        : target && !sameTarget(target, connected) ? '现在连着的不是原来那台控台，关灯指令没有发送' : null);
      if (refused || !target) return this.fail(off, refused ?? '没有连接控台', connection, target);
      try {
        await this.dependencies.console.playMa2Cue({ network: target, action: off.action, sessionId, deadlineAt });
        if (this.ledger.ack(off.executor, off.attempt)) confirmed.push({ off, network: target });
        return null;
      } catch (error) { return this.fail(off, toUserErrorReason(error), connection, target); }
    }));
    if (confirmed.length) this.readBack(confirmed);
    return { failed: results.flatMap(result => result ? [result] : []) };
  }

  /** Reads the Offs one send confirmed back, as one round (LIGHTING_OFF_READ_BACK): after each wait, all that still wait
   * are read together, one request per session, page and range; the second read only for those the first found running,
   * and the last read stands. A stop, a song change or a start of the same executor meanwhile takes that one out. */
  private readBack(round: readonly { off: OffSend; network: Ma2NetworkTarget }[]): void {
    const read = this.dependencies.readBack;
    // Not read: settled as before M8, with nothing logged or shown.
    const quiet: LightingReadBack = { verified: 'unknown', reason: '没有读回', read: false };
    if (!read) { for (const { off } of round) this.ledger.readBack(off.executor, off.attempt, quiet); return; }
    const job = (async (): Promise<void> => {
      const settled: LightingReadBackResult[] = [];
      let pending = round;
      for (const [index, delay] of lightingReadBackDelays().entries()) {
        await new Promise<void>(resolve => { setTimeout(resolve, delay).unref?.(); });
        pending = pending.filter(({ off }) => this.ledger.awaitsReadBack(off.executor, off.attempt));
        if (!pending.length) break;
        const found = new Map<OffSend, LightingReadBack>();
        for (const group of byNetwork(pending)) {
          const executors = group.map(({ off }) => off.executor);
          const answers = await read(group[0]!.network, executors).catch((error: unknown) =>
            new Map(executors.map((executor): [string, LightingReadBack] => [executor, { verified: 'unknown', reason: toUserErrorReason(error), read: true }])));
          for (const { off } of group) found.set(off, answers.get(off.executor) ?? quiet);
        }
        const last = index === lightingReadBackDelays().length - 1;
        // Running is read once more; everything else, and running at the last read, stands now.
        const next: { off: OffSend; network: Ma2NetworkTarget }[] = [];
        for (const entry of pending) {
          const answer = found.get(entry.off) ?? quiet;
          if (answer.verified === 'running' && !last) { next.push(entry); continue; }
          const result = this.ledger.readBack(entry.off.executor, entry.off.attempt, answer);
          if (result) settled.push(result);
        }
        pending = next;
        this.changed();
        if (!pending.length) break;
      }
      const logged = settled.filter(result => result.verified !== 'unknown' || result.read);
      if (logged.length) this.dependencies.verified?.(logged);
    })().finally(() => { this.reading.delete(job); });
    this.reading.add(job);
  }

  private fail(off: OffSend, reason: string, connection: number | null, network: Ma2NetworkTarget | null): LightingOffOutcome['failed'][number] | null {
    // Struck meanwhile (the executor is in use again) or owed afresh: this answer settles nothing.
    return this.ledger.fail(off.executor, off.attempt, reason, connection, network) ? { song: off.song, reason } : null;
  }

  /** While an Off waits, the console's connection number is read: connected under a new number, each is sent once more. */
  private watch(): void {
    const waiting = this.ledger.owed().some(entry => entry.state === 'failed');
    if (!waiting) { this.close(); return; }
    if (this.poll) return;
    this.poll = setInterval(() => { void this.checkConnection(); }, connectionPollMs);
    this.poll.unref?.();
  }

  private async checkConnection(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const status = await this.dependencies.console.getMa2NetworkStatus().catch(() => null);
      if (status?.state !== 'connected' || !status.settings || status.connection === undefined) return;
      const sends = this.ledger.onConnected(status.connection, this.now());
      if (!sends.length) { this.watch(); return; }
      this.dependencies.resending(sends.length);
      const outcome = await this.deliver(sends);
      const shown = new Set<string>();
      for (const { song, reason } of outcome.failed) {
        const message = lightsLeftOnAfterResendText(song, reason);
        if (!shown.has(message)) { shown.add(message); this.dependencies.failed(message, song); }
      }
    } finally { this.checking = false; }
  }

  private changed(): void { for (const listener of this.listeners) listener(); }
}

/** The confirmed Offs of a round, by the console they went to. */
function byNetwork<T extends { network: Ma2NetworkTarget }>(entries: readonly T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const entry of entries) { const key = JSON.stringify(entry.network); groups.set(key, [...groups.get(key) ?? [], entry]); }
  return [...groups.values()];
}
function targetOf(settings: Ma2NetworkSettings): Ma2NetworkTarget {
  const { host, port, monitorPort, username } = settings;
  return { host, port, monitorPort, username };
}
function sameTarget(target: Ma2NetworkTarget, settings: Ma2NetworkSettings): boolean {
  return Object.entries(target).every(([key, value]) => Reflect.get(settings, key) === value);
}
