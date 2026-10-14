import { listenHttpTestServer } from './http-test-server';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { AlipayCheckout, AlipayNotifications } from './alipay';
import { purchaseCatalogSchema, purchaseRequestSchema } from '../../../packages/schema/src/purchase';
import { createLicensingServer } from './http';
import { LicensingService } from './service';

const issuer = generateKeyPairSync('ed25519');
const provider = generateKeyPairSync('rsa', { modulusLength: 2048 });
const appId = '2026000000000001'; const sellerId = '2088000000000001';
const identity = { appId, sellerId };
const initial = Date.parse('2026-09-28T00:00:00Z');
const privateKey = issuer.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const catalog = purchaseCatalogSchema.parse({ version: 1, maxOrderAmountFen: 50000, offers: [{
  id: 'test-month', revision: 'test-1', name: '仅用于测试的套餐', unitAmountFen: 12345,
  kind: 'subscription', useDays: 30, updatesDays: 30, maxQuantity: 10, saleUntil: '2026-12-31T00:00:00Z'
}] });
const input = { offerId: 'test-month', revision: 'test-1', quotedUnitAmountFen: 12345, quantity: 2, customer: '测试用户', customerType: 'personal' };
const token = (): string => `TBD-${randomBytes(32).toString('hex').toUpperCase()}`;
const services: LicensingService[] = [];
afterEach(() => { for (const service of services.splice(0)) service.close(); });
function setup(path = ':memory:', now = () => initial, key = randomBytes(32)) {
  const service = new LicensingService(path, privateKey, 'test', key, now); services.push(service);
  return service;
}
function callback(id: string, amount = '246.90') {
  const fields: Record<string, string> = { app_id: appId, seller_id: sellerId, out_trade_no: `TB_${id.replaceAll('-', '')}`,
    trade_no: '202609282200000000000123', charset: 'utf-8', notify_type: 'trade_status_sync', trade_status: 'TRADE_SUCCESS', total_amount: amount };
  const content = Object.keys(fields).sort().map(key => `${key}=${fields[key]}`).join('&');
  return new URLSearchParams({ ...fields, sign_type: 'RSA2', sign: sign('RSA-SHA256', Buffer.from(content), provider.privateKey).toString('base64') });
}

it('服务端计价、单笔限额折算机器数，重复同凭据返回原订单且不延长期限', () => {
  let now = initial; const service = setup(':memory:', () => now); const credential = token();
  expect(service.listOffers(catalog)[0]?.maxQuantity).toBe(4);
  const first = service.createPurchase(input, credential, catalog, identity);
  expect(first.amountFen).toBe(24690); expect(first.quantity).toBe(2);
  expect(first.state).toBe('pending'); expect(first.payable).toBe(true);
  expect(service.readDelivery(first.id, credential).licenses).toEqual([]);
  now += 5 * 60000;
  expect(service.createPurchase(input, credential, catalog, identity)).toEqual(first);
  expect(() => service.createPurchase({ ...input, quantity: 3 }, credential, catalog, identity)).toThrow('其他商品或数量');
});

it('拒绝客户端覆盖金额、使用期限、渠道身份和幂等编号；拒绝旧报价与超限', () => {
  const service = setup();
  for (const addition of [{ amountFen: 1 }, { useUntil: '2099-01-01T00:00:00Z' }, { appId }, { reference: 'chosen' }, { paid: true }]) {
    expect(() => service.createPurchase({ ...input, ...addition }, token(), catalog, identity)).toThrow();
  }
  expect(() => service.createPurchase({ ...input, quotedUnitAmountFen: 1 }, token(), catalog, identity)).toThrow('商品已更新');
  expect(() => service.createPurchase({ ...input, revision: 'old' }, token(), catalog, identity)).toThrow('商品已更新');
  expect(() => service.createPurchase({ ...input, quantity: 5 }, token(), catalog, identity)).toThrow('数量超过');
  expect(() => service.createPurchase(input, 'admin-token', catalog, identity)).toThrow('领取凭据');
});

it('报价变化、停售或支付配置关闭后仍能恢复原订单，但不能创建新的购买', () => {
  const service = setup(); const credential = token();
  const first = service.createPurchase(input, credential, catalog, identity);
  const changed = purchaseCatalogSchema.parse({ ...catalog, offers: [{ ...catalog.offers[0], unitAmountFen: 20000, revision: 'test-2' }] });
  expect(service.createPurchase(input, credential, changed, identity)).toEqual(first);
  expect(service.createPurchase(input, credential, undefined).id).toBe(first.id);
  expect(service.createPurchase(input, credential, undefined).payable).toBe(false);
  expect(service.createPurchase(input, credential, catalog, { ...identity, appId: '2026000000000002' }).payable).toBe(false);
  expect(() => service.createPurchase(input, token(), undefined, identity)).toThrow('购买尚未开放');
  expect(() => service.createPurchase(input, token(), catalog)).toThrow('购买尚未开放');
  expect(() => service.createPurchase(input, token(), changed, identity)).toThrow('商品已更新');
});

it('重启后恢复同一订单，凭据不明文落库；撤销凭据不能通过重试恢复权限', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'tblink-purchase-')), 'license.db');
  const key = randomBytes(32); const first = setup(path, () => initial, key); const credential = token();
  const order = first.createPurchase(input, credential, catalog, identity);
  first.close(); services.splice(services.indexOf(first), 1);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    for (const table of ['orders', 'purchase_requests', 'order_delivery_access', 'audit']) {
      expect(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())).not.toContain(credential);
    }
  } finally { db.close(); }
  const reopened = setup(path, () => initial + 60000, key);
  expect(reopened.createPurchase(input, credential, catalog, identity)).toEqual(order);
  reopened.revokeDeliveryAccess(order.id, { reason: '凭据遗失' });
  expect(() => reopened.createPurchase(input, credential, catalog, identity)).toThrow('领取凭据无效');
});

it('失败请求不留下订单或领取授权，报价变更后使用原凭据仍可首次提交', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'tblink-purchase-reject-')), 'license.db');
  const service = setup(path); const credential = token();
  expect(() => service.createPurchase({ ...input, quantity: 100 }, credential, catalog, identity)).toThrow('数量超过');
  const db = new DatabaseSync(path, { readOnly: true });
  try { expect(db.prepare('SELECT count(*) AS count FROM orders').get()?.count).toBe(0); }
  finally { db.close(); }
  expect(service.createPurchase(input, credential, catalog, identity).state).toBe('pending');
});

it('支付入口过期可恢复待核对订单，不再生成可付款标记；领取权限七天后失效', () => {
  let now = initial; const service = setup(':memory:', () => now); const credential = token();
  const first = service.createPurchase(input, credential, catalog, identity);
  now += 15 * 60000;
  const expired = service.createPurchase(input, credential, catalog, identity);
  expect(expired.id).toBe(first.id); expect(expired.payable).toBe(false); expect(expired.state).toBe('pending');
  now = initial + 7 * 86400000;
  expect(() => service.createPurchase(input, credential, catalog, identity)).toThrow('领取凭据无效');
});

it('首次核款发码时起算完整授权天数，重复到账、停售与改价不改变原授权', () => {
  let now = initial; const service = setup(':memory:', () => now); const credential = token();
  const order = service.createPurchase(input, credential, catalog, identity);
  now += 2 * 86400000;
  const payment = { paymentReference: 'alipay:202609282200000000000123', amountFen: 24690 };
  const paid = service.fulfill(order.id, payment, 'alipay', identity);
  expect(paid.useUntil).toBe(new Date(now + 30 * 86400000).toISOString());
  expect(paid.updatesUntil).toBe(paid.useUntil);
  now += 86400000;
  expect(service.fulfill(order.id, payment, 'alipay', identity)).toEqual(paid);
  const recovery = service.createPurchase(input, credential, undefined);
  expect(recovery.state).toBe('fulfilled'); expect(recovery.payable).toBe(false);
  expect(service.readDelivery(order.id, credential).licenses.map(item => item.code)).toEqual(paid.licenses.map(item => item.code));
  expect(() => service.readDelivery(order.id, token())).toThrow('领取凭据无效');
});

it('目录拒绝重复 SKU 和不完整期限，接近停售时不再创建新订单', () => {
  expect(() => purchaseCatalogSchema.parse({ ...catalog, offers: [catalog.offers[0], catalog.offers[0]] })).toThrow();
  expect(() => purchaseCatalogSchema.parse({ ...catalog, offers: [{ ...catalog.offers[0], kind: 'perpetual' }] })).toThrow();
  const closing = setup(':memory:', () => Date.parse(catalog.offers[0]!.saleUntil) - 59999);
  expect(closing.listOffers(catalog)).toEqual([]);
  expect(() => closing.createPurchase(input, token(), catalog, identity)).toThrow('商品已更新');
});

it('HTTP 贯通无账号商品查询、重复下单、验签通知和凭据领码，关闭销售仍可恢复', async () => {
  const service = setup(); const credential = token();
  const notifications = new AlipayNotifications(appId, sellerId, provider.publicKey.export({ type: 'spki', format: 'pem' }).toString());
  const checkout = new AlipayCheckout(appId, sellerId, provider.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'production', 'https://api.tuanbo-link.jinhefilm.com', () => initial);
  const server = createLicensingServer(service, 'a'.repeat(48), notifications, checkout, catalog);
  await listenHttpTestServer(server);
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('缺少监听地址');
    const base = `http://127.0.0.1:${address.port}`;
    const post = (body = input) => fetch(`${base}/v1/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    const available = await fetch(`${base}/v1/catalog`, { signal: AbortSignal.timeout(5000) });
    expect(await available.json()).toMatchObject({ available: true, termStart: 'fulfillment', currency: 'CNY' });
    const created = await Promise.all([post(), post()]);
    const schema = z.object({ id: z.string().uuid(), paymentUrl: z.string().url(), state: z.literal('pending'), amountFen: z.number() });
    const first = schema.parse(await created[0].json());
    expect(schema.parse(await created[1].json())).toEqual(first);
    expect(first.amountFen).toBe(24690);
    const signedPayment = new URL(first.paymentUrl);
    expect(signedPayment.origin).toBe('https://openapi.alipay.com');
    expect(JSON.parse(signedPayment.searchParams.get('biz_content')!)).toMatchObject({ total_amount: '246.90', out_trade_no: `TB_${first.id.replaceAll('-', '')}` });
    expect(first.paymentUrl).not.toContain(credential); expect(first.paymentUrl).not.toContain(encodeURIComponent(input.customer));
    const paid = await fetch(`${base}/v1/payments/alipay/notify`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: callback(first.id), signal: AbortSignal.timeout(5000) });
    expect(await paid.text()).toBe('success');
    const delivery = await fetch(`${base}/v1/orders/${first.id}`, { headers: { Authorization: `Bearer ${credential}` }, signal: AbortSignal.timeout(5000) });
    const body = z.object({ state: z.literal('fulfilled'), licenses: z.array(z.object({ code: z.string() })) }).parse(await delivery.json());
    expect(body.licenses).toHaveLength(2);
    expect(await (await post()).json()).toMatchObject({ id: first.id, state: 'fulfilled', paymentUrl: null, payable: false });
    expect(delivery.headers.get('cache-control')).toBe('no-store');
    expect(delivery.headers.get('access-control-allow-origin')).toBeNull();
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

it('默认目录关闭且不创建订单，不从环境或请求回退到测试价格', async () => {
  const service = setup(); const server = createLicensingServer(service, 'a'.repeat(48));
  await listenHttpTestServer(server);
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('缺少监听地址');
    const base = `http://127.0.0.1:${address.port}`;
    expect(await (await fetch(`${base}/v1/catalog`, { signal: AbortSignal.timeout(5000) })).json()).toEqual({ available: false, currency: 'CNY', termStart: 'fulfillment', offers: [] });
    const result = await fetch(`${base}/v1/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` }, body: JSON.stringify(purchaseRequestSchema.parse(input)), signal: AbortSignal.timeout(5000) });
    expect(result.status).toBe(503);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
