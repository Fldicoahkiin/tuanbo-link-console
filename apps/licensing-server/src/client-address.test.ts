import { listenHttpTestServer } from './http-test-server';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { clientAddress, rateBucket } from './client-address';
import { createLicensingServer } from './http';
import { SourceRates } from './source-rates';
import { LicensingService } from './service';

it('默认不信任转发头，非回环请求不能指定限流来源', () => {
  expect(clientAddress('127.0.0.1', '198.51.100.1', false)).toBe('127.0.0.1');
  expect(clientAddress('192.0.2.10', '198.51.100.1', true)).toBe('192.0.2.10');
  expect(clientAddress('127.0.0.1', undefined, true)).toBe('127.0.0.1');
  expect(clientAddress('::ffff:127.0.0.1', '198.51.100.1', true)).toBe('198.51.100.1');
});
it('拒绝代理地址列表、重复值、端口与作用域，统一等价 IPv6 和 IPv4 映射形式', () => {
  for (const value of ['198.51.100.1, 192.0.2.1', '', '198.51.100.1:80', 'fe80::1%eth0', ['198.51.100.1', '192.0.2.1']]) {
    expect(() => clientAddress('::1', value, true)).toThrow('代理来源地址无效');
  }
  expect(clientAddress('::1', '2001:0DB8:0:0:0:0:0:1', true)).toBe('2001:db8::1');
  expect(clientAddress('::1', '::ffff:192.0.2.1', true)).toBe('192.0.2.1');
  expect(clientAddress('::1', '::ffff:c000:0201', true)).toBe('192.0.2.1');
});
it('IPv6 按 /64 合并计数，IPv4 与带作用域地址保持原样', () => {
  expect(rateBucket('2001:db8::1')).toBe('2001:db8:0:0::/64');
  expect(rateBucket(clientAddress('::1', '2001:0db8:0000:0000:ffff:0:0:1', true))).toBe('2001:db8:0:0::/64');
  expect(rateBucket('2001:db8:0:1::1')).toBe('2001:db8:0:1::/64');
  expect(rateBucket('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
  expect(rateBucket('::1')).toBe('0:0:0:0::/64');
  expect(rateBucket('192.0.2.1')).toBe('192.0.2.1');
  expect(rateBucket('fe80::1%eth0')).toBe('fe80::1%eth0');
});

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function start(trusted: boolean) {
  const key = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const service = new LicensingService(':memory:', key, 'test', randomBytes(32));
  const server = createLicensingServer(service, 'x'.repeat(48), undefined, undefined, undefined, trusted);
  await listenHttpTestServer(server);
  cleanup.push(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); service.close(); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('未监听');
  const base = `http://127.0.0.1:${address.port}`;
  return (ip: string, path = '/v1/orders', header = 'X-Tblink-Client-IP') => fetch(`${base}${path}`, {
    method: path === '/v1/orders' ? 'POST' : 'GET', headers: { [header]: ip, 'Content-Type': 'application/json' },
    ...(path === '/v1/orders' ? { body: '{}' } : {}), signal: AbortSignal.timeout(5000)
  });
}
it('HTTP 按可信代理中的客户独立计数，下单限流不阻断目录和领取', async () => {
  const request = await start(true);
  for (let index = 0; index < 10; index += 1) expect((await request('192.0.2.1')).status).toBe(400);
  expect((await request('192.0.2.1')).status).toBe(429);
  expect((await request('192.0.2.2')).status).toBe(400);
  expect((await request('192.0.2.1', '/v1/catalog')).status).toBe(200);
  expect((await request('192.0.2.1', '/v1/orders/11111111-1111-4111-8111-111111111111')).status).toBe(401);
});
it('未启用代理时伪造来源头不能绕过下单限流，X-Forwarded-For 永不作为来源', async () => {
  const request = await start(false);
  for (let index = 0; index < 10; index += 1) expect((await request(`192.0.2.${index + 1}`)).status).toBe(400);
  expect((await request('198.51.100.1')).status).toBe(429);
  const trusted = await start(true);
  for (let index = 0; index < 10; index += 1) expect((await trusted(`192.0.2.${index + 1}`, '/v1/orders', 'X-Forwarded-For')).status).toBe(400);
  expect((await trusted('198.51.100.1', '/v1/orders', 'X-Forwarded-For')).status).toBe(429);
});
it('同一 IPv6 /64 共用下单额度，相邻 /64 独立', async () => {
  const request = await start(true);
  for (let index = 1; index <= 10; index += 1) expect((await request(`2001:db8::${index}`)).status).toBe(400);
  expect((await request('2001:db8::ffff')).status).toBe(429);
  expect((await request('2001:db8:0:1::1')).status).toBe(400);
});
it('支付通知路由不计入来源限流', async () => {
  const request = await start(true);
  for (let index = 0; index < 130; index += 1) {
    const response = await request('198.51.100.8', '/v1/payments/alipay/notify');
    expect(response.status).toBe(404); await response.arrayBuffer();
  }
  expect((await request('198.51.100.8', '/health')).status).toBe(200);
});
it('计数表满时淘汰最久未用来源而非拒绝新地址，窗口到期后重新计数', () => {
  const rates = new SourceRates(3); const now = Date.parse('2026-10-14T00:00:00Z');
  for (let index = 0; index < 2; index += 1) expect(rates.exceeded('a', 2, now)).toBe(false);
  expect(rates.exceeded('a', 2, now)).toBe(true);
  expect(rates.exceeded('b', 2, now)).toBe(false); expect(rates.exceeded('c', 2, now)).toBe(false);
  expect(rates.exceeded('a', 2, now)).toBe(true);
  // a 最近使用，b 最久未用：新来源 d 进入时淘汰 b，a 的计数保留。
  expect(rates.exceeded('d', 2, now)).toBe(false);
  expect(rates.exceeded('a', 2, now)).toBe(true);
  for (let index = 0; index < 2; index += 1) expect(rates.exceeded('b', 2, now)).toBe(false);
  expect(rates.exceeded('a', 2, now + 60000)).toBe(false);
});
