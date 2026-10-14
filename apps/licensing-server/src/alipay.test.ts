import { listenHttpTestServer } from './http-test-server';
import { generateKeyPairSync, randomBytes, sign, verify as verifySignature } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { AlipayCheckout, AlipayNotifications } from './alipay';
import { createLicensingServer } from './http';
import { LicensingService } from './service';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const issuer = generateKeyPairSync('ed25519');
const appId = '2026000000000001';
const sellerId = '2088000000000001';
const notifications = new AlipayNotifications(appId, sellerId, rsa.publicKey.export({ format: 'pem', type: 'spki' }).toString());
const services: LicensingService[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const service of services.splice(0)) service.close(); });
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
  expect(verify(notification(order.id))).toEqual({ orderId: order.id, status: 'TRADE_SUCCESS', amountFen: 12345, refundFen: 0, paymentReference: 'alipay:202609282200000000000001', appId, sellerId });
  for (const amount of ['123', '123.4', '123.45']) expect(verify(notification(order.id, { total_amount: amount })).amountFen).toBe(Math.round(Number(amount) * 100));
});

it('付款入口签名包含 sign_type，金额和有效期来自订单，链接不包含客户或领取凭据', () => {
  const { service, order } = setup();
  const now = Date.parse('2026-09-28T00:00:00Z');
  const checkout = new AlipayCheckout(appId, sellerId, rsa.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), () => now);
  const payment = service.prepareAlipayPayment(order.id, appId, sellerId);
  const url = new URL(checkout.createUrl(payment));
  expect(url.origin + url.pathname).toBe('https://openapi.alipay.com/gateway.do');
  const params = Object.fromEntries(url.searchParams); const signature = params.sign!; delete params.sign;
  const content = Object.keys(params).sort().map(key => `${key}=${params[key]}`).join('&');
  expect(verifySignature('RSA-SHA256', Buffer.from(content), rsa.publicKey, Buffer.from(signature, 'base64'))).toBe(true);
  delete params.sign_type;
  const withoutType = Object.keys(params).sort().map(key => `${key}=${params[key]}`).join('&');
  expect(verifySignature('RSA-SHA256', Buffer.from(withoutType), rsa.publicKey, Buffer.from(signature, 'base64'))).toBe(false);
  expect(params.notify_url).toBe('https://api.tuanbo-link.jinhefilm.com/v1/payments/alipay/notify');
  expect(params).not.toHaveProperty('return_url');
  expect(JSON.parse(params.biz_content!)).toEqual({ out_trade_no: `TB_${order.id.replaceAll('-', '')}`, product_code: 'FAST_INSTANT_TRADE_PAY', total_amount: '123.45', subject: '团播联动台授权 2 台', goods_type: '0', qr_pay_mode: '2', time_expire: '2026-09-28 08:15:00' });
  expect(url.href).not.toContain('TBD-');
  expect(checkout.createUrl(payment)).not.toContain(encodeURIComponent('测试客户'));
  expect(service.describeOrder(order.id).licenses).toHaveLength(0);
  expect(service.prepareAlipayPayment(order.id, appId, sellerId)).toEqual(payment);
  expect(() => service.prepareAlipayPayment(order.id, '2026000000000002', sellerId)).toThrow('其他支付配置');
  expect(() => service.fulfill(order.id, { paymentReference: 'manual', amountFen: 12345 })).toThrow('不能改成人工核款');
});

it('仅服务器订单字段可构建付款链接，拒绝过期、弱密钥和额外网址参数', () => {
  const { service, order } = setup();
  let now = Date.parse('2026-09-28T00:00:00Z');
  const checkout = new AlipayCheckout(appId, sellerId, rsa.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), () => now);
  const payment = service.prepareAlipayPayment(order.id, appId, sellerId);
  expect(() => checkout.createUrl({ ...payment, returnUrl: 'https://example.invalid' })).toThrow();
  const weak = generateKeyPairSync('rsa', { modulusLength: 1024 });
  expect(() => new AlipayCheckout(appId, sellerId, weak.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString())).toThrow('2048');
  now += 15 * 60000;
  expect(() => checkout.createUrl(payment)).toThrow('过期');
});

it('付款入口过期不丢弃支付事实，绑定身份必须匹配；支付后不能再取得付款链接', () => {
  let now = Date.parse('2026-09-28T00:00:00Z');
  const service = new LicensingService(':memory:', issuer.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'test', randomBytes(32), () => now);
  services.push(service);
  const { details } = setup(); const order = service.createOrder(details);
  service.prepareAlipayPayment(order.id, appId, sellerId);
  now += 20 * 60000;
  expect(() => service.prepareAlipayPayment(order.id, appId, sellerId)).toThrow('过期');
  const payment = verify(notification(`TB_${order.id.replaceAll('-', '')}`));
  expect(payment.orderId).toBe(order.id);
  const fields = { amountFen: payment.amountFen, paymentReference: payment.paymentReference };
  expect(() => service.fulfill(order.id, fields, 'alipay', { appId, sellerId: '2088000000000002' })).toThrow('不匹配');
  const result = service.fulfill(order.id, fields, 'alipay', payment);
  expect(result.licenses).toHaveLength(2);
  expect(service.fulfill(order.id, fields, 'alipay', payment).licenses).toEqual(result.licenses);
  expect(() => service.prepareAlipayPayment(order.id, appId, sellerId)).toThrow('已交付');
});

it('付款入口只供认证运营获取，不能从请求覆盖金额；签名通知按渠道订单号交付原订单', async () => {
  const { service, order } = setup();
  const checkout = new AlipayCheckout(appId, sellerId, rsa.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), () => Date.parse('2026-09-28T00:00:00Z'));
  const admin = 'a'.repeat(48); const server = createLicensingServer(service, admin, notifications, checkout);
  await listenHttpTestServer(server);
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('缺少监听地址');
    const base = `http://127.0.0.1:${address.port}`;
    const request = (token: string, body: unknown = {}) => fetch(`${base}/admin/orders/${order.id}/payment-link`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    expect((await request('')).status).toBe(401);
    expect((await request(admin, { amountFen: 1 })).status).toBe(400);
    const response = await request(admin);
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json() as { paymentUrl: string; id: string };
    expect(body.id).toBe(order.id);
    const tradeNo = JSON.parse(new URL(body.paymentUrl).searchParams.get('biz_content')!).out_trade_no as string;
    const paid = await fetch(`${base}/v1/payments/alipay/notify`, { method: 'POST', body: notification(tradeNo), signal: AbortSignal.timeout(5000) });
    expect(await paid.text()).toBe('success');
    expect(service.describeOrder(order.id).licenses).toHaveLength(2);
    expect((await request(admin)).status).toBe(409);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
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
  { total_amount: '1e2' }, { total_amount: '123.456' }, { total_amount: '0.00' },
  { refund_fee: '123.46' }, { refund_fee: '1e2' }, { trans_currency: 'USD' }
])('即使签名正确也拒绝不匹配或无效金额的通知 %j', changes => {
  const { order } = setup();
  expect(() => verify(notification(order.id, changes))).toThrow();
});

it('HTTP 验签、核款和发码成功后才返回纯 success；重复与乱序成功通知不重复发码', async () => {
  const { service, order, details } = setup();
  const server = createLicensingServer(service, 'a'.repeat(48), notifications);
  await listenHttpTestServer(server);
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
  await listenHttpTestServer(server);
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('缺少监听地址');
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/payments/alipay/notify`, { method: 'POST', body: notification(order.id), signal: AbortSignal.timeout(5000) });
    expect(response.status).toBe(404);
    expect(service.describeOrder(order.id).licenses).toHaveLength(0);
    const link = await fetch(`http://127.0.0.1:${address.port}/admin/orders/${order.id}/payment-link`, {
      method: 'POST', headers: { Authorization: `Bearer ${'a'.repeat(48)}`, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000)
    });
    expect(link.status).toBe(503);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

it('重启后保留原付款期限与商户绑定，不因重复取链接延长付款窗口', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'tblink-payment-')), 'license.db');
  const key = randomBytes(32); let now = Date.parse('2026-09-28T00:00:00Z');
  const privateKey = issuer.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const first = new LicensingService(path, privateKey, 'test', key, () => now);
  const { details } = setup();
  const order = first.createOrder(details);
  const before = first.prepareAlipayPayment(order.id, appId, sellerId);
  first.close();
  now += 5 * 60000;
  const reopened = new LicensingService(path, privateKey, 'test', key, () => now);
  services.push(reopened);
  expect(reopened.prepareAlipayPayment(order.id, appId, sellerId)).toEqual(before);
  expect(() => reopened.prepareAlipayPayment(order.id, appId, '2088000000000002')).toThrow('其他支付配置');
});

it('验签通过的退款与关单通知落事件表并应答 success，全额退款标记订单但不撤销授权；验签失败与金额不符写结构化日志', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'tblink-alipay-events-')), 'license.db');
  const service = new LicensingService(path, issuer.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'test', randomBytes(32), () => Date.parse('2026-09-28T00:00:00Z'));
  services.push(service);
  const { details } = setup(); const order = service.createOrder(details);
  service.prepareAlipayPayment(order.id, appId, sellerId);
  const events = () => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare('SELECT kind, trade_status, refund_fen FROM payment_events ORDER BY rowid').all(); } finally { db.close(); } };
  const logs = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const server = createLicensingServer(service, 'a'.repeat(48), notifications);
  await listenHttpTestServer(server);
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('缺少监听地址');
    const post = (body: URLSearchParams) => fetch(`http://127.0.0.1:${address.port}/v1/payments/alipay/notify`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(5000) });
    expect(await (await post(notification(order.id))).text()).toBe('success');
    const delivered = service.describeOrder(order.id).licenses;
    const partial = notification(order.id, { refund_fee: '23.45', gmt_refund: '2026-09-28 09:00:00' });
    for (let attempt = 0; attempt < 2; attempt++) expect(await (await post(partial)).text()).toBe('success');
    expect(service.describeOrder(order.id).state).toBe('fulfilled');
    expect(events()).toEqual([{ kind: 'refund', trade_status: 'TRADE_SUCCESS', refund_fen: 2345 }]);
    expect(await (await post(notification(order.id, { trade_status: 'TRADE_CLOSED', refund_fee: '123.45' }))).text()).toBe('success');
    const refunded = service.describeOrder(order.id);
    expect(refunded.state).toBe('refunded');
    expect(refunded.licenses).toEqual(delivered); expect(refunded.licenses.every(license => !license.revoked)).toBe(true);
    const access = service.issueDeliveryAccess(order.id, { reason: '退款后领取' });
    expect(service.readDelivery(order.id, access.token)).toMatchObject({ state: 'fulfilled', licenses: delivered.map(license => ({ id: license.id, code: license.code, revoked: false })) });
    expect(logs).not.toHaveBeenCalled();
    const tampered = notification(order.id, { trade_status: 'TRADE_CLOSED', refund_fee: '123.45' }); tampered.set('refund_fee', '1.00');
    expect((await post(tampered)).status).toBe(401);
    expect((await post(notification(order.id, { trade_status: 'TRADE_CLOSED', total_amount: '1.00', refund_fee: '1.00' }))).status).toBe(409);
    expect(events()).toHaveLength(2);
    const lines = logs.mock.calls.map(call => JSON.parse(String(call[0])) as unknown);
    expect(lines).toEqual([
      expect.objectContaining({ error: 'PAYMENT_NOTIFICATION_REJECTED', channel: 'alipay', code: 'INVALID_PAYMENT_SIGNATURE' }),
      expect.objectContaining({ error: 'PAYMENT_NOTIFICATION_REJECTED', channel: 'alipay', code: 'AMOUNT_MISMATCH', orderId: order.id })
    ]);
    expect(lines[0]).not.toHaveProperty('orderId');
    expect(JSON.stringify(logs.mock.calls)).not.toMatch(/团播|sign|202609282200000000000001/);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

it('付款期限过后验签的 TRADE_CLOSED 通知关闭未收款订单；期限内只记事件，已收款订单不被关闭', () => {
  let now = Date.parse('2026-09-28T00:00:00Z');
  const service = new LicensingService(':memory:', issuer.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'test', randomBytes(32), () => now);
  services.push(service);
  const { details } = setup(); const order = service.createOrder(details);
  service.prepareAlipayPayment(order.id, appId, sellerId);
  const closed = verify(notification(order.id, { trade_status: 'TRADE_CLOSED' }));
  service.alipayNotification(closed);
  expect(service.describeOrder(order.id).state).toBe('pending');
  now += 15 * 60000;
  service.alipayNotification(verify(notification(order.id, { trade_status: 'TRADE_CLOSED', trade_no: '202609282200000000000009' })));
  expect(service.describeOrder(order.id).state).toBe('closed');
  // 关单后若仍收到验签成功的付款，保留收款事实并照常交付。
  service.alipayNotification(verify(notification(order.id, { trade_no: '202609282200000000000009' })));
  expect(service.describeOrder(order.id)).toMatchObject({ state: 'fulfilled', licenses: [expect.anything(), expect.anything()] });
  const paid = service.createOrder({ ...details, reference: 'paid-before-close' });
  service.prepareAlipayPayment(paid.id, appId, sellerId);
  service.alipayNotification(verify(notification(paid.id, { trade_no: '202609282200000000000010' })));
  now += 15 * 60000;
  service.alipayNotification(verify(notification(paid.id, { trade_status: 'TRADE_CLOSED', trade_no: '202609282200000000000010' })));
  expect(service.describeOrder(paid.id).state).toBe('fulfilled');
});

it('旧版“有收款但仍为 pending”的订单不回填，收到渠道事件或补交付时收敛为 paid 并照常交付', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'tblink-legacy-')), 'license.db');
  const service = new LicensingService(path, issuer.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'test', randomBytes(32), () => Date.parse('2026-09-28T00:00:00Z'));
  services.push(service);
  const { details } = setup(); const order = service.createOrder(details);
  service.prepareAlipayPayment(order.id, appId, sellerId);
  const db = new DatabaseSync(path);
  try { db.prepare("INSERT INTO payment_receipts VALUES (?, 'alipay:202609282200000000000001', 12345, 'alipay', ?, ?, '2026-09-28T00:00:00.000Z', 'INTERNAL_ERROR')").run(order.id, appId, sellerId); }
  finally { db.close(); }
  expect(service.describeOrder(order.id).state).toBe('pending');
  expect(service.paymentExceptions(0).items.map(item => item.orderId)).toEqual([order.id]);
  service.alipayNotification(verify(notification(order.id, { refund_fee: '0.45' })));
  expect(service.describeOrder(order.id).state).toBe('paid');
  expect(service.retryDelivery(order.id, { reason: '旧数据补交付' })).toMatchObject({ state: 'fulfilled', licenses: [expect.anything(), expect.anything()] });
});
