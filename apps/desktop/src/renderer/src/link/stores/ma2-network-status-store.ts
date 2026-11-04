import { create } from 'zustand';
import type { Ma2NetworkStatus } from '@tb/schema';

/** The console network connection as last read; one reader keeps it current (`useStatusSources`). */
export const useMa2NetworkStatusStore = create<{ status: Ma2NetworkStatus | null; error: string | null }>(() => ({ status: null, error: null }));
