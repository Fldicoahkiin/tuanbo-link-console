import { afterEach, expect, it, vi } from 'vitest';
import { readMa2Method, setMa2Method, useMa2ModeStore } from './ma2-mode-store';

// The store reads browser storage during import, before per-test stubs exist.
vi.hoisted(() => {
  vi.stubGlobal('localStorage', { getItem: () => null });
});

afterEach(() => { vi.unstubAllGlobals(); useMa2ModeStore.setState({ method: 'midi' }); });

it('新机器默认仅 MIDI，保留明确配置的高级连接', () => {
  const entries = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => entries.get(key) ?? null });
  expect(readMa2Method()).toBe('midi');
  entries.set('tblink.ma2-connection-method.v1', 'network');
  expect(readMa2Method()).toBe('network');
  entries.set('tblink.ma2-connection-method.v1', 'midi');
  entries.set('tblink.ma2-onpc-data-directory.v1', 'C:/MA2');
  expect(readMa2Method()).toBe('midi');
});

it('改为 MIDI 时关闭网络启动连接并断开，不覆盖密码', async () => {
  const settings = { host: '192.168.1.2', port: 30000, monitorPort: 30001, username: 'operator', autoConnect: true };
  const save = vi.fn().mockResolvedValue({}); const disconnect = vi.fn().mockResolvedValue({});
  const persist = vi.fn();
  vi.stubGlobal('localStorage', { setItem: persist });
  vi.stubGlobal('window', { tbLink: { getMa2NetworkStatus: () => Promise.resolve({ settings }), saveMa2Network: save, disconnectMa2Network: disconnect } });
  await setMa2Method('midi');
  expect(save).toHaveBeenCalledWith({ settings: { ...settings, autoConnect: false } });
  expect(disconnect).toHaveBeenCalledTimes(1);
  expect(persist).toHaveBeenCalledWith('tblink.ma2-connection-method.v1', 'midi');
});

it('断开失败明确拒绝，不伪报 MIDI 模式切换成功', async () => {
  const persist = vi.fn();
  vi.stubGlobal('localStorage', { setItem: persist });
  vi.stubGlobal('window', { tbLink: { getMa2NetworkStatus: () => Promise.resolve({ settings: null }), disconnectMa2Network: () => Promise.reject(new Error('断开失败')) } });
  useMa2ModeStore.setState({ method: 'network' });
  await expect(setMa2Method('midi')).rejects.toThrow('断开失败');
  expect(persist).not.toHaveBeenCalled(); expect(useMa2ModeStore.getState().method).toBe('network');
});
