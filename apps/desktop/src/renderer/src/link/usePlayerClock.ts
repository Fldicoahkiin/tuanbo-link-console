import { useSyncExternalStore } from 'react';
import type { PlayerViewStore } from './stores/player-view-store';

const inactiveSubscription = (): (() => void) => () => undefined;
export function usePlayerClock(store: PlayerViewStore, active = true) {
  return useSyncExternalStore(active ? store.subscribeClock : inactiveSubscription, store.readClock);
}
