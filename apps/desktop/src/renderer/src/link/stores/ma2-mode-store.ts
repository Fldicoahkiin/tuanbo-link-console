import { create } from 'zustand';

export type Ma2ConnectionMethod = 'midi' | 'local' | 'network';
const key = 'tblink.ma2-connection-method.v1';

export function readMa2Method(): Ma2ConnectionMethod {
  if (typeof localStorage === 'undefined') return 'midi';
  const value = localStorage.getItem(key);
  if (value === 'midi' || value === 'local' || value === 'network') return value;
  return localStorage.getItem('tblink.ma2-onpc-data-directory.v1') ? 'local' : 'midi';
}

export const useMa2ModeStore = create<{ method: Ma2ConnectionMethod }>(() => ({ method: readMa2Method() }));

export async function setMa2Method(method: Ma2ConnectionMethod): Promise<void> {
  if (method === 'midi') {
    const status = await window.tbLink.getMa2NetworkStatus();
    if (status.settings?.autoConnect) await window.tbLink.saveMa2Network({ settings: { ...status.settings, autoConnect: false } });
    await window.tbLink.disconnectMa2Network();
  }
  localStorage.setItem(key, method);
  useMa2ModeStore.setState({ method });
}
