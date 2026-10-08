import { listenHttpTestServer } from './http-test-server';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { LicensingService } from './service';
import { AlipayNotifications } from './alipay';
import { createLicensingServer } from './http';

const issuer = generateKeyPairSync('ed25519');
const privateKey = issuer.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const services = new Set<LicensingService>();
afterEach(() => { for (const service of services) service.close(); services.clear(); });
const details = { reference: 'delivery-1', customer: '不能公开的客户名称', customerType: 'company', quantity: 2, kind: 'perpetual', amountFen: 12345, useUntil: null, updatesUntil: '2027-09-28T00:00:00Z' };
const reason = { reason: '向已核实购买人交付' };
function setup(path = ':memory:', key = randomBytes(32)) {
  let time = Date.parse('2026-09-28T00:00:00Z');
  const service = new LicensingService(path, privateKey, 'test', key, () => time);
  services.add(service);
  return { service, advance: (ms: number) => { time += ms; } };
}

it('未付款只能查询待支付状态，付款后重复领取原码，公开响应仅包含交付必需字段', () => {
  const { service } = setup(); const order = service.createOrder(details);
  const access = service.issueDeliveryAccess(order.id, reason);
  expect(access.token).toMatch(/^TBD-[A-F0-9]{64}$/);
  expect(service.readDelivery(order.id, access.token)).toMatchObject({ state: 'pending', licenses: [] });
  const paid = service.fulfill(order.id, { paymentReference: 'bank-1', amountFen: details.amountFen });
  const delivery = service.readDelivery(order.id, access.token);
  expect(delivery.licenses.map(item => item.code)).toEqual(paid.licenses.map(item => item.code));
  expect(service.readDelivery(order.id, access.token)).toEqual(delivery);
  expect(delivery).not.toHaveProperty('customer');
  expect(delivery).not.toHaveProperty('reference');
  expect(delivery.licenses[0]).not.toHaveProperty('machineCode');
  expect(delivery).not.toHaveProperty('payment_reference');
});

it('拒绝订单号裸查、跨订单凭据、未知订单、过期及已轮换凭据', () => {
  const { service, advance } = setup(); const first = service.createOrder(details);
  const second = service.createOrder({ ...details, reference: 'delivery-2' });
  const a = service.issueDeliveryAccess(first.id, reason);
  const b = service.issueDeliveryAccess(second.id, reason);
  for (const [id, token] of [[first.id, ''], [first.id, b.token], [second.id, a.token], ['11111111-1111-4111-8111-111111111111', a.token]]) {
    expect(() => service.readDelivery(id!, token!)).toThrow('领取凭据无效或过期');
  }
  const replacement = service.issueDeliveryAccess(first.id, reason);
  expect(replacement.token).not.toBe(a.token);
  expect(() => service.readDelivery(first.id, a.token)).toThrow('领取凭据');
  expect(service.readDelivery(first.id, replacement.token).state).toBe('pending');
  advance(7 * 86400000);
  expect(() => service.readDelivery(first.id, replacement.token)).toThrow('领取凭据');
});

it('撤销领取权限不删授权；单码撤销不再返回该码，换机使旧领取凭据失效', () => {
  const { service } = setup(); const order = service.createOrder(details);
  const paid = service.fulfill(order.id, { paymentReference: 'bank-1', amountFen: details.amountFen });
  const access = service.issueDeliveryAccess(order.id, reason);
  service.revokeDeliveryAccess(order.id, reason);
  expect(() => service.readDelivery(order.id, access.token)).toThrow('领取凭据');
  expect(service.describeOrder(order.id).licenses).toEqual(paid.licenses);
  const next = service.issueDeliveryAccess(order.id, reason);
  service.revoke(paid.licenses[0]!.id, { reason: '换机' });
  expect(service.readDelivery(order.id, next.token).licenses[0]).toMatchObject({ code: null, revoked: true });
  expect(service.readDelivery(order.id, next.token).licenses[1]?.code).toBe(paid.licenses[1]?.code);
  service.migrate(paid.licenses[0]!.id, { reason: '核实购买人后换机' });
  expect(() => service.readDelivery(order.id, next.token)).toThrow('领取凭据');
});

it('旧数据库可新增领取表，凭据不以明文落库，重启后仍可查询且不新增激活码', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'tblink-delivery-')), 'license.db');
  const old = new DatabaseSync(path);
  old.exec('CREATE TABLE orders (id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE, body TEXT NOT NULL, state TEXT NOT NULL, payment_reference TEXT UNIQUE)');
  old.close();
  const key = randomBytes(32); const { service } = setup(path, key);
  const order = service.createOrder(details); const access = service.issueDeliveryAccess(order.id, reason);
  service.fulfill(order.id, { paymentReference: 'bank-1', amountFen: details.amountFen });
  const before = service.readDelivery(order.id, access.token);
  const bytes = Buffer.concat([await readFile(path), await readFile(`${path}-wal`)]);
  expect(bytes.includes(Buffer.from(access.token))).toBe(false);
  service.close(); services.delete(service);
  const restarted = setup(path, key).service;
  expect(restarted.readDelivery(order.id, access.token)).toEqual(before);
});

it('HTTP 从支付宝通知到客户领取，客户凭据不能变成管理员身份或 URL 查询参数', async () => {
  const { service } = setup(); const order = service.createOrder(details); const admin = 'a'.repeat(48);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const appId = '2026000000000001'; const sellerId = '2088000000000001';
  const alipay = new AlipayNotifications(appId, sellerId, rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString());
  const server = createLicensingServer(service, admin, alipay);
  await listenHttpTestServer(server);
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('缺少测试地址');
    const base = `http://127.0.0.1:${address.port}`;
    const post = (path: string, token: string) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(reason), signal: AbortSignal.timeout(5000) });
    expect((await post(`/admin/orders/${order.id}/delivery-access`, '')).status).toBe(401);
    const issued = await post(`/admin/orders/${order.id}/delivery-access`, admin);
    const access = z.object({ token: z.string(), expiresAt: z.string().datetime() }).parse(await issued.json());
    expect(issued.status).toBe(200);
    const get = (token: string, suffix = '') => fetch(`${base}/v1/orders/${order.id}${suffix}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    expect((await get('')).status).toBe(401);
    expect((await get(admin)).status).toBe(401);
    expect((await get('', `?token=${access.token}`)).status).toBe(404);
    expect((await post(`/admin/orders/${order.id}/fulfill`, access.token)).status).toBe(401);
    const fields: Record<string, string> = { app_id: appId, seller_id: sellerId, out_trade_no: order.id, trade_no: '202609282200000000000001', charset: 'utf-8', notify_type: 'trade_status_sync', trade_status: 'TRADE_SUCCESS', total_amount: '123.45' };
    const canonical = Object.keys(fields).sort().map(key => `${key}=${fields[key]}`).join('&');
    const payment = await fetch(`${base}/v1/payments/alipay/notify`, { method: 'POST', body: new URLSearchParams({ ...fields, sign_type: 'RSA2', sign: sign('RSA-SHA256', Buffer.from(canonical), rsa.privateKey).toString('base64') }), signal: AbortSignal.timeout(5000) });
    expect(await payment.text()).toBe('success');
    const delivered = await get(access.token);
    expect(delivered.headers.get('cache-control')).toBe('no-store');
    expect(delivered.headers.get('referrer-policy')).toBe('no-referrer');
    const body: unknown = await delivered.json();
    const result = z.object({ state: z.literal('fulfilled'), licenses: z.array(z.object({ code: z.string().regex(/^TBA-[A-F0-9]{32}$/) })) }).parse(body);
    expect(result.licenses).toHaveLength(2);
    expect(body).not.toHaveProperty('customer');
    expect((await post(`/admin/orders/${order.id}/delivery-access/revoke`, admin)).status).toBe(200);
    expect((await get(access.token)).status).toBe(401);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
