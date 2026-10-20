import { create } from 'zustand';
import type { Ma2Catalog, Ma2CatalogRequest } from '@tb/schema';
import type { Ma2AutoSyncStatus, Ma2AutoSyncScope } from '../runtime/ma2-auto-sync';

export const useMa2AutoSyncStore = create<{
  request: { connection: Ma2CatalogRequest; catalog: Ma2Catalog; scope?: Ma2AutoSyncScope } | null;
  status: Ma2AutoSyncStatus;
  message: string;
  previewPlaying: boolean;
  timelinePlaying: boolean;
  commitRequest: number;
}>(() => ({ request: null, status: 'off', message: '等待控台连接与工程', previewPlaying: false, timelinePlaying: false, commitRequest: 0 }));
