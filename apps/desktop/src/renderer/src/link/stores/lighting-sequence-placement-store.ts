import { create } from 'zustand';

/** Shared by drag/drop, the material library and batch placement; not part of the saved song. */
export const useLightingSequencePlacement = create<{ intervalBeats: number; setIntervalBeats: (value: number) => void }>(set => ({
  intervalBeats: 1,
  setIntervalBeats: value => { if (Number.isFinite(value) && value > 0 && value <= 128) set({ intervalBeats: value }); }
}));
