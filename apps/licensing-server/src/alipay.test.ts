import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { AlipayNotifications } from './alipay';
import { createLicensingServer } from './http';
import { LicensingService } from './service';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const issuer = generateKeyPairSync('ed25519');
const appId = '2026000000000001';
const sellerId = '2088000000000001';
const notifications = new AlipayNotifications(appId, sellerId, rsa.publicKey.export({ format: 'pem', type: 'spki' }).toString());
const services: LicensingService[] = [];
afterEach(() => { for (const service of services.splice(0)) service.close(); });
function setup() {
  const service = new LicensingService(':memory:', issuer.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'test', randomBytes(32), () => Date.parse('2026-09-28T00:00:00Z'));
  services.push(service);
  const details = { reference: 'alipay-test', customer: '测试客户', customerType: 'company', quantity: 2, kind: 'perpetual', amountFen: 12345, useUntil: null, updatesUntil: '2027-09-28T00:00:00Z' };
  return { service, details, order: service.createOrder(details) };
}
function notification(orderId: string, changes: Record<string, string> = {}): URLSearchParams {
  const fields: Record<string, string> = { app_id: appId, seller_id: sellerId, out_trade_no: orderId, trade_no: '202609282200000000000001', charset: 'utf-8', notify_type: 'trade_status_sync', trade_status: 'TRADE_SUCCESS', total_amount: '123.45', subject: '团播 + 100% & 联动', ...changes };
  const canonical = Object.keys(fields).sort().map(key => `${key}=${fields[key]}`).join('&');
  return new URLSearchParams({ ...fields, sign_type: 'RSA2', sign: sign('RSA-SHA256', Buffer.from(canonical), rsa.privateKey).toString('base64') });
}
const verify = (form: URLSearchParams) => notifications.verify(Buffer.from(form.toString()));

it('RSA2 通知验签保留中文、百分号、加号和新增字段，不二次解码', () => {
  const { order } = setup();
  expect(verify(notification(order.id))).toEqual({ orderId: order.id, amountFen: 12345, paymentReference: 'alipay:202609282200000000000001' });
  for (const amount of ['123', '123.4', '123.45']) expect(verify(notification(order.id, { total_amount: amount })).amountFen).toBe(Math.round(Number(amount) * 100));
});

it('拒绝篡改、重复字段、算法降级以及用商户自己的公钥验支付宝通知', () => {
  const { order } = setup();
  const changed = notification(order.id); changed.set('total_amount', '1.00');
  expect(() => verify(changed)).toThrow('验签');
  const duplicate = notification(order.id); duplicate.append('seller_id', sellerId);
  expect(() => verify(duplicate)).toThrow('重复');
  const algorithm = notification(order.id); algorithm.set('sign_type', 'RSA');
  expect(() => verify(algorithm)).toThrow();
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  expect(() => new AlipayNotifications(appId, sellerId, other.publicKey.export({ type: 'spki', format: 'pem' }).toString()).verify(Buffer.from(notification(order.id).toString()))).toThrow('验签');
});

it.each([
  { app_id: '2026000000000002' }, { seller_id: '2088000000000002' },
  { trade_status: 'WAIT_BUYER_PAY' }, { trade_status: 'TRADE_CLOSED' },
  { total_amount: '1e2' }, { total_amount: '123.456' }, { total_amount: '0.00' },
  { refund_fee: '1.00' }, { trans_currency: 'USD' }
])('即使签名正确也拒绝不匹配或不能交付的通知 %j', changes => {
  const { order } = setup();
  expect(() => verify(notification(order.id, changes))).toThrow();
});

it('HTTP 验签、核款和发码成功后才返回纯 success；重复与乱序成功通知不重复发码', async () => {
  const { service, order, details } = setup();
  const server = createLicensingServer(service, 'a'.repeat(48), notifications);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('缺少监听地址');
    const post = (body: URLSearchParams | string, contentType = 'application/x-www-form-urlencoded') => fetch(`http://127.0.0.1:${address.port}/v1/payments/alipay/notify`, { method: 'POST', headers: { 'Content-Type': contentType }, body, signal: AbortSignal.timeout(5000) });
    expect((await post(notification(order.id, { total_amount: '1.00' }))).status).toBe(409);
    expect(service.describeOrder(order.id).licenses).toHaveLength(0);
    const paid = await post(notification(order.id));
    expect(paid.status).toBe(200); expect(paid.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await paid.text()).toBe('success');
    const delivered = service.describeOrder(order.id).licenses;
    expect(delivered).toHaveLength(2);
    for (const status of ['TRADE_SUCCESS', 'TRADE_FINISHED', 'TRADE_SUCCESS']) expect(await (await post(notification(order.id, { trade_status: status }))).text()).toBe('success');
    expect(service.describeOrder(order.id).licenses).toEqual(delivered);
    const second = service.createOrder({ ...details, reference: 'another-order' });
    expect((await post(notification(second.id))).status).toBe(409);
    expect(service.describeOrder(second.id).licenses).toHaveLength(0);
    expect((await post(notification(order.id, { trade_no: '202609282200000000000002' }))).status).toBe(409);
    expect((await post('x'.repeat(17000))).status).toBe(413);
    expect((await post('{}', 'application/json')).status).toBe(415);
    const tampered = notification(order.id); tampered.set('seller_id', '2088000000000002');
    expect((await post(tampered)).status).toBe(401);
    const unknown = notification('11111111-1111-4111-8111-111111111111');
    expect((await post(unknown)).status).toBe(404);
    const productResponses = await Promise.all(Array.from({ length: 121 }, () => fetch(`http://127.0.0.1:${address.port}/health`, { signal: AbortSignal.timeout(5000) })));
    expect(productResponses.some(response => response.status === 429)).toBe(true);
    await Promise.all(productResponses.map(response => response.arrayBuffer()));
    expect(await (await post(notification(order.id))).text()).toBe('success');
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

it('没有配置支付宝时保持回调关闭，不能由请求指定验签公钥或商户', async () => {
  const { service, order } = setup();
  const server = createLicensingServer(service, 'a'.repeat(48));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('缺少监听地址');
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/payments/alipay/notify`, { method: 'POST', body: notification(order.id), signal: AbortSignal.timeout(5000) });
    expect(response.status).toBe(404);
    expect(service.describeOrder(order.id).licenses).toHaveLength(0);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
