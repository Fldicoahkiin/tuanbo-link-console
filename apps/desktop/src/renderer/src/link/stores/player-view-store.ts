import { emptyInternalPlayerState, type InternalPlayerState } from '@tb/core/link';

export type PlayerClockState = { positionMs: number; mtcPositionMs: number | null; mtcSentPositionMs: number | null };
export type PlayerControlState = Omit<InternalPlayerState, keyof PlayerClockState> & { mtcSending: boolean };

function equal<T extends object>(left: T, right: T): boolean {
  const keys = Object.keys(left) as (keyof T)[];
  return keys.length === Object.keys(right).length && keys.every(key => Object.is(left[key], right[key]));
}

function projectState(state: InternalPlayerState): { clock: PlayerClockState; control: PlayerControlState } {
  const { positionMs, mtcPositionMs, mtcSentPositionMs, ...rest } = state;
  return { clock: { positionMs, mtcPositionMs, mtcSentPositionMs: mtcSentPositionMs ?? null },
    control: { ...rest, mtcSending: mtcSentPositionMs != null } };
}

/** Asks for one call before the next frame paints; `requestAnimationFrame` in the app, a hand tick in tests. */
export type FrameRequest = (callback: () => void) => void;
const nextFrame: FrameRequest = callback => { requestAnimationFrame(() => callback()); };

/** Display subscriptions only. The output clock and controller retain the full
 * authoritative state; moving a playhead must not rerender the app shell.
 * The engine reports the clock about every 10 ms: clock subscribers hear at most
 * once a frame, control subscribers at once, and `readClock` is always the newest
 * value. Stamping reads `controller.clock.read()`, which none of this delays. */
export class PlayerViewStore {
  private clock: PlayerClockState;
  private control: PlayerControlState;
  private readonly clockListeners = new Set<() => void>();
  private readonly controlListeners = new Set<() => void>();
  private clockScheduled = false;

  constructor(private readonly requestFrame: FrameRequest = nextFrame) {
    const { clock, control } = projectState(emptyInternalPlayerState);
    this.clock = clock; this.control = control;
  }
  readClock = (): PlayerClockState => this.clock;
  readControl = (): PlayerControlState => this.control;
  subscribeClock = (listener: () => void): (() => void) => { this.clockListeners.add(listener); return () => { this.clockListeners.delete(listener); }; };
  subscribeControl = (listener: () => void): (() => void) => { this.controlListeners.add(listener); return () => { this.controlListeners.delete(listener); }; };
  publish = (state: InternalPlayerState): void => {
    const { clock, control } = projectState(state);
    const clockChanged = !equal(this.clock, clock), controlChanged = !equal(this.control, control);
    // Commit both before notifying so a song/seek boundary is never half old.
    if (clockChanged) this.clock = clock;
    if (controlChanged) this.control = control;
    if (controlChanged) for (const listener of this.controlListeners) listener();
    if (clockChanged) this.scheduleClock();
  };
  private scheduleClock(): void {
    // Nobody listening: nothing to schedule; a later subscriber reads the newest value itself.
    if (this.clockScheduled || this.clockListeners.size === 0) return;
    this.clockScheduled = true;
    this.requestFrame(this.flushClock);
  }
  private readonly flushClock = (): void => {
    this.clockScheduled = false;
    for (const listener of this.clockListeners) listener();
  };
}
