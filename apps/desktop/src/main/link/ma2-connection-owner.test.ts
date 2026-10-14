import { expect, it } from 'vitest';
import { assertMa2ConnectionOwner, isLocalMa2Address } from './ma2-connection-owner';

const peers = [30000, 30001].map((remotePort, index) => ({ localAddress: '127.0.0.1', localPort: 45000 + index, remoteAddress: '127.0.0.1', remotePort }));
const server = peers.map(peer => ({ localAddress: peer.remoteAddress, localPort: peer.remotePort, remoteAddress: peer.localAddress, remotePort: peer.localPort, pid: 42 }));
it('验证真实接受连接的 onPC，不依赖可能被 MA 3D 共享的监听条目', async () => {
  await expect(assertMa2ConnectionOwner(42, peers, () => Promise.resolve(server))).resolves.toBeUndefined();
});
it('监视端口连到 MA 3D 时也拒绝，不能只验证命令端口', async () => {
  await expect(assertMa2ConnectionOwner(42, peers, () => Promise.resolve(server.map((entry, index) => ({ ...entry, pid: index ? 99 : 42 }))))).rejects.toThrow('30001');
});
it('连接已断开或客户端临时端口不匹配时拒绝', async () => {
  await expect(assertMa2ConnectionOwner(42, peers, () => Promise.resolve(server.map(entry => ({ ...entry, remotePort: 1234 }))))).rejects.toThrow('未连接到选定');
});
it('识别本机网卡和 IPv4 映射地址，实体控台不执行本机 PID 校验', () => {
  expect(isLocalMa2Address('10.0.0.2', ['10.0.0.2'])).toBe(true);
  expect(isLocalMa2Address('::ffff:127.0.0.1', [])).toBe(true);
  expect(isLocalMa2Address('10.0.0.3', ['10.0.0.2'])).toBe(false);
});
