import { expect, it, vi } from 'vitest';
import { assertMa2ConnectionOwner, isLocalMa2Address, waitForMa2Listener } from './ma2-connection-owner';

const peers = [30000, 30001].map((remotePort, index) => ({ localAddress: '127.0.0.1', localPort: 45000 + index, remoteAddress: '127.0.0.1', remotePort }));
const server = peers.map(peer => ({ localAddress: peer.remoteAddress, localPort: peer.remotePort, remoteAddress: peer.localAddress, remotePort: peer.localPort, pid: 42 }));
it('验证真实接受连接的 onPC，不依赖可能被 MA 3D 共享的监听条目', async () => {
  await expect(assertMa2ConnectionOwner(42, peers, () => Promise.resolve(server))).resolves.toBeUndefined();
});
it('监视端口连到 MA 3D 时也拒绝，不能只验证命令端口', async () => {
  await expect(assertMa2ConnectionOwner(42, peers, () => Promise.resolve(server.map((entry, index) => ({ ...entry, pid: index ? 99 : 42 }))))).rejects.toThrow('30001');
});
it('连接已断开或客户端临时端口不匹配时拒绝', async () => {
  await expect(assertMa2ConnectionOwner(42, peers, () => Promise.resolve(server.map(entry => ({ ...entry, remotePort: 1234 }))))).rejects.toThrow('没有连到选定');
});
it('识别本机网卡和 IPv4 映射地址，实体控台不执行本机 PID 校验', () => {
  expect(isLocalMa2Address('10.0.0.2', ['10.0.0.2'])).toBe(true);
  expect(isLocalMa2Address('::ffff:127.0.0.1', [])).toBe(true);
  expect(isLocalMa2Address('10.0.0.3', ['10.0.0.2'])).toBe(false);
});
it('onPC 窗口出现后等该进程开放远程端口再登录，只等待就绪不重复登录', async () => {
  const pause = (): Promise<void> => Promise.resolve();
  await expect(waitForMa2Listener(42, 30000, 30000, () => Promise.resolve([42]), pause)).resolves.toBe('ready');
  const locate = vi.fn<(port: number) => Promise<number[]>>().mockResolvedValueOnce([]).mockResolvedValueOnce([99]).mockResolvedValue([99, 42]);
  await expect(waitForMa2Listener(42, 30000, 30000, locate, pause)).resolves.toBe('waited');
  expect(locate).toHaveBeenCalledTimes(3); expect(locate).toHaveBeenCalledWith(30000);
});
it('只有 MA 3D 在监听或 onPC 始终未开放端口时有界失败，说明未发送登录', async () => {
  await expect(waitForMa2Listener(42, 30000, 0, () => Promise.resolve([99]), () => Promise.resolve()))
    .rejects.toThrow('MA2 onPC（PID 42）0 秒内没有打开远程端口 30000，还没发送登录');
});
