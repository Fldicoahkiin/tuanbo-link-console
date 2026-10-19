import { create } from 'zustand';
import { useIntegrationStore } from './integration-store';
import { ma2LocalDirectoryMismatch } from '../view-models/ma2-local-directory';
import { useConnectionCheckStore } from './connection-check-store';
import { ma2DiscoverySchema, ma2NetworkStatusSchema, type Ma2Discovery, type Ma2NetworkStatus } from '@tb/schema';
import { prepareMa2ComputerNetwork } from '../view-models/ma2-computer-network';

let automaticConnection: Promise<Ma2NetworkStatus> | null = null;
/** Explicit user connection/read action. No retries and no writes to the show. */
export function connectDiscoveredMa2(onDiscovery?: (result: Ma2Discovery) => void, prepareNetwork: (host: string) => Promise<void> = prepareMa2ComputerNetwork): Promise<Ma2NetworkStatus> {
  if (automaticConnection) return automaticConnection;
  automaticConnection = (async () => {
    const current = ma2NetworkStatusSchema.parse(await window.tbLink.getMa2NetworkStatus());
    if (current.state === 'connected') return current;
    // A known IP does not depend on Art-Net discovery or a readable TCP banner.
    if (current.settings) {
      await prepareNetwork(current.settings.host);
      const result = ma2NetworkStatusSchema.parse(await window.tbLink.connectMa2Network());
      if (result.state !== 'connected') throw new Error(result.error ?? `无法直连已保存控台 ${current.settings.host}；请核对 IP，或搜索并选择其他控台。`);
      return result;
    }
    const discovery = ma2DiscoverySchema.parse(await window.tbLink.discoverMa2());
    onDiscovery?.(discovery);
    const consoles = discovery.hosts.filter(host => host.identity === 'ma2');
    if (consoles.length !== 1) throw new Error(consoles.length ? '发现多台控台，请在设备连接中选择本次使用的控台。' : `${discovery.hosts.length ? `发现 ${discovery.hosts.length} 个开放端口，但尚未确认 MA2 身份。` : '搜索范围内未收到控台远程端口响应。'} 可直接填写控台 IP，点击“保存并连接”，无需先搜索到。${discovery.warnings.length ? `\n${discovery.warnings.join('；')}` : ''}`);
    const console = consoles[0]!;
    await prepareNetwork(console.host);
    const profile = current.profiles?.find(value => value.host === console.host && value.port === console.port);
    await window.tbLink.saveMa2Network({ settings: profile ? { ...profile, autoConnect: true } : { host: console.host, port: console.port, monitorPort: 30001, username: 'administrator', autoConnect: true }, ...(profile ? {} : { password: 'admin' }) });
    const result = ma2NetworkStatusSchema.parse(await window.tbLink.connectMa2Network());
    if (result.state !== 'connected') throw new Error(result.error ?? '控台连接尚未完成，请稍后再读取。');
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
    const checked = ma2NetworkStatusSchema.parse(await window.tbLink.checkMa2Capabilities());
    if (checked.state !== 'connected' || !checked.settings) throw new Error(checked.error ?? '控台未连接');
    const { host, port, monitorPort, username } = checked.settings;
    await window.tbLink.exchangeMa2({ dataDirectory: '', network: { host, port, monitorPort, username }, target: 1, operation: 'PING', expected: '', desired: '' });
    if (!useConnectionCheckStore.getState().running) useConnectionCheckStore.getState().finish('bridge', 'ready', '控台工程通信已响应');
    return checked;
  })().finally(() => { networkCheck = null; });
  return networkCheck;
}

export async function connectLocalMa2(directory: string): Promise<void> {
  if (useLocalMa2Store.getState().status === 'connecting') throw new Error('本机 MA2 正在连接，请稍候');
  useLocalMa2Store.setState({ directory, status: 'connecting', error: null });
  try {
    if (!directory.trim()) throw new Error('请在设备维护中填写本机 onPC 数据目录');
    const mismatch = ma2LocalDirectoryMismatch(directory.trim(), useIntegrationStore.getState().processes.ma2);
    if (mismatch) throw new Error(mismatch);
    await window.tbLink.exchangeMa2({ dataDirectory: directory.trim(), target: 1, operation: 'PING', expected: '', desired: '' });
    useLocalMa2Store.setState({ status: 'ready' });
    if (!useConnectionCheckStore.getState().running) useConnectionCheckStore.getState().finish('bridge', 'ready', '本机控台工程通信已响应');
  } catch (error) {
    useLocalMa2Store.setState({ status: 'error', error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
