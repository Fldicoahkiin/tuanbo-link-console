import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { clientAddress } from './client-address';
import { createLicensingServer } from './http';
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

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function start(trusted: boolean) {
  const key = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const service = new LicensingService(':memory:', key, 'test', randomBytes(32));
  const server = createLicensingServer(service, 'x'.repeat(48), undefined, undefined, undefined, trusted);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
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
