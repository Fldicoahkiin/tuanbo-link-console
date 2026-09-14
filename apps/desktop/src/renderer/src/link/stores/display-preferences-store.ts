import { create } from 'zustand';

const KEY = 'tblink.low-power';
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
    const value = localStorage.getItem(KEY);
    set({ lowPower: value === 'true', preciseSeeking: localStorage.getItem('tblink.precise-seeking') !== 'false', loaded: true });
  },
  setLowPower: (lowPower) => {
    localStorage.setItem(KEY, String(lowPower));
    set({ lowPower, loaded: true });
  }
}));
