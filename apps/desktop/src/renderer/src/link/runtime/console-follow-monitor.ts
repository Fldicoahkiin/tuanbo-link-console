import { consoleFollowTarget, consoleFollowVerdict, consoleTriggers, nextConsoleFollow, toUserErrorMessage,
  type ConsoleFollow, type ConsoleTrigger } from '@tb/core/link';
import type { LinkProject, Ma2ExecutorObservation, Ma2ExecutorObserveRequest } from '@tb/schema';
import type { Ma2ConnectionMethod } from '../stores/ma2-mode-store';

export const CONSOLE_FOLLOW_IDLE: ConsoleFollow = { state: 'unknown', detail: '播放时核对控台在不在跟', misses: 0 };

type Dependencies = {
  project(): LinkProject | null;
  method(): Ma2ConnectionMethod;
  /** The console the network connection is logged in to; null while it is not. */
  network(): Promise<Ma2ExecutorObserveRequest['network'] | null>;
  observe(request: Ma2ExecutorObserveRequest): Promise<Ma2ExecutorObservation>;
  /** Starts the next song with a fresh read session and no remembered failure. */
  release(): Promise<void>;
  publish(follow: ConsoleFollow): void;
  log(level: 'info' | 'warning', message: string, itemId: string): void;
};

type Run = { itemId: string; sinceMs: number; triggers: readonly ConsoleTrigger[] | null; stopped: boolean; follow: ConsoleFollow; logged: ConsoleFollow['state'] | null };

/**
 * Reads back, about once a second while a song plays, the executor its timecode last triggered, and
 * says whether the console follows (root cause 6 of the 2026-10-29 review). Read only: it never sends
 * a control. Anything it cannot read makes the answer "cannot check" with the reason, and this song
 * is not read again (project rule 4: no automatic retry); the next song starts a fresh read.
 */
export class ConsoleFollowMonitor {
  private run: Run | null = null;
  private busy = false;
  /** What is shown is a passing condition (no network, no timecode), not the run's own answer. */
  private passing = false;
  constructor(private readonly dependencies: Dependencies) {}

  /** A song started, or playback jumped: only the triggers the console passes from here count. */
  start(itemId: string, positionMs: number): void {
    const fresh = this.run?.itemId !== itemId;
    this.run = { itemId, sinceMs: positionMs, triggers: null, stopped: false, follow: { state: 'checking', detail: '还没到这次播放的第一个灯光点', misses: 0 }, logged: fresh ? null : this.run?.logged ?? null };
    if (fresh) void this.dependencies.release().catch((error: unknown) => this.stop(this.run, `关闭上一首的读取失败：${toUserErrorMessage(error)}`));
    this.dependencies.publish(this.run.follow);
  }

  /** Playback stopped or paused. */
  idle(): void { this.run = null; this.passing = false; this.dependencies.publish(CONSOLE_FOLLOW_IDLE); }

  /** `sending`: the song's timecode is going out now. */
  async tick(positionMs: number, sending: boolean): Promise<void> {
    const run = this.run;
    if (!run || run.stopped || this.busy) return;
    const method = this.dependencies.method();
    if (method !== 'network') return this.pass(method === 'midi' ? '只接了 MIDI 线，联动台读不到控台；控台在不在跑灯请看控台' : '用本机 onPC 时不核对');
    if (!sending) return this.pass('时间码没有发出，控台不会跟着跑');
    const project = this.dependencies.project();
    if (!project) return;
    if (!run.triggers) {
      const found = consoleTriggers(project, run.itemId);
      if ('reason' in found) return this.stop(run, found.reason);
      run.triggers = found.triggers;
    }
    if (this.passing) { this.passing = false; this.dependencies.publish(run.follow); }
    const target = consoleFollowTarget(run.triggers, positionMs, run.sinceMs);
    if (target.kind === 'unknown') return this.stop(run, target.reason);
    if (target.kind === 'wait') { if (run.follow.state === 'checking') this.show(run, { ...run.follow, detail: target.reason }); return; }
    this.busy = true;
    try {
      const network = await this.dependencies.network();
      if (this.run !== run) return;
      if (!network) return this.pass('控台网络没连上，读不到控台');
      const observed = await this.dependencies.observe({ network, page: target.page, slot: target.slot });
      if (this.run !== run) return;
      if (observed.kind === 'unavailable') return this.stop(run, observed.reason);
      const verdict = consoleFollowVerdict(target.trigger, observed.kind === 'empty' ? null : observed);
      this.show(run, nextConsoleFollow(run.follow, verdict));
    } catch (error) {
      if (this.run === run) this.stop(run, `读不到控台执行器状态：${toUserErrorMessage(error)}。这首歌不再核对`);
    } finally { this.busy = false; }
  }

  private pass(detail: string): void { this.passing = true; this.dependencies.publish({ state: 'unknown', detail, misses: 0 }); }
  private stop(run: Run | null, reason: string): void {
    if (!run || this.run !== run) return;
    run.stopped = true;
    this.show(run, { state: 'unknown', detail: reason, misses: 0 });
  }
  private show(run: Run, follow: ConsoleFollow): void {
    run.follow = follow; this.passing = false;
    this.dependencies.publish(follow);
    // A change between following and not is logged once per change, so the site log shows when the console stopped following.
    if ((follow.state === 'following' || follow.state === 'not-following') && run.logged !== follow.state) {
      if (follow.state === 'not-following' || run.logged === 'not-following') this.dependencies.log(follow.state === 'following' ? 'info' : 'warning', follow.state === 'following' ? `控台又跟上了：${follow.detail}` : `控台没在跟：${follow.detail}`, run.itemId);
      run.logged = follow.state;
    }
  }
}
