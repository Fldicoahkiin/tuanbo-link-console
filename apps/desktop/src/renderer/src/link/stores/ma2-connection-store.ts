import { create } from 'zustand';
import { useIntegrationStore } from './integration-store';
import { ma2LocalDirectoryMismatch } from '../view-models/ma2-local-directory';
import { useConnectionCheckStore } from './connection-check-store';
import { ma2DiscoverySchema, ma2NetworkStatusSchema, type Ma2Discovery, type Ma2NetworkStatus } from '@tb/schema';
import { prepareMa2ComputerNetwork } from '../view-models/ma2-computer-network';

let automaticConnection: Promise<Ma2NetworkStatus> | null = null;
/**
 * Explicit user connection/read action. No retries and no writes to the show. A saved address that
 * nothing answers on leads to one search: exactly one console found at another address is saved and
 * connected, and `onNotice` says so; the saved address itself is never tried a second time.
 */
export function connectDiscoveredMa2(onDiscovery?: (result: Ma2Discovery) => void, prepareNetwork: (host: string) => Promise<void> = prepareMa2ComputerNetwork, onNotice?: (message: string) => void): Promise<Ma2NetworkStatus> {
  if (automaticConnection) return automaticConnection;
  automaticConnection = (async () => {
    const current = ma2NetworkStatusSchema.parse(await window.tbLink.getMa2NetworkStatus());
    if (current.state === 'connected') return current;
    const search = async (): Promise<{ discovery: Ma2Discovery; consoles: Ma2Discovery['hosts'] }> => {
      const discovery = ma2DiscoverySchema.parse(await window.tbLink.discoverMa2());
      onDiscovery?.(discovery);
      return { discovery, consoles: discovery.hosts.filter(host => host.identity === 'ma2') };
    };
    const connectFound = async (found: Ma2Discovery['hosts'][number], autoConnect: boolean): Promise<Ma2NetworkStatus> => {
      await prepareNetwork(found.host);
      const profile = current.profiles?.find(value => value.host === found.host && value.port === found.port);
      await window.tbLink.saveMa2Network({ settings: profile ? { ...profile, autoConnect } : { host: found.host, port: found.port, monitorPort: 30001, username: 'administrator', autoConnect }, ...(profile ? {} : { password: 'admin' }) });
      const result = ma2NetworkStatusSchema.parse(await window.tbLink.connectMa2Network());
      if (result.state !== 'connected') throw new Error(result.error ?? '控台还没连接好，请稍后再读取。');
      return result;
    };
    // A known IP does not depend on Art-Net discovery or a readable TCP banner.
    if (current.settings) {
      const saved = current.settings;
      await prepareNetwork(saved.host);
      const result = ma2NetworkStatusSchema.parse(await window.tbLink.connectMa2Network());
      if (result.state === 'connected') return result;
      const failure = result.error ?? `连不上已保存的控台 ${saved.host}。请检查 IP，或搜索并选择其他控台。`;
      // Only a dead address is searched past; a console that answers but refuses the login stays the operator's to fix.
      if (!result.unreachable) throw new Error(failure);
      const { discovery, consoles } = await search();
      const moved = consoles.filter(host => host.host !== saved.host);
      if (consoles.some(host => host.host === saved.host)) throw new Error(`控台 ${saved.host} 刚才没连上，重新搜索时它有回应了。请再点一次连接。`);
      if (moved.length === 1) {
        const found = moved[0]!;
        const connected = await connectFound(found, saved.autoConnect);
        onNotice?.(`已保存的控台 ${saved.host} 连不上，搜索到控台在 ${found.host}，已改连这台并保存。`);
        return connected;
      }
      if (moved.length > 1) throw new Error(`已保存的控台 ${saved.host} 连不上。搜索到 ${moved.length} 台控台（${moved.map(host => host.host).join('、')}），请在 MA2 设置里选这次要用的那台。`);
      throw new Error(`${failure}\n重新搜索也没找到控台：请确认控台已开机、网线插在这台电脑上，再看控台屏幕上的 IP 是否还是 ${saved.host}。${discovery.warnings.length ? `\n${discovery.warnings.join('；')}` : ''}`);
    }
    const { discovery, consoles } = await search();
    if (consoles.length !== 1) throw new Error(consoles.length ? '找到了多台控台，请在设备连接里选择这次要用的控台。' : `${discovery.hosts.length ? `找到 ${discovery.hosts.length} 个开放端口，但还不能确认是 MA2。` : '搜索范围内没有控台响应。'} 可以直接填写控台 IP，点“保存并连接”，不用先搜索到。${discovery.warnings.length ? `\n${discovery.warnings.join('；')}` : ''}`);
    return connectFound(consoles[0]!, true);
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
    if (!useConnectionCheckStore.getState().running) useConnectionCheckStore.getState().finish('bridge', 'ready', '控台读写通信正常');
    return checked;
  })().finally(() => { networkCheck = null; });
  return networkCheck;
}

export async function connectLocalMa2(directory: string): Promise<void> {
  if (useLocalMa2Store.getState().status === 'connecting') throw new Error('本机 MA2 正在连接，请稍候');
  useLocalMa2Store.setState({ directory, status: 'connecting', error: null });
  try {
    if (!directory.trim()) throw new Error('请在 MA2 设置里选择或一键识别本机 onPC 数据目录');
    const mismatch = ma2LocalDirectoryMismatch(directory.trim(), useIntegrationStore.getState().processes.ma2);
    if (mismatch) throw new Error(mismatch);
    await window.tbLink.exchangeMa2({ dataDirectory: directory.trim(), target: 1, operation: 'PING', expected: '', desired: '' });
    useLocalMa2Store.setState({ status: 'ready' });
    if (!useConnectionCheckStore.getState().running) useConnectionCheckStore.getState().finish('bridge', 'ready', '本机控台读写通信正常');
  } catch (error) {
    useLocalMa2Store.setState({ status: 'error', error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
