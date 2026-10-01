import { createServer } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';
import { expect, it } from 'vitest';
import { directedBroadcast, discoveryTargets, probeMa2, Ma2DiscoveryService } from './ma2-discovery';

it.runIf(Boolean(process.env.TBLINK_MA2_HARDWARE_HOST))('实际局域网广播发现实体控台', async () => {
  const found = await new Ma2DiscoveryService().search([]);
  expect(found.hosts).toContainEqual({ host: process.env.TBLINK_MA2_HARDWARE_HOST, port: 30000, identity: 'ma2' });
}, 60000);

function adapter(address: string, netmask = '255.255.255.0'): NetworkInterfaceInfo {
  return { address, netmask, family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: null };
}
it('广播地址按各网卡掩码计算，覆盖大网段而非全局广播', () => {
  expect(directedBroadcast('2.0.0.3', '255.0.0.0')).toBe('2.255.255.255');
  expect(directedBroadcast('10.39.12.89', '255.255.252.0')).toBe('10.39.15.255');
  expect(directedBroadcast('192.168.1.20', '255.255.255.0')).toBe('192.168.1.255');
});
it('无可用网卡和自动分配地址提供明确诊断，结果列出网卡与掩码', () => {
  expect(discoveryTargets({}, []).warnings.join()).toContain('未检测到');
  const plan = discoveryTargets({ Ethernet: [adapter('169.254.10.2', '255.255.0.0')] }, []);
  expect(plan.warnings.join()).toContain('自动分配地址');
  expect(plan.ranges).toContain('Ethernet：169.254.10.2 / 255.255.0.0');
});
it('横幅分段到达时不把提前收到的提示符误判为未知设备', async () => {
  const server = createServer(socket => {
    socket.write('[Channel]>');
    const timer = setTimeout(() => socket.end("\r\nLogged in as User 'guest'\r\n[Channel]>"), 120);
    socket.on('close', () => clearTimeout(timer));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing server');
    expect(await probeMa2({ host: '127.0.0.1', port: address.port }, new AbortController().signal, 80)).toMatchObject({ identity: 'ma2' });
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
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
