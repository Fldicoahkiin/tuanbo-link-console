import { create } from 'zustand';

/**
 * 2026-10-24: normal mode is the default. The choice is saved under this key as
 * 'low' or 'normal'; a low-power choice saved by earlier versions is not carried
 * over, so every machine starts in normal mode after the upgrade.
 */
const KEY = 'tblink.power-mode';
const SPECTRUM_KEY = 'tblink.home-spectrum';
export const useDisplayPreferences = create<{
  lowPower: boolean;
  preciseSeeking: boolean;
  setPreciseSeeking: (enabled: boolean) => void;
  /** The spectrum next to the home player; hidden unless the operator asks for it (2026-10-30). */
  homeSpectrum: boolean;
  setHomeSpectrum: (shown: boolean) => void;
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
  homeSpectrum: false,
  setHomeSpectrum: (homeSpectrum) => {
    localStorage.setItem(SPECTRUM_KEY, String(homeSpectrum));
    set({ homeSpectrum });
  },
  loaded: false,
  load: () => {
    if (get().loaded) return;
    set({ lowPower: localStorage.getItem(KEY) === 'low', preciseSeeking: localStorage.getItem('tblink.precise-seeking') !== 'false', homeSpectrum: localStorage.getItem(SPECTRUM_KEY) === 'true', loaded: true });
  },
  setLowPower: (lowPower) => {
    localStorage.setItem(KEY, lowPower ? 'low' : 'normal');
    set({ lowPower, loaded: true });
  }
}));
