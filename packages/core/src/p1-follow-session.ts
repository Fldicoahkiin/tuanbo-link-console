import type { LinkProject } from '@tb/schema';
import { isMtcSampleContinuous } from './cue-runtime';
import type { MtcSample } from './mtc-timecode';
import { P1Clock, type P1ClockEvent, type P1ClockObservation, type P1FollowMode, type P1FreezeCause } from './p1-clock';
import type { ProgramClock } from './program-clock';

/*
 * One follow of P1 (0.5.9 P3, design 03 §4.1.4): what P1's timecode means for the outputs, decided in one place for the
 * main-process host (apps/desktop/src/main/link/p1-follow-host.ts). `P1Clock` says whether the timecode runs, froze or
 * started another song; this says what the outputs are told and what the operator may do now. Pure and synchronous:
 * the host owns the input, the async song preparation and the state it shows the window.
 *
 * The move adds no behaviour: every rule below is the page's P1 path as of b0461fe2, named where it comes from:
 * `link-runtime-coordinator.ts` (the coordinator), `p1-auto-follow-controller.ts` (the controller), `cue-runtime.ts`
 * (CueRuntime) and `mtc-stability-tracker.ts`. Where the outputs are told something, the shared outputs decide what it
 * does to the picture and the action MIDI (P3d and the picture part); nothing here sends a light Off, as the page's P1
 * path sends none.
 */

/** The outputs of a P1 follow, the same ones the internal player drives (design 03 §4.1.4): they only ever see a
 * `ProgramClock` from P1.
 * - `observe`: where the song is. A new session starts with `ready` at the song's head, then `running` positions; `stopped`
 *   lets the song go.
 * - `hold`: the timecode froze (lost, jumped): automatic Cues stop where they are; nothing between is sent later.
 * - `reconcileAt`: the follow goes on at this position after a freeze (manual resync, or P1 going on from where it
 *   stopped): from here on, nothing passed is sent later. */
export type P1FollowOutputs = {
  observe(clock: ProgramClock): void;
  hold(): void;
  reconcileAt(clock: ProgramClock): void;
};

export type P1FollowDependencies = {
  outputs: P1FollowOutputs;
  /** Auto-follow: P1 started this song; get its outputs ready. The host answers with `prepared` or `preparationFailed`
   * for this `sessionId` (the controller's `prepare`). */
  prepare(itemId: string, sessionId: string): void;
};

export type P1FollowSessionPhase = 'standby' | 'waiting' | 'preparing' | 'running' | 'frozen' | 'takeover' | 'failed';

export type P1FollowView = {
  phase: P1FollowSessionPhase;
  mode: P1FollowMode;
  itemId: string | null;
  sessionId: string | null;
  generation: number;
  positionMs: number | null;
  cause: P1FreezeCause | null;
  reason: string | null;
  /** The latest whole timecode as P1 sent it; `receiving` within MTC_SIGNAL_MS of the interface's now, `stable` after
   * MTC_STABLE_MS without a gap, jump or frame rate change. */
  mtc: { sample: MtcSample; receiving: boolean; stable: boolean } | null;
};

/** The coordinator's and the preflight's "MTC is coming in" (`<= 500` ms, link-preflight-view-model.ts L88). */
const MTC_SIGNAL_MS = 500;
/** `mtc-stability-tracker.ts` STABILITY_WINDOW_MS. */
const MTC_STABLE_MS = 500;
/** CueRuntime.stop's reason when the operator stops. */
const OPERATOR_STOP = '操作员请求停止';
/** The coordinator's reason for stopping the previous song when P1 starts another (prepare, L61). */
const SONG_CHANGE_STOP = 'P1 切歌，停止上一首';

export class P1FollowSession {
  private readonly clock: P1Clock;
  private phase: P1FollowSessionPhase = 'standby';
  private cause: P1FreezeCause | null = null;
  private reason: string | null = null;
  /** The song the outputs have, as last told; null when they have none of this follow. */
  private held: ProgramClock | null = null;
  /** Auto-follow: the song being prepared. */
  private pending: { itemId: string; sessionId: string } | null = null;
  /** Auto-follow: the song that could not start, while failed. */
  private failedItemId: string | null = null;
  private stableSince: number | null = null;

  constructor(project: LinkProject, readonly mode: P1FollowMode, private readonly dependencies: P1FollowDependencies) {
    this.clock = new P1Clock(project, mode);
  }

  /** One MIDI message of the P1 input with the interface's timestamp. */
  message(bytes: readonly number[], at100ns: bigint): void {
    const before = this.clock.timecode;
    const events = this.clock.message(bytes, at100ns);
    const after = this.clock.timecode;
    if (after && after !== before) this.track(before, after);
    this.apply(events);
  }

  /** The native input's heartbeat. */
  idle(at100ns: bigint): void { this.apply(this.clock.idle(at100ns)); }

  /** The input is gone; what runs is lost (the page saw the silence of an unplugged port as a loss after 500 ms). */
  inputGone(): void { this.apply(this.clock.inputGone()); }

  /** Manual: wait for this song from its head; auto: `null`, listen for P1's song (coordinator `armFromStart` and
   * `enableP1AutoFollow`; the window checks before that, as `launchSequence` runs the preflight first). */
  arm(itemId: string | null): void {
    if (this.phase !== 'standby') throw new Error('正在跟随 P1，先停止再重新待命');
    this.clock.arm(itemId);
    this.phase = 'waiting'; this.cause = null;
    this.reason = this.clock.state.phase === 'waiting' ? this.clock.state.reason : null;
  }

  /** Manual: go on from where P1 is now, after a freeze (coordinator `resyncCurrentTime`, CueRuntime `resync`): only
   * when frozen, never in a takeover; past Cues are not sent later. */
  resync(): void {
    if (this.phase !== 'frozen') throw new Error('只有时间码中断后才能重新同步');
    this.apply(this.clock.resync());
  }

  /** After a freeze: wait for the song's head again (coordinator `rearmFromStart`, CueRuntime `rearmFromStart`: only
   * from a lost timecode). The outputs are not cleared: the page only forgot what it had executed. */
  rearm(): void {
    if (this.phase !== 'frozen') throw new Error('只有时间码中断后才能从头重新待命');
    this.clock.rearmFromStart();
    this.phase = 'waiting'; this.cause = null;
    this.reason = this.clock.state.phase === 'waiting' ? this.clock.state.reason : null;
  }

  /** After a freeze the operator takes over by hand (CueRuntime `enableManualTakeover`: only from a lost timecode;
   * afterwards the timecode is not followed, only a stop ends it). The outputs stay held. */
  takeover(): void {
    if (this.phase !== 'frozen') throw new Error('只有时间码中断后才能手动接管');
    this.phase = 'takeover'; this.cause = null; this.reason = null;
  }

  /** Stop following; P1 is not stopped. The outputs let the song go (coordinator `stop`: the page's outputs were
   * cleaned up). Auto-follow listens again only after `arm` (the controller's `suspend`). */
  stop(): void {
    if (this.phase === 'standby') return;
    this.clock.stop();
    this.pending = null;
    this.release(OPERATOR_STOP);
    this.phase = 'standby'; this.cause = null; this.reason = null;
  }

  /** Auto-follow: the song P1 started is ready. Its outputs start from its head at the latest position, if P1 is still
   * on it; otherwise this song waits for P1 to play a song from its head (the controller's `awaitingRestart`). The
   * controller delivered only a sample at most 500 ms old (`p1-auto-follow-controller.ts` L73); on the interface's
   * clock that is what `running` means here, as `P1Clock` freezes after MTC_LOSS_MS without a quarter frame. */
  prepared(sessionId: string): void {
    if (this.pending?.sessionId !== sessionId) return;
    const pending = this.pending; this.pending = null;
    this.failedItemId = pending.itemId;
    const state = this.clock.state;
    if (state.phase === 'running' && state.clock.sessionId === pending.sessionId) {
      this.start(state.clock);
      return;
    }
    this.phase = 'failed'; this.cause = null;
    this.reason = state.phase === 'frozen' && state.cause !== 'lost' ? state.reason : '准备过程中 P1 停止了，请恢复监听后重新点歌';
  }

  /** Auto-follow: the song P1 started could not be prepared. Only P1 playing a song from its head tries again (the
   * controller's `freeze`: a failed preparation is not retried for the same play). */
  preparationFailed(sessionId: string, reason: string): void {
    if (this.pending?.sessionId !== sessionId) return;
    this.failedItemId = this.pending.itemId; this.pending = null;
    this.phase = 'failed'; this.cause = null; this.reason = reason;
  }

  get view(): P1FollowView {
    const state = this.clock.state, sample = this.clock.timecode, now = this.clock.now;
    const position = state.phase === 'running' ? state.clock : null;
    return {
      phase: this.phase, mode: this.mode,
      itemId: this.phase === 'failed' ? this.failedItemId
        : this.pending?.itemId ?? this.held?.itemId ?? (state.phase === 'waiting' || state.phase === 'frozen' ? state.itemId : null),
      sessionId: this.pending?.sessionId ?? this.held?.sessionId ?? null,
      generation: this.held?.generation ?? 0,
      positionMs: this.phase === 'running' && position ? position.positionMs : this.phase === 'frozen' && state.phase === 'frozen' ? state.positionMs : this.held?.positionMs ?? null,
      cause: this.cause, reason: this.reason,
      mtc: sample && now !== null ? { sample, receiving: now - sample.receivedAtMs <= MTC_SIGNAL_MS,
        stable: this.stableSince !== null && sample.receivedAtMs - this.stableSince >= MTC_STABLE_MS } : null
    };
  }

  /** `MtcStabilityTracker.update`: continuous since the first of an unbroken run. */
  private track(previous: MtcSample | null, current: MtcSample): void {
    if (!previous || !isMtcSampleContinuous(previous, current)) { this.stableSince = null; return; }
    this.stableSince ??= previous.receivedAtMs;
  }

  private apply(events: readonly P1ClockEvent[]): void {
    for (const event of events) {
      switch (event.kind) {
        case 'song': this.song(event.itemId, event.sessionId); break;
        case 'clock': this.running(event.clock); break;
        case 'frozen': this.frozen(event.cause, event.reason); break;
        case 'resumed': if (this.phase === 'frozen' && this.held?.sessionId === event.clock.sessionId) this.goOn(event.clock); break;
        case 'resynced': if (this.phase === 'frozen') this.goOn(event.clock); break;
      }
    }
  }

  /** Auto-follow: P1 played a song from its head. The previous song stops first (coordinator `prepare` L61), then this
   * one is prepared; in a takeover or after a failed song too (the controller listens on through both). */
  private song(itemId: string, sessionId: string): void {
    this.release(SONG_CHANGE_STOP);
    this.pending = { itemId, sessionId };
    this.phase = 'preparing'; this.cause = null; this.reason = null;
    this.dependencies.prepare(itemId, sessionId);
  }

  private running(clock: P1ClockObservation): void {
    // Manual: the first position after arming. Auto keeps the latest while preparing; `prepared` takes it.
    if (this.phase === 'waiting' && this.mode === 'manual') { this.start(clock); return; }
    if (this.phase !== 'running' || this.held?.sessionId !== clock.sessionId) return;
    this.held = clock;
    this.dependencies.outputs.observe(clock);
  }

  /** From the song's head: CueRuntime armed `awaiting-external-start` executes everything from the head up to the
   * first position (`collectDueCues(-1, frame)`), so the outputs start at the head, as for the internal player's
   * `ready`, and catch up with the first position. */
  private start(clock: P1ClockObservation): void {
    this.dependencies.outputs.observe({ ...clock, state: 'ready', positionMs: 0, observedAtMs: null });
    this.held = clock;
    this.dependencies.outputs.observe(clock);
    this.phase = 'running'; this.cause = null; this.reason = null;
  }

  private frozen(cause: P1FreezeCause, reason: string): void {
    // While preparing, the outcome waits for `prepared`; in a takeover or after a failed song the timecode is not
    // followed (CueRuntime ignores samples in a takeover; the controller ignores them while awaiting a restart).
    if (this.phase === 'preparing' || this.phase === 'takeover' || this.phase === 'failed' || this.phase === 'standby') return;
    // A freeze stops what was queued (coordinator `applyUpdate`: a new execution generation on `timecodeLost`).
    if (this.phase === 'running' && this.held) this.dependencies.outputs.hold();
    this.phase = 'frozen'; this.cause = cause; this.reason = reason;
  }

  /** Resynced (manual) or resumed (auto): the follow goes on here, past Cues are not sent later (CueRuntime `resync`
   * marks them missed; `resumeP1` takes only fps/4 frames). */
  private goOn(clock: P1ClockObservation): void {
    this.held = clock;
    this.dependencies.outputs.reconcileAt(clock);
    this.phase = 'running'; this.cause = null; this.reason = null;
  }

  private release(reason: string): void {
    const held = this.held;
    this.held = null;
    if (held) this.dependencies.outputs.observe({ ...held, state: 'stopped', observedAtMs: null, reason });
  }
}
