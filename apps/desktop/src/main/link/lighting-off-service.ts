import { randomUUID } from 'node:crypto';
import { LightingOffLedger, lightingExecutors, lightingReleaseActions, lightsLeftOnAfterResendText, owedOffTexts, songChangeOffs, toUserErrorReason,
  type LightingOffOutcome, type LightingReleaseSong, type LinkDesktopApi, type LitSong, type OffSend, type OwedOff, type ProgramLightingOutput } from '@tb/core/link';
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
  now?: () => number;
};

/**
 * The one owner of the lights-off still owed in the whole application (design 01 R13, 第 4 题): the program's stops and
 * song changes (NativeProgramHost) and what the window runs itself (its previews, a stop while following P1, through
 * link:lighting-off) all go through this one ledger. The rules are LightingOffLedger's (packages/core
 * lighting-off-ledger.ts); this sends the Offs it hands out, with the stop priority of the console queue, and watches the
 * console's connection number (Ma2NetworkStatus.connection, which every new login and every disconnect changes) while an
 * Off waits, to send it once more when the console is connected again. Logging in again on its own is not this service's.
 */
export class LightingOffService implements ProgramLightingOutput {
  private readonly ledger = new LightingOffLedger();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly listeners = new Set<() => void>();
  private poll: ReturnType<typeof setInterval> | null = null;
  private reading = false;
  private readonly now: () => number;

  constructor(private readonly dependencies: Dependencies) { this.now = dependencies.now ?? Date.now; }

  /** `next` starts in place of `previous`: the executors only `previous` used go off, and those of `next` are in use. */
  change(previous: LitSong | null, next: LitSong | null): Promise<LightingOffOutcome> {
    this.ledger.use('program', lightingExecutors(next?.document ?? null));
    const offs = previous ? songChangeOffs(previous.document, next?.document ?? null) : [];
    const sends = this.ledger.owe(offs, previous?.song ?? null, 'song-change', null);
    this.changed();
    return this.deliver(sends);
  }

  /** The program stopped `song` (null: nothing was lit): its executors go off, and every Off still owed goes once more. */
  stop(song: LitSong | null, cause: 'stop' | 'close'): Promise<LightingOffOutcome> {
    this.ledger.use('program', []);
    const sends = song ? this.ledger.owe(lightingReleaseActions(song.document), song.song, cause, null) : [];
    return this.deliver([...sends, ...this.ledger.resendOnStop()]);
  }

  /** What the window runs itself (link:lighting-off). */
  async receive(value: unknown): Promise<LightingOffResult> {
    const request = lightingOffRequestSchema.parse(value);
    if (request.phase === 'start') { this.ledger.use('window', lightingExecutors(request.document)); this.changed(); return { failed: [] }; }
    this.ledger.use('window', []);
    const sends = this.ledger.owe(lightingReleaseActions(request.document), request.song, request.source === 'p1' ? 'stop' : 'preview', null);
    // Following P1, stop in the app is the operator's stop: it also sends what is still owed (00-order §8 item 4).
    return this.deliver([...sends, ...request.source === 'p1' ? this.ledger.resendOnStop() : []]);
  }

  /** Every Off not confirmed. */
  owed(): readonly OwedOff[] { return this.ledger.owed(); }
  /** An Off is on its way to the console now (ShowStateService: the stop is still being finished). */
  sending(): boolean { return this.ledger.sending(); }
  /** What the quit asks about: one sentence per song with an Off still owed. */
  quitMessages(): string[] { return owedOffTexts(this.ledger.owed()); }
  /** Every Off on its way has been answered. */
  async settled(): Promise<void> { while (this.inFlight.size) await Promise.allSettled([...this.inFlight]); }
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
    const results = await Promise.all(sends.map(async (off): Promise<LightingOffOutcome['failed'][number] | null> => {
      const target = off.network ?? (status?.settings ? targetOf(status.settings) : null);
      const refused = unreadable ?? (!connected ? (off.resent ? '没有连接控台' : '没有连接控台，连上以后会自动补发一次')
        : target && !sameTarget(target, connected) ? '现在连着的不是原来那台控台，关灯指令没有发送' : null);
      if (refused || !target) return this.fail(off, refused ?? '没有连接控台', connection, target);
      try {
        await this.dependencies.console.playMa2Cue({ network: target, action: off.action, sessionId, deadlineAt });
        this.ledger.ack(off.executor, off.attempt);
        return null;
      } catch (error) { return this.fail(off, toUserErrorReason(error), connection, target); }
    }));
    return { failed: results.flatMap(result => result ? [result] : []) };
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
    this.poll = setInterval(() => { void this.check(); }, connectionPollMs);
    this.poll.unref?.();
  }

  private async check(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
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
    } finally { this.reading = false; }
  }

  private changed(): void { for (const listener of this.listeners) listener(); }
}

function targetOf(settings: Ma2NetworkSettings): Ma2NetworkTarget {
  const { host, port, monitorPort, username } = settings;
  return { host, port, monitorPort, username };
}
function sameTarget(target: Ma2NetworkTarget, settings: Ma2NetworkSettings): boolean {
  return Object.entries(target).every(([key, value]) => Reflect.get(settings, key) === value);
}
