import { create } from 'zustand';
import { checkBasis, SHOW_WAIT_BASIS, type CheckBasisInput } from '../view-models/check-basis';
import { useIntegrationStore } from './integration-store';
import { useMa2NetworkStatusStore } from './ma2-network-status-store';

export type ConnectionCheck = {
  /** blocked: not run because an earlier step failed; skipped: not applicable. */
  state: 'waiting' | 'checking' | 'ready' | 'error' | 'skipped' | 'blocked';
  detail: string;
  checkedAt: number;
  /** What the result stood on when it was made (check-basis.ts): it is shown only while that is still so. Absent: it
   * stands on no connection of its own. */
  basis?: string | null;
};

function liveBasis(): CheckBasisInput {
  const integration = useIntegrationStore.getState();
  return { processes: integration.processes, obs: integration.obs, network: useMa2NetworkStatusStore.getState().status };
}
function settled(id: string, state: ConnectionCheck['state'], detail: string): ConnectionCheck {
  const basis = checkBasis(id, liveBasis());
  return { state, detail, checkedAt: Date.now(), ...(basis === undefined ? {} : { basis }) };
}

export const useConnectionCheckStore = create<{
  running: boolean;
  checks: Record<string, ConnectionCheck>;
  pending: string[];
  completed: number;
  total: number;
  begin: (ids: string[]) => boolean;
  checking: (id: string) => void;
  finish: (id: string, state: Exclude<ConnectionCheck['state'], 'checking' | 'waiting'>, detail: string) => void;
  /** The step is not run because the show holds it back (`message`: what showGate said); it waits, it did not fail. */
  waitForShow: (id: string, message: string) => void;
  end: () => void;
}>((set, get) => ({
  running: false, checks: {}, pending: [], completed: 0, total: 0,
  begin: ids => {
    if (get().running) return false;
    // Steps run in sequence; earlier results must not stand in for this run.
    const waiting = Object.fromEntries([...new Set(ids)].map(id => [id, { state: 'waiting' as const, detail: '等前面的步骤完成', checkedAt: Date.now() }]));
    set(state => ({ running: true, checks: { ...state.checks, ...waiting }, pending: [...new Set(ids)], completed: 0, total: new Set(ids).size })); return true;
  },
  checking: id => set(state => ({
    checks: { ...state.checks, [id]: { state: 'checking', detail: '正在连接并检查', checkedAt: Date.now() } },
    ...(state.pending.includes(id) ? {} : { pending: [...state.pending, id], total: state.total + 1 })
  })),
  finish: (id, status, detail) => set(state => ({
    checks: { ...state.checks, [id]: settled(id, status, detail) },
    pending: state.pending.filter(key => key !== id),
    completed: state.completed + (state.running && state.pending.includes(id) ? 1 : 0)
  })),
  waitForShow: (id, message) => set(state => ({
    checks: { ...state.checks, [id]: { state: 'waiting', detail: message, checkedAt: Date.now(), basis: SHOW_WAIT_BASIS } },
    pending: state.pending.filter(key => key !== id),
    completed: state.completed + (state.running && state.pending.includes(id) ? 1 : 0)
  })),
  end: () => set({ running: false })
}));
