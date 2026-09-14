import { create } from 'zustand';
import type { CueExecutionReport, LinkRuntimeState, ManagedMediaEvent, PreflightReport } from '@tb/core/link';
import type { SmpteTimecode } from '@tb/schema';
import type { MtcFrameRate } from '@tb/schema';

export type RuntimeStoreState = {
  state: LinkRuntimeState;
  mode: 'rehearsal' | 'live';
  manualTakeover: boolean;
  currentItemId: string | null;
  timecode: SmpteTimecode | null;
  detectedFrameRate: MtcFrameRate | null;
  mtcStable: boolean;
  lastMtcAt: number | null;
  currentCueId: string | null;
  nextCueId: string | null;
  missedCueIds: string[];
  reason: string | null;
  preflight: PreflightReport | null;
  reports: CueExecutionReport[];
  mediaReports: ManagedMediaExecutionReport[];
  setState: (update: Partial<Omit<RuntimeStoreState, 'setState' | 'reset'>>) => void;
  reset: () => void;
};

export type ManagedMediaExecutionReport = {
  executionId: string;
  event: ManagedMediaEvent;
  status: 'succeeded' | 'failed' | 'skipped';
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  error?: string;
};

const initial = {
  state: 'idle' as const,
  mode: 'rehearsal' as const,
  manualTakeover: false,
  currentItemId: null,
  timecode: null,
  detectedFrameRate: null,
  mtcStable: false,
  lastMtcAt: null,
  currentCueId: null,
  nextCueId: null,
  missedCueIds: [] as string[],
  reason: null,
  preflight: null,
  reports: [] as CueExecutionReport[],
  mediaReports: [] as ManagedMediaExecutionReport[]
};

export const useRuntimeStore = create<RuntimeStoreState>((set) => ({
  ...initial,
  setState: (update) => set(update),
  reset: () => set(initial)
}));
