import { create } from 'zustand';

type SettingsSession = {
  dirty: Record<string, boolean>;
  revision: number;
  setDirty: (section: string, dirty: boolean) => void;
  reset: () => void;
};

/** Unsaved settings are session-only; credentials never enter this store. */
export const useSettingsSessionStore = create<SettingsSession>((set) => ({
  dirty: {}, revision: 0,
  setDirty: (section, dirty) => set(state => state.dirty[section] === dirty ? state : { dirty: { ...state.dirty, [section]: dirty } }),
  reset: () => set(state => ({ dirty: {}, revision: state.revision + 1 }))
}));
