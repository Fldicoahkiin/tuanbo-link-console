import { consoleFollowTarget, consoleFollowVerdict, consoleTriggers, nextConsoleFollow, toUserErrorMessage,
  type ConsoleFollow, type ConsoleTrigger } from '@tb/core/link';
import type { LinkProject, Ma2ExecutorObservation, Ma2ExecutorObserveRequest } from '@tb/schema';
import type { Ma2ConnectionMethod } from '../stores/ma2-mode-store';

export const CONSOLE_FOLLOW_IDLE: ConsoleFollow = { state: 'unknown', detail: '播放时核对控台在不在跟', misses: 0 };

type FollowClock = { positionMs: number; mtcSentPositionMs: number | null };

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

type Run = { itemId: string; sinceMs: number; triggers: readonly ConsoleTrigger[] | null; endMs: number | null; stopped: boolean; follow: ConsoleFollow; logged: ConsoleFollow | null };

/**
 * Reads back, about once a second while a song plays, the executor its timecode last triggered, and
 * says whether the console follows (root cause 6 of the 2026-10-29 review). Read only: it never sends
 * a control. Anything it cannot read makes the answer "cannot check" with the reason, and this song
 * is not read again (project rule 4: no automatic retry); the next song starts a fresh read.
 */
export class ConsoleFollowMonitor {
  private run: Run | null = null;
  private busy = false;
  constructor(private readonly dependencies: Dependencies) {}

  /** A song started, or playback jumped: only the triggers the console passes from here count. */
  start(itemId: string, positionMs: number): void {
    const fresh = this.run?.itemId !== itemId;
    const run: Run = { itemId, sinceMs: positionMs, triggers: null, endMs: null, stopped: false, follow: { state: 'checking', detail: '正在核对本次播放的灯光点', misses: 0 }, logged: fresh ? null : this.run?.logged ?? null };
    this.run = run;
    if (fresh) void this.dependencies.release().catch((error: unknown) => this.stop(run, `关闭上一首的读取失败：${toUserErrorMessage(error)}`));
    this.dependencies.publish(run.follow);
  }

  /** Playback stopped or paused. */
  idle(): void { this.run = null; this.dependencies.publish(CONSOLE_FOLLOW_IDLE); }

  async tick(readClock: () => FollowClock): Promise<void> {
    const run = this.run;
    if (!run || run.stopped || this.busy) return;
    const method = this.dependencies.method();
    const target = this.target(run, readClock(), method);
    if (!target) return;
    this.busy = true;
    try {
      const network = await this.dependencies.network();
      if (this.run !== run) return;
      if (!network) return this.unconfirmed(run, '控台网络没连上，读不到控台');
      if (method === 'local' && network.host !== '127.0.0.1') return this.unconfirmed(run, '尚未连接本机 onPC，无法核对灯光');
      const observed = await this.dependencies.observe({ network, page: target.page, slot: target.slot });
      if (this.run !== run) return;
      if (observed.kind === 'unavailable') return this.stop(run, observed.reason);
      // The web remote supplies no playback timestamp. Discard a reply that crosses
      // into another trigger, even if the old Cue number matches.
      const currentMethod = this.dependencies.method();
      const current = this.target(run, readClock(), currentMethod);
      if (!current) return;
      if (current.trigger !== target.trigger || currentMethod !== method) {
        return this.show(run, { state: 'checking', detail: '正在核对当前灯光点', misses: 0 });
      }
      const verdict = consoleFollowVerdict(target.trigger, observed.kind === 'empty' ? null : observed);
      this.show(run, nextConsoleFollow(run.follow, verdict));
    } catch (error) {
      if (this.run === run) this.stop(run, `读不到控台执行器状态：${toUserErrorMessage(error)}。这首歌不再核对`);
    } finally { this.busy = false; }
  }

  private target(run: Run, clock: FollowClock, method: Ma2ConnectionMethod) {
    if (method === 'midi') return this.unconfirmed(run, '只接了 MIDI 线，联动台读不到控台；控台在不在跑灯请看控台');
    if (clock.mtcSentPositionMs === null) return this.unconfirmed(run, '时间码没有发出，控台不会跟着跑');
    const project = this.dependencies.project();
    if (!project) return;
    if (!run.triggers) {
      const found = consoleTriggers(project, run.itemId);
      if ('reason' in found) return this.stop(run, found.reason);
      run.triggers = found.triggers;
      run.endMs = found.endMs ?? null;
    }
    if (run.endMs !== null && clock.positionMs >= run.endMs) {
      run.stopped = true;
      return this.show(run, { state: 'past-end', detail: '音乐已播过控台时间线的结尾', misses: 0 });
    }
    const target = consoleFollowTarget(run.triggers, clock.positionMs, run.sinceMs);
    if (target.kind === 'unknown') return this.stop(run, target.reason);
    if (target.kind === 'unobservable') return this.unconfirmed(run, target.reason);
    if (target.kind === 'wait') return this.show(run, { state: 'checking', detail: target.reason, misses: run.follow.misses });
    return target;
  }

  private unconfirmed(run: Run, detail: string): void { this.show(run, { state: 'unknown', detail, misses: 0 }); }
  private stop(run: Run | null, reason: string): void {
    if (!run || this.run !== run) return;
    run.stopped = true;
    this.unconfirmed(run, reason);
  }
  private show(run: Run, follow: ConsoleFollow): void {
    run.follow = follow;
    this.dependencies.publish(follow);
    if (follow.state === 'checking') return;
    const previous = run.logged;
    if (previous?.state === follow.state && (follow.state !== 'unknown' || previous.detail === follow.detail)) return;
    run.logged = follow;
    switch (follow.state) {
      case 'past-end': this.dependencies.log('info', follow.detail, run.itemId); break;
      case 'unknown': this.dependencies.log('info', `无法确认控台执行器：${follow.detail}`, run.itemId); break;
      case 'not-following': this.dependencies.log('warning', `控台没在跟：${follow.detail}`, run.itemId); break;
      case 'following': {
        const label = previous?.state === 'not-following' ? '控台又跟上了' : '控台执行器读回';
        this.dependencies.log('info', `${label}：${follow.detail}`, run.itemId);
        break;
      }
    }
  }
}
