import { create } from 'zustand';
import { showGate, type ShowGate, type ShowOperation, type ShowState } from '@tb/core/link';

/**
 * The show state, mirrored from the main process (ShowStateService, link:show-state); `useShowStateMirror` keeps it
 * current. Nothing here derives it: it is what main last sent, idle until the first answer. Ask what may run now with
 * `useShowGate` (components) or `currentShowGate` (outside React), never by reading the phase: showGate is the one place
 * that decides (00-order §2.4). The main process asks again and has the last word, so a mirror one change late holds
 * nothing up for long.
 */
export const useShowStateStore = create<{ show: ShowState }>(() => ({ show: { phase: 'idle', program: null } }));

/** Whether `op` may run now, read once (runtime code, view-models). */
export function currentShowGate(op: ShowOperation, itemId?: string): ShowGate {
  return showGate(op, useShowStateStore.getState().show, itemId);
}

/** Whether `op` may run now, for a component; re-rendered when the answer changes. */
export function useShowGate(op: ShowOperation, itemId?: string): ShowGate {
  const show = useShowStateStore(state => state.show);
  return showGate(op, show, itemId);
}
