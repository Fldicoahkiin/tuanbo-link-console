import { create } from 'zustand';

export type ConnectionCheck = {
  state: 'checking' | 'ready' | 'error' | 'skipped';
  detail: string;
  checkedAt: number;
};
export const useConnectionCheckStore = create<{
  running: boolean;
  checks: Record<string, ConnectionCheck>;
  pending: string[];
  completed: number;
  total: number;
  begin: (ids: string[]) => boolean;
  checking: (id: string) => void;
  finish: (id: string, state: Exclude<ConnectionCheck['state'], 'checking'>, detail: string) => void;
  end: () => void;
}>((set, get) => ({
  running: false, checks: {}, pending: [], completed: 0, total: 0,
  begin: ids => {
    if (get().running) return false;
    set({ running: true, pending: [...new Set(ids)], completed: 0, total: new Set(ids).size }); return true;
  },
  checking: id => set(state => ({
    checks: { ...state.checks, [id]: { state: 'checking', detail: '正在连接与检查', checkedAt: Date.now() } },
    ...(state.pending.includes(id) ? {} : { pending: [...state.pending, id], total: state.total + 1 })
  })),
  finish: (id, status, detail) => set(state => ({
    checks: { ...state.checks, [id]: { state: status, detail, checkedAt: Date.now() } },
    pending: state.pending.filter(key => key !== id),
    completed: state.completed + (state.running && state.pending.includes(id) ? 1 : 0)
  })),
  end: () => set({ running: false })
}));
