import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { LicensingService } from './service';
import { purchaseCatalogSchema } from '../../../packages/schema/src/purchase';
import { AlipayNotifications } from './alipay';
import { createLicensingServer } from './http';

const issuer = generateKeyPairSync('ed25519');
const privateKey = issuer.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const now = Date.parse('2026-09-28T00:00:00Z');
const identity = { appId: '2026000000000001', sellerId: '2088000000000001' };
const input = { offerId: 'month', revision: 'test-1', quotedUnitAmountFen: 100, quantity: 1, customer: '测试', customerType: 'company' };
const catalog = purchaseCatalogSchema.parse({ version: 1, maxOrderAmountFen: 10000, offers: [{ id: 'month', revision: 'test-1', name: '测试', unitAmountFen: 100, kind: 'subscription', useDays: 30, updatesDays: 30, maxQuantity: 1, saleUntil: '2027-01-01T00:00:00Z' }] });
const services = new Set<LicensingService>();
afterEach(() => { for (const service of services) service.close(); services.clear(); });
const token = () => `TBD-${randomBytes(32).toString('hex').toUpperCase()}`;
function setup(path = ':memory:', key = randomBytes(32)) {
  const service = new LicensingService(path, privateKey, 'test', key, () => now); services.add(service); return service;
}
function renewal(service: LicensingService) {
  const first = service.createPurchase(input, token(), catalog, identity);
  const license = service.fulfill(first.id, { amountFen: 100, paymentReference: 'alipay:first' }, 'alipay', identity).licenses[0]!;
  const auth = { product: 'tuanbo-link-console', code: license.code, machineCode: `TB1-${'A'.repeat(64)}` };
  service.activate(auth);
  const credential = token(); const request = { ...input, renewalLicenseId: license.id };
  const order = service.createPurchase(request, credential, catalog, identity, auth);
  service.revoke(license.id, { reason: '已建单后撤销' });
  return { first, license, order, credential, request };
}

it('已核款但续费交付失败保留收款事实，重启后不再提供付款链接', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'tblink-receipts-')), 'license.db'); const key = randomBytes(32);
  const service = setup(path, key); const { order, credential, request } = renewal(service);
  const payment = { amountFen: 100, paymentReference: 'alipay:received' };
  expect(() => service.fulfill(order.id, payment, 'alipay', identity)).toThrow('已撤销');
  expect(service.readDelivery(order.id, credential)).toMatchObject({ state: 'pending', paymentConfirmed: true, licenses: [] });
  expect(service.createPurchase(request, credential, catalog, identity)).toMatchObject({ payable: false });
  expect(() => service.prepareAlipayPayment(order.id, identity.appId, identity.sellerId)).toThrow('付款已确认');
  service.close(); services.delete(service);
  const restarted = setup(path, key);
  expect(restarted.readDelivery(order.id, credential)).toMatchObject({ state: 'pending', paymentConfirmed: true });
  expect(restarted.paymentExceptions(0).items).toMatchObject([{ orderId: order.id, amountFen: 100, source: 'alipay', lastError: 'RENEWAL_REVOKED' }]);
  expect(() => restarted.fulfill(order.id, { ...payment, paymentReference: 'alipay:different' }, 'alipay', identity)).toThrow('流水');
  expect(() => restarted.retryDelivery(order.id, { reason: '不能越过撤销规则' })).toThrow('已撤销');
});

it('发码事务异常和进程重启不丢收款，运营按原流水补发一次并清除异常', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'tblink-receipts-')), 'license.db'); const key = randomBytes(32);
  const service = setup(path, key); const credential = token(); const order = service.createPurchase(input, credential, catalog, identity);
  const database = new DatabaseSync(path);
  try {
    database.exec("CREATE TRIGGER fail_delivery BEFORE INSERT ON licenses BEGIN SELECT RAISE(ABORT, 'test delivery unavailable'); END;");
    expect(() => service.fulfill(order.id, { amountFen: 100, paymentReference: 'alipay:recoverable' }, 'alipay', identity)).toThrow('test delivery unavailable');
    expect(service.paymentExceptions(0).items).toMatchObject([{ orderId: order.id, lastError: 'INTERNAL_ERROR' }]);
    expect(service.readDelivery(order.id, credential)).toMatchObject({ state: 'pending', paymentConfirmed: true, licenses: [] });
    const other = service.createPurchase(input, token(), catalog, identity);
    expect(() => service.fulfill(other.id, { amountFen: 100, paymentReference: 'alipay:recoverable' }, 'alipay', identity)).toThrow('流水');
    expect(service.paymentExceptions(0).items).toHaveLength(1);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const server = createLicensingServer(service, 'a'.repeat(48));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('未监听');
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/orders/${order.id}/reconcile`, {
        method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000)
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ state: 'pending', paymentConfirmed: true, licenses: [] });
      expect(log).toHaveBeenCalledWith(expect.stringContaining('LICENSING_DELIVERY_PENDING'));
      expect(JSON.stringify(log.mock.calls)).not.toContain(credential);
    } finally {
      log.mockRestore();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    database.exec('DROP TRIGGER fail_delivery');
  } finally { database.close(); }
  service.close(); services.delete(service);
  const restarted = setup(path, key);
  const delivered = restarted.retryDelivery(order.id, { reason: '故障恢复后补发' });
  expect(delivered.state).toBe('fulfilled'); expect(delivered.licenses).toHaveLength(1);
  expect(restarted.retryDelivery(order.id, { reason: '重复请求同单' }).licenses).toEqual(delivered.licenses);
  expect(restarted.paymentExceptions(0)).toEqual({ items: [], nextCursor: null });
  expect(restarted.readDelivery(order.id, credential)).not.toHaveProperty('paymentConfirmed');
});

it('金额和商户不符不能写入收款事实，也不能无收款直接补发', () => {
  const service = setup(); const credential = token(); const order = service.createPurchase(input, credential, catalog, identity);
  expect(() => service.fulfill(order.id, { amountFen: 1, paymentReference: 'alipay:wrong' }, 'alipay', identity)).toThrow('金额');
  expect(() => service.fulfill(order.id, { amountFen: 100, paymentReference: 'alipay:wrong' }, 'alipay', { ...identity, sellerId: '2088000000000002' })).toThrow('商户');
  expect(() => service.retryDelivery(order.id, { reason: '不能凭空交付' })).toThrow('尚无已确认');
  expect(service.readDelivery(order.id, credential)).not.toHaveProperty('paymentConfirmed');
  expect(service.paymentExceptions(0)).toEqual({ items: [], nextCursor: null });
});

it('HTTP 通知交付失败仍持久化收款，客户不再请求付款，异常清单和补发仅限运营', async () => {
  const service = setup(); const { order, credential } = renewal(service);
  const provider = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const notifications = new AlipayNotifications(identity.appId, identity.sellerId, provider.publicKey.export({ type: 'spki', format: 'pem' }).toString());
  const admin = 'a'.repeat(48); const server = createLicensingServer(service, admin, notifications);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('未监听');
    const base = `http://127.0.0.1:${address.port}`;
    const request = (path: string, token: string, body?: unknown) => fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    const fields: Record<string, string> = { app_id: identity.appId, seller_id: identity.sellerId, out_trade_no: `TB_${order.id.replaceAll('-', '')}`,
      trade_no: '202609282200000000003333', charset: 'utf-8', notify_type: 'trade_status_sync', trade_status: 'TRADE_SUCCESS', total_amount: '1.00' };
    const content = Object.keys(fields).sort().map(key => `${key}=${fields[key]}`).join('&');
    const signed = sign('RSA-SHA256', Buffer.from(content), provider.privateKey).toString('base64');
    const notify = (signature: string) => fetch(base + '/v1/payments/alipay/notify', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...fields, sign_type: 'RSA2', sign: signature }), signal: AbortSignal.timeout(5000) });
    expect((await notify('A'.repeat(signed.length - 2) + '==')).status).toBe(401);
    expect(service.paymentExceptions(0).items).toHaveLength(0);
    expect((await notify(signed)).status).toBe(409);
    expect((await request('/admin/payment-exceptions', credential)).status).toBe(401);
    expect((await request('/v1/payment-exceptions', credential)).status).toBe(404);
    expect(await (await request('/admin/payment-exceptions?after=0', admin)).json()).toMatchObject({ items: [{ orderId: order.id, lastError: 'RENEWAL_REVOKED' }] });
    const customer = await request(`/v1/orders/${order.id}/reconcile`, credential, {});
    expect(customer.status).toBe(200);
    expect(await customer.json()).toMatchObject({ state: 'pending', paymentConfirmed: true, licenses: [] });
    expect((await request(`/admin/orders/${order.id}/retry-delivery`, credential, { reason: '伪造运营' })).status).toBe(401);
    expect((await request(`/admin/orders/${order.id}/retry-delivery`, admin, { reason: '原授权已撤销不能强制发码' })).status).toBe(409);
    expect(service.paymentExceptions(0).items).toHaveLength(1);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
