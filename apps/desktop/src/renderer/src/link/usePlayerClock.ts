import { useCallback, useState, useSyncExternalStore } from 'react';
import type { PlayerClockState, PlayerViewStore } from './stores/player-view-store';

const inactiveSubscription = (): (() => void) => () => undefined;
const wholeClock = (clock: PlayerClockState): PlayerClockState => clock;

/** What one `usePlayerClock` last handed React. useSyncExternalStore needs the same value
 * back while nothing it cares about changed; a selector written inline is a new function
 * every render, so a value `equal` calls the same is kept as well. */
export class ClockSelection {
  private last: { clock: PlayerClockState; select: (clock: PlayerClockState) => unknown; value: unknown } | null = null;
  read(clock: PlayerClockState, select: (clock: PlayerClockState) => unknown, equal: (left: unknown, right: unknown) => boolean): unknown {
    const previous = this.last;
    if (previous && previous.clock === clock && previous.select === select) return previous.value;
    const next = select(clock);
    const value = previous && equal(previous.value, next) ? previous.value : next;
    this.last = { clock, select, value };
    return value;
  }
}

/** The playback clock for display, at most once a frame (PlayerViewStore). Pass a
 * selector (and an equality) to rerender only when that part changes, e.g.
 * `clock => clock.positionMs`. Without one the whole clock comes back, as before. */
export function usePlayerClock(store: PlayerViewStore, active?: boolean): PlayerClockState;
export function usePlayerClock<T>(store: PlayerViewStore, active: boolean, selector: (clock: PlayerClockState) => T, equal?: (left: T, right: T) => boolean): T;
export function usePlayerClock(store: PlayerViewStore, active = true,
  selector: (clock: PlayerClockState) => unknown = wholeClock, equal: (left: unknown, right: unknown) => boolean = Object.is): unknown {
  const [selection] = useState(() => new ClockSelection());
  const read = useCallback(() => selection.read(store.readClock(), selector, equal), [selection, store, selector, equal]);
  return useSyncExternalStore(active ? store.subscribeClock : inactiveSubscription, read);
}
