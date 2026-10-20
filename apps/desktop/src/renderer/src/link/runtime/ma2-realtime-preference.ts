import { create } from 'zustand';

const key = 'tblink.ma2-realtime-enabled.v1';
/** A deliberate pause survives restart; first use is enabled. */
export const useMa2RealtimePreference = create<{ enabled: boolean }>(() => ({
  enabled: typeof localStorage === 'undefined' || localStorage.getItem(key) !== 'false'
}));
export function setMa2RealtimeEnabled(enabled: boolean): void {
  localStorage.setItem(key, String(enabled));
  useMa2RealtimePreference.setState({ enabled });
}
