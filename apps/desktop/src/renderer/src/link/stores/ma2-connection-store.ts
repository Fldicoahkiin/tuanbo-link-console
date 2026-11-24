import { create } from 'zustand';
import { setMa2Method } from './ma2-mode-store';
import { useConnectionCheckStore } from './connection-check-store';
import { useMa2NetworkStatusStore } from './ma2-network-status-store';
import { ma2NetworkStatusSchema, type Ma2NetworkStatus } from '@tb/schema';

let automaticConnection: Promise<Ma2NetworkStatus> | null = null;
/** Login never invokes discovery or changes a network adapter. */
export function connectSavedMa2(): Promise<Ma2NetworkStatus> {
  if (automaticConnection) return automaticConnection;
  automaticConnection = (async () => {
    const current = ma2NetworkStatusSchema.parse(await window.tbLink.getMa2NetworkStatus());
    if (current.state === 'connected') return current;
    if (!current.settings) throw new Error('请先在设置里填写控台 IP，或点“搜索控台”选择地址');
    const result = ma2NetworkStatusSchema.parse(await window.tbLink.connectMa2Network());
    if (result.state !== 'connected') throw new Error(result.error ?? '控台没有登录成功，请检查控台 IP 和网卡设置');
    return result;
  })().finally(() => { automaticConnection = null; });
  return automaticConnection;
}

type LocalMa2State = { status: 'disconnected' | 'connecting' | 'ready' | 'error'; directory: string; error: string | null };
export const useLocalMa2Store = create<LocalMa2State>(() => ({ status: 'disconnected', directory: '', error: null }));

let networkCheck: Promise<Ma2NetworkStatus> | null = null;
/** Share the read-only check between quick connect and the device panel. */
export function checkNetworkMa2(): Promise<Ma2NetworkStatus> {
  if (networkCheck) return networkCheck;
  networkCheck = (async () => {
    const login = ma2NetworkStatusSchema.parse(await window.tbLink.getMa2NetworkStatus());
    if (login.state !== 'connected' || !login.settings) throw new Error('请先连接控台');
    const { host, port, monitorPort, username } = login.settings;
    await window.tbLink.startMa2Reading({ host, port, monitorPort, username });
    const checked = ma2NetworkStatusSchema.parse(await window.tbLink.checkMa2Capabilities());
    // The connection the check stands on, as main just read it back (check-basis.ts).
    useMa2NetworkStatusStore.setState({ status: checked, error: null });
    if (checked.state !== 'connected' || !checked.settings) throw new Error(checked.error ?? '控台未连接');
    await window.tbLink.exchangeMa2({ dataDirectory: '', network: { host, port, monitorPort, username }, target: 1, operation: 'PING', expected: '', desired: '' });
    if (!useConnectionCheckStore.getState().running) useConnectionCheckStore.getState().finish('bridge', 'ready', '控台读写通信正常');
    return checked;
  })().finally(() => { networkCheck = null; });
  return networkCheck;
}

/** Local onPC uses the same login, bundled plugin and sync as a console on the LAN.
 * Selecting local is an explicit target choice, never a fallback to another console. */
export async function connectLocalMa2(): Promise<Ma2NetworkStatus> {
  if (useLocalMa2Store.getState().status === 'connecting') throw new Error('本机 MA2 正在连接，请稍候');
  useLocalMa2Store.setState({ directory: '', status: 'connecting', error: null });
  try {
    const current = ma2NetworkStatusSchema.parse(await window.tbLink.getMa2NetworkStatus());
    const saved = current.settings?.host === '127.0.0.1' ? current.settings
      : [...current.profiles ?? []].reverse().find(profile => profile.host === '127.0.0.1');
    if (!saved || current.settings !== saved) {
      await window.tbLink.saveMa2Network({ settings: saved ?? { host: '127.0.0.1', port: 30000, monitorPort: 30001, username: 'administrator', autoConnect: false },
        ...(saved ? {} : { password: 'admin' }) });
    }
    const connected = ma2NetworkStatusSchema.parse(await window.tbLink.connectMa2Network());
    if (connected.state !== 'connected' || connected.settings?.host !== '127.0.0.1') throw new Error(connected.error ?? '本机 onPC 没有连上，请确认已启动，并在 onPC 中开启 Telnet（Login Enabled）');
    // Persist the working transport: all reads, sync jobs and follow checks now use this connection.
    await setMa2Method('network');
    useLocalMa2Store.setState({ status: 'ready' });
    return connected;
  } catch (error) {
    useLocalMa2Store.setState({ status: 'error', error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
