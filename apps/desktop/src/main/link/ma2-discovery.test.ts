import { createServer } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';
import { expect, it } from 'vitest';
import { discoveryTargets, probeMa2, Ma2DiscoveryService } from './ma2-discovery';

it.runIf(Boolean(process.env.TBLINK_MA2_HARDWARE_HOST))('实际局域网广播发现实体控台', async () => {
  const found = await new Ma2DiscoveryService().search([]);
  expect(found.hosts).toContainEqual({ host: process.env.TBLINK_MA2_HARDWARE_HOST, port: 30000, identity: 'ma2' });
}, 60000);

function adapter(address: string, netmask = '255.255.255.0'): NetworkInterfaceInfo {
  return { address, netmask, family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: null };
}
it('搜索多个网卡并去重，大网段明确截取范围，保留范围外已保存控台', () => {
  const plan = discoveryTargets({ a: [adapter('2.0.0.10', '255.0.0.0')], b: [adapter('2.0.0.11')], c: [adapter('192.168.1.2')] }, [
    { host: '2.10.0.7', port: 31000, monitorPort: 31001, username: 'test', autoConnect: false }
  ]);
  expect(plan.addresses).toHaveLength(510);
  expect(plan.addresses).toContainEqual({ host: '2.10.0.7', port: 31000 });
  expect(plan.warnings).toHaveLength(1); expect(plan.ranges).toContain('2.0.0.0/24');
});
it('窄子网不扫描相邻网段，取消的探测不建立连接', async () => {
  const plan = discoveryTargets({ a: [adapter('192.168.2.2', '255.255.255.252')] }, []);
  expect(plan.addresses.every((item) => item.host === '127.0.0.1' || Number(item.host.split('.')[3]) < 4)).toBe(true);
  const controller = new AbortController(); controller.abort();
  expect(await probeMa2({ host: '127.0.0.1', port: 1 }, controller.signal)).toBeNull();
});
it('真实 TCP 探测只读横幅，不发送登录和命令，普通开放端口仅标为候选', async () => {
  for (const banner of ["Logged in as User 'guest'\r\n[Channel]>Please login !\r\n", 'Unrelated service\r\n']) {
    let bytes = 0;
    const server = createServer((socket) => { socket.write(banner); socket.on('data', (data: Buffer) => { bytes += data.length; }); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing server');
      const found = await probeMa2({ host: '127.0.0.1', port: address.port }, new AbortController().signal, 80);
      expect(found?.identity).toBe(banner.includes('Channel') ? 'ma2' : 'candidate'); expect(bytes).toBe(0);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  }
});

it.runIf(process.env.TBLINK_MA2_DISCOVERY_NATIVE === '1')('本机真实 onPC 远程横幅识别（不登录、不发送命令）', async () => {
  const result = await probeMa2({ host: '127.0.0.1', port: 30000 }, new AbortController().signal, 2000);
  expect(result).toEqual({ host: '127.0.0.1', port: 30000, identity: 'ma2' });
});
