import { afterEach, expect, it, vi } from 'vitest';
import { checkNetworkMa2, connectLocalMa2, useLocalMa2Store } from './ma2-connection-store';

afterEach(() => { vi.unstubAllGlobals(); useLocalMa2Store.setState({ status: 'disconnected', directory: '', error: null }); });

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
