import { emptyInternalPlayerState, type InternalPlayerState } from '../runtime/internal-playback-controller';

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

/** Display subscriptions only. The output clock and controller retain the full
 * authoritative state; moving a playhead must not rerender the app shell. */
export class PlayerViewStore {
  private clock: PlayerClockState;
  private control: PlayerControlState;
  private readonly clockListeners = new Set<() => void>();
  private readonly controlListeners = new Set<() => void>();

  constructor() {
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
    if (clockChanged) for (const listener of this.clockListeners) listener();
  };
}
