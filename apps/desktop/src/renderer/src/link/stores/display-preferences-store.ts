import { create } from 'zustand';

/**
 * 2026-10-24: normal mode is the default. The choice is saved under this key as
 * 'low' or 'normal'; a low-power choice saved by earlier versions is not carried
 * over, so every machine starts in normal mode after the upgrade.
 */
const KEY = 'tblink.power-mode';
export const useDisplayPreferences = create<{
  lowPower: boolean;
  preciseSeeking: boolean;
  setPreciseSeeking: (enabled: boolean) => void;
  loaded: boolean;
  load: () => void;
  setLowPower: (enabled: boolean) => void;
}>((set, get) => ({
  lowPower: false,
  preciseSeeking: true,
  setPreciseSeeking: (preciseSeeking) => {
    localStorage.setItem('tblink.precise-seeking', String(preciseSeeking));
    set({ preciseSeeking });
  },
  loaded: false,
  load: () => {
    if (get().loaded) return;
    set({ lowPower: localStorage.getItem(KEY) === 'low', preciseSeeking: localStorage.getItem('tblink.precise-seeking') !== 'false', loaded: true });
  },
  setLowPower: (lowPower) => {
    localStorage.setItem(KEY, lowPower ? 'low' : 'normal');
    set({ lowPower, loaded: true });
  }
}));
