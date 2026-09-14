import { create } from 'zustand';
import { ma2NetworkStatusSchema, type Ma2NetworkStatus } from '@tb/schema';

type LocalMa2State = { status: 'disconnected' | 'connecting' | 'ready' | 'error'; directory: string; error: string | null };
export const useLocalMa2Store = create<LocalMa2State>(() => ({ status: 'disconnected', directory: '', error: null }));

let networkCheck: Promise<Ma2NetworkStatus> | null = null;
/** Share the read-only check between quick connect and the device panel. */
export function checkNetworkMa2(): Promise<Ma2NetworkStatus> {
  if (networkCheck) return networkCheck;
  networkCheck = (async () => {
    const checked = ma2NetworkStatusSchema.parse(await window.tbLink.checkMa2Capabilities());
    if (checked.state !== 'connected' || !checked.settings) throw new Error(checked.error ?? '控台未连接');
    const { host, port, monitorPort, username } = checked.settings;
    await window.tbLink.exchangeMa2({ dataDirectory: '', network: { host, port, monitorPort, username }, target: 1, operation: 'PING', expected: '', desired: '' });
    return checked;
  })().finally(() => { networkCheck = null; });
  return networkCheck;
}

export async function connectLocalMa2(directory: string): Promise<void> {
  if (useLocalMa2Store.getState().status === 'connecting') throw new Error('本机 MA2 正在连接，请稍候');
  useLocalMa2Store.setState({ directory, status: 'connecting', error: null });
  try {
    if (!directory.trim()) throw new Error('请在设备维护中填写本机 onPC 数据目录');
    await window.tbLink.exchangeMa2({ dataDirectory: directory.trim(), target: 1, operation: 'PING', expected: '', desired: '' });
    useLocalMa2Store.setState({ status: 'ready' });
  } catch (error) {
    useLocalMa2Store.setState({ status: 'error', error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
