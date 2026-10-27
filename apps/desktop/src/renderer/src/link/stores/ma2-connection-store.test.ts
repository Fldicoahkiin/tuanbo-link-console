import { afterEach, expect, it, vi } from 'vitest';
import { checkNetworkMa2, connectDiscoveredMa2, connectLocalMa2, useLocalMa2Store } from './ma2-connection-store';
import { useIntegrationStore } from './integration-store';

afterEach(() => { vi.unstubAllGlobals(); useLocalMa2Store.setState({ status: 'disconnected', directory: '', error: null }); });
it('首次唯一识别到 MA2 时自动准备网络、保存并连接，无需填写 IP', async () => {
  const settings = { host: '10.39.15.200', port: 30000, monitorPort: 30001, username: 'administrator', autoConnect: true };
  const current = { state: 'disconnected', settings: null, passwordSaved: false, version: null, error: null };
  const prepare = vi.fn().mockResolvedValue(undefined); const save = vi.fn().mockResolvedValue(undefined);
  const connect = vi.fn().mockResolvedValue({ ...current, state: 'connected', settings });
  vi.stubGlobal('window', { tbLink: {
    getMa2NetworkStatus: () => Promise.resolve(current), discoverMa2: () => Promise.resolve({ hosts: [{ host: settings.host, port: 30000, identity: 'ma2' }], ranges: [], warnings: [] }),
    saveMa2Network: save, connectMa2Network: connect
  } });
  expect((await connectDiscoveredMa2(undefined, prepare)).state).toBe('connected');
  expect(prepare).toHaveBeenCalledExactlyOnceWith(settings.host);
  expect(save).toHaveBeenCalledWith({ settings, password: 'admin' });
  expect(connect).toHaveBeenCalledTimes(1);
});
it('已保存 IP 直接连接，不要求广播发现；失败明确返回而不重试', async () => {
  const status = { state: 'disconnected', settings: { host: '2.97.214.223', port: 30000, monitorPort: 30001, username: 'operator', autoConnect: false }, passwordSaved: true, version: null, error: null };
  const discover = vi.fn(); const connect = vi.fn().mockResolvedValue({ ...status, state: 'connected' });
  vi.stubGlobal('window', { tbLink: { getMa2NetworkStatus: () => Promise.resolve(status), discoverMa2: discover, connectMa2Network: connect } });
  const prepare=vi.fn().mockResolvedValue(undefined);
  expect((await connectDiscoveredMa2(undefined,prepare)).state).toBe('connected'); expect(discover).not.toHaveBeenCalled();expect(prepare).toHaveBeenCalledWith(status.settings.host);
  connect.mockResolvedValue({ ...status, error: '命令端口超时' });
  await expect(connectDiscoveredMa2(undefined,prepare)).rejects.toThrow('命令端口超时'); expect(connect).toHaveBeenCalledTimes(2);
});
it('首次发现未识别设备时保留结果与网卡诊断，不擅自登录候选端口', async () => {
  const result = { hosts: [{ host: '2.97.214.223', port: 30000, identity: 'candidate' }], ranges: ['本机'], warnings: ['广播端口被占用'] };
  const onDiscovery = vi.fn(); const connect = vi.fn();
  vi.stubGlobal('window', { tbLink: { getMa2NetworkStatus: () => Promise.resolve({ state: 'disconnected', settings: null, passwordSaved: false, version: null, error: null }), discoverMa2: () => Promise.resolve(result), connectMa2Network: connect } });
  await expect(connectDiscoveredMa2(onDiscovery)).rejects.toThrow('广播端口被占用');
  expect(onDiscovery).toHaveBeenCalledWith(result); expect(connect).not.toHaveBeenCalled();
});

it('本机连接必须收到插件响应，失败不能保留已连接状态', async () => {
  const exchangeMa2 = vi.fn().mockResolvedValue('PONG');
  vi.stubGlobal('window', { tbLink: { exchangeMa2 } });
  await connectLocalMa2('C:/MA2/acceptance');
  expect(useLocalMa2Store.getState().status).toBe('ready');
  expect(exchangeMa2).toHaveBeenCalledWith(expect.objectContaining({ operation: 'PING', dataDirectory: 'C:/MA2/acceptance' }));
  exchangeMa2.mockRejectedValueOnce(new Error('插件超时'));
  await expect(connectLocalMa2('C:/MA2/other')).rejects.toThrow('插件超时');
  expect(useLocalMa2Store.getState()).toMatchObject({ status: 'error', directory: 'C:/MA2/other', error: '插件超时' });
});

it('本机目录版本与正在运行的 onPC 不符时不发出会超时的插件请求', async () => {
  const processes = useIntegrationStore.getState().processes;
  const exchangeMa2 = vi.fn();
  vi.stubGlobal('window', { tbLink: { exchangeMa2 } });
  useIntegrationStore.setState({ processes: { ...processes, ma2: { ...processes.ma2,
    status: 'running', executablePath: 'D:/ma/grandma2 onpc 3.7.0.5/gma2onpc.exe.exe', fileVersion: '3.7.0.5' } } });
  try {
    await expect(connectLocalMa2('C:/ProgramData/MA Lighting Technologies/grandma/gma2_V_3.3.4')).rejects.toThrow('正在运行的是 onPC 3.7.0');
    expect(exchangeMa2).not.toHaveBeenCalled();
    expect(useLocalMa2Store.getState().status).toBe('error');
    expect(useLocalMa2Store.getState().error).toContain('127.0.0.1');
  } finally { useIntegrationStore.setState({ processes }); }
});

it('顶部与设备页共享正在进行的检查，登录完成仍需插件 PING', async () => {
  const status = { state: 'connected', settings: { host: '192.168.1.20', port: 30000, monitorPort: 30001, username: 'operator', autoConnect: false }, passwordSaved: true, version: '3.3.4.3', error: null };
  const check = vi.fn().mockResolvedValue(status);
  const exchange = vi.fn().mockRejectedValue(new Error('插件未响应'));
  vi.stubGlobal('window', { tbLink: { checkMa2Capabilities: check, exchangeMa2: exchange } });
  const first = checkNetworkMa2(); const second = checkNetworkMa2();
  expect(first).toBe(second);
  await expect(first).rejects.toThrow('插件未响应');
  expect(check).toHaveBeenCalledTimes(1); expect(exchange).toHaveBeenCalledTimes(1);
  expect(exchange).toHaveBeenCalledWith(expect.objectContaining({ network: { host: '192.168.1.20', port: 30000, monitorPort: 30001, username: 'operator' }, operation: 'PING' }));
});
