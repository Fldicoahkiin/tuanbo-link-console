import { afterEach, expect, it, vi } from 'vitest';
import { checkNetworkMa2, connectSavedMa2, connectLocalMa2, useLocalMa2Store } from './ma2-connection-store';

// The imported mode store reads browser storage during module initialization.
vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null }); });

afterEach(() => { vi.unstubAllGlobals(); useLocalMa2Store.setState({ status: 'disconnected', directory: '', error: null }); });
it('登录已有地址只尝试一次，控台离线也不触发搜索或更改电脑网卡', async () => {
  const settings = { host: '2.1.0.1', port: 30000, monitorPort: 30001, username: 'operator', autoConnect: false };
  const current = { state: 'disconnected', settings, passwordSaved: true, version: null, error: null };
  const connect = vi.fn().mockResolvedValue({ ...current, error: '控台没有响应', unreachable: true });
  const discover = vi.fn(), apply = vi.fn();
  vi.stubGlobal('window', { tbLink: { getMa2NetworkStatus: () => Promise.resolve(current), connectMa2Network: connect, discoverMa2: discover, applyMa2NetworkSetup: apply } });
  await expect(connectSavedMa2()).rejects.toThrow('控台没有响应');
  expect(connect).toHaveBeenCalledOnce();
  expect(discover).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
});
it('本机连接只确认登录，连接时不调用插件', async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  const settings = { host: '127.0.0.1', port: 30000, monitorPort: 30001, username: 'operator', autoConnect: false };
  const status = { state: 'connected', settings, passwordSaved: true, version: '3.7.0.5', error: null };
  const exchangeMa2 = vi.fn().mockResolvedValue('PONG');
  const save = vi.fn();
  vi.stubGlobal('window', { tbLink: { exchangeMa2, getMa2NetworkStatus: () => Promise.resolve(status), connectMa2Network: () => Promise.resolve(status), checkMa2Capabilities: () => Promise.resolve(status), saveMa2Network: save } });
  await connectLocalMa2();
  expect(useLocalMa2Store.getState().status).toBe('ready');
  expect(exchangeMa2).not.toHaveBeenCalled();
  expect(storage.get('tblink.ma2-connection-method.v1')).toBe('network');
  expect(save).not.toHaveBeenCalled();

});

it('选择本机时只连接本机，复用保存的登录，不搜索或尝试远处的控台', async () => {
  vi.stubGlobal('localStorage', { getItem: () => 'local', setItem: vi.fn() });
  const local = { host: '127.0.0.1', port: 30000, monitorPort: 30001, username: 'operator', autoConnect: false };
  const remote = { ...local, host: '192.0.2.1' };
  const current = { state: 'connected', settings: remote, profiles: [remote, local], passwordSaved: true, version: '3.7.0.5', error: null };
  const save = vi.fn(); const discover = vi.fn(); const exchange = vi.fn();
  const connect = vi.fn().mockResolvedValue({ ...current, state: 'disconnected', settings: local, error: '本机拒绝登录' });
  vi.stubGlobal('window', { tbLink: { getMa2NetworkStatus: () => Promise.resolve(current), saveMa2Network: save, connectMa2Network: connect, discoverMa2: discover, exchangeMa2: exchange } });
  await expect(connectLocalMa2()).rejects.toThrow('本机拒绝登录');
  expect(save).toHaveBeenCalledExactlyOnceWith({ settings: local });
  expect(connect).toHaveBeenCalledOnce();
  expect(discover).not.toHaveBeenCalled(); expect(exchange).not.toHaveBeenCalled();
  expect(useLocalMa2Store.getState().status).toBe('error');
});

it('顶部与设备页共享正在进行的检查，登录完成仍需插件 PING', async () => {
  const status = { state: 'connected', settings: { host: '192.168.1.20', port: 30000, monitorPort: 30001, username: 'operator', autoConnect: false }, passwordSaved: true, version: '3.3.4.3', error: null };
  const check = vi.fn().mockResolvedValue(status);
  const exchange = vi.fn().mockRejectedValue(new Error('插件未响应'));
  vi.stubGlobal('window', { tbLink: { getMa2NetworkStatus: () => Promise.resolve(status), startMa2Reading: vi.fn(), checkMa2Capabilities: check, exchangeMa2: exchange } });
  const first = checkNetworkMa2(); const second = checkNetworkMa2();
  expect(first).toBe(second);
  await expect(first).rejects.toThrow('插件未响应');
  expect(check).toHaveBeenCalledTimes(1); expect(exchange).toHaveBeenCalledTimes(1);
  expect(exchange).toHaveBeenCalledWith(expect.objectContaining({ network: { host: '192.168.1.20', port: 30000, monitorPort: 30001, username: 'operator' }, operation: 'PING' }));
});
