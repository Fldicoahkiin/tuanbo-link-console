import { create } from 'zustand';
import type { LightingEventClipboard } from '@tb/core/link';

// In-memory snapshot survives programme switches and source edits/deletion.
// It contains event data only; device connections remain on the target track.
export const useLightingClipboardStore = create<{
  clipboard: LightingEventClipboard | null;
  setClipboard: (clipboard: LightingEventClipboard) => void;
}>((set) => ({ clipboard: null, setClipboard: (clipboard) => set({ clipboard }) }));
