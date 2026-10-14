import { listenHttpTestServer } from './http-test-server';
import { generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AlipayCheckout, AlipayNotifications } from './alipay';
import { createLicensingServer } from './http';
import { LicensingService } from './service';
import { purchaseDeliverySchema } from '../../../packages/schema/src/purchase';

const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 });
const provider = generateKeyPairSync('rsa', { modulusLength: 2048 });
const issuer = generateKeyPairSync('ed25519');
const appId = '2026000000000001'; const sellerId = '2088000000000001';
const now = Date.parse('2026-09-28T00:00:00Z');
const notifications = new AlipayNotifications(appId, sellerId, provider.publicKey.export({ type: 'spki', format: 'pem' }).toString());
const services: LicensingService[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const service of services.splice(0)) service.close(); });
function setup() {
  const checkout = new AlipayCheckout(appId, sellerId, merchant.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'production', 'https://api.tuanbo-link.jinhefilm.com', () => now);
  const service = new LicensingService(':memory:', issuer.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'test', randomBytes(32), () => now);
  services.push(service);
  const order = service.createOrder({ reference: 'query-test', customer: '测试客户', customerType: 'company', quantity: 2,
    kind: 'perpetual', amountFen: 12345, useUntil: null, updatesUntil: '2027-09-28T00:00:00Z' });
  return { checkout, service, order };
}
function fields(id: string, changes: Record<string, string> = {}) {
  return { code: '10000', msg: 'Success', out_trade_no: `TB_${id.replaceAll('-', '')}`, trade_no: '202609282200000000000001',
    trade_status: 'TRADE_SUCCESS', total_amount: '123.45', buyer_logon_id: 'private@example.invalid', ...changes };
}
function signed(body: string) {
  return `{"alipay_trade_query_response":${body},"sign":"${sign('RSA-SHA256', Buffer.from(body), provider.privateKey).toString('base64')}"}`;
}

it('查单签名含 sign_type，固定网关、订单和超时；响应按原始 JSON 验签且不返回买家资料', async () => {
  const { checkout, order } = setup();
  const request = vi.fn<typeof fetch>((input, init) => {
    if (typeof input !== 'string') throw new Error('请求应使用固定网关 URL');
    const url = new URL(input);
    expect(url.origin + url.pathname).toBe('https://openapi.alipay.com/gateway.do');
    expect(init?.method).toBe('POST'); expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const params = Object.fromEntries(url.searchParams);
    const signature = params.sign!; delete params.sign;
    if (!(init?.body instanceof URLSearchParams)) throw new Error('查单应发送表单正文');
    params.biz_content = init.body.get('biz_content')!;
    expect(JSON.parse(params.biz_content)).toEqual({ out_trade_no: `TB_${order.id.replaceAll('-', '')}` });
    expect(params.method).toBe('alipay.trade.query'); expect(params.app_id).toBe(appId);
    expect(verify('RSA-SHA256', Buffer.from(Object.keys(params).sort().map(key => `${key}=${params[key]}`).join('&')), merchant.publicKey, Buffer.from(signature, 'base64'))).toBe(true);
    return Promise.resolve(new Response(signed(JSON.stringify({ ...fields(order.id), nested: { text: '} , "sign": "fake" 中文' } }, null, 2))));
  });
  const result = await checkout.query(order.id, notifications, request);
  expect(request).toHaveBeenCalledTimes(1);
  expect(result).toEqual({ orderId: order.id, status: 'TRADE_SUCCESS', paymentReference: 'alipay:202609282200000000000001', amountFen: 12345, appId, sellerId });
  expect(JSON.stringify(result)).not.toContain('private@');
});

it('拒绝篡改、无签名、其他订单和歧义信封，不接受错误码作为支付成功', () => {
  const { order } = setup(); const valid = signed(JSON.stringify(fields(order.id)));
  expect(() => notifications.verifyQuery(valid.replace('123.45', '999.00'), order.id)).toThrow('验签失败');
  expect(() => notifications.verifyQuery(JSON.stringify({ alipay_trade_query_response: fields(order.id) }), order.id)).toThrow('验签失败');
  expect(() => notifications.verifyQuery(valid, '11111111-1111-4111-8111-111111111111')).toThrow('其他订单');
  expect(() => notifications.verifyQuery(signed(JSON.stringify({ code: '40004', sub_code: 'ACQ.SYSTEM_ERROR' })), order.id)).toThrow('尚未返回可确认');
  expect(() => notifications.verifyQuery(JSON.stringify({ alipay_trade_query_response: { code: '40004', sub_code: 'ACQ.TRADE_NOT_EXIST' } }), order.id)).toThrow('验签失败');
  expect(notifications.verifyQuery(signed(JSON.stringify({ code: '40004', msg: 'Business Failed', sub_code: 'ACQ.TRADE_NOT_EXIST' })), order.id))
    .toEqual({ orderId: order.id, status: 'TRADE_NOT_EXIST', appId, sellerId });
  expect(() => notifications.verifyQuery(`{"alipay_trade_query_response":{},${valid.slice(1)}`, order.id)).toThrow();
  expect(() => notifications.verifyQuery(signed(`${JSON.stringify(fields(order.id))},"other":{}`), order.id)).toThrow('格式无效');
});

it.each([
  { seller_id: '2088000000000002' }, { app_id: '2026000000000002' }, { trans_currency: 'USD' },
  { refund_fee: '0.01' }, { additional_status: 'SELLER_NOT_RECEIVED' }, { total_amount: '0.00' }, { total_amount: '1e2' }
])('查单拒绝不匹配身份、币种、退款、未收款或无效金额 %j', changes => {
  const { order } = setup();
  expect(() => notifications.verifyQuery(signed(JSON.stringify(fields(order.id, changes))), order.id)).toThrow();
});

it('查询网络错误、非成功 HTTP、过大或非 UTF-8 响应均失败，不自动重试', async () => {
  const { checkout, order } = setup();
  const responses: Array<() => Promise<Response>> = [
    () => Promise.reject(new Error('network details must not escape')),
    () => Promise.resolve(new Response('down', { status: 503 })),
    () => Promise.resolve(new Response('x'.repeat(65537))), () => Promise.resolve(new Response(Uint8Array.from([255])))
  ];
  for (const response of responses) {
    const request = vi.fn<typeof fetch>(response);
    await expect(checkout.query(order.id, notifications, request)).rejects.toThrow(/查单/);
    expect(request).toHaveBeenCalledTimes(1);
  }
});

it('八秒到期中断无响应的查单，只发起一次请求', async () => {
  const { checkout, order } = setup();
  const request = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
  }));
  await expect(checkout.query(order.id, notifications, request)).rejects.toThrow('超时或网络异常');
  expect(request).toHaveBeenCalledTimes(1);
}, 12000);

it('回调丢失时查询补发一次，回调再到和重复查询返回原授权；金额不符不写入', async () => {
  const { checkout, service, order } = setup();
  service.prepareAlipayPayment(order.id, appId, sellerId);
  const payment = await checkout.query(order.id, notifications, () => Promise.resolve(new Response(signed(JSON.stringify(fields(order.id))))));
  expect(() => service.reconcileAlipay(order.id, { ...payment, amountFen: 1 })).toThrow('金额与订单不一致');
  expect(service.describeOrder(order.id).licenses).toHaveLength(0);
  const result = service.reconcileAlipay(order.id, payment);
  expect(result).toEqual({ id: order.id, state: 'fulfilled', paymentStatus: 'TRADE_SUCCESS', needsReview: false });
  const licenses = service.describeOrder(order.id).licenses;
  expect(licenses).toHaveLength(2);
  expect(service.reconcileAlipay(order.id, payment)).toEqual(result);
  expect(service.fulfill(order.id, { amountFen: payment.amountFen, paymentReference: payment.paymentReference }, 'alipay', payment).licenses).toEqual(licenses);
  service.revoke(licenses[0]!.id, { reason: '退款测试' });
  service.reconcileAlipay(order.id, payment);
  expect(service.describeOrder(order.id).licenses[0]?.revoked).toBe(true);
});

it('待付、关闭状态不交付、不推断退款；已交付后关闭返回待核对标记', () => {
  const { service, order } = setup(); service.prepareAlipayPayment(order.id, appId, sellerId);
  const query = (status: string) => notifications.verifyQuery(signed(JSON.stringify(fields(order.id, { trade_status: status }))), order.id);
  for (const status of ['WAIT_BUYER_PAY', 'TRADE_CLOSED']) {
    expect(service.reconcileAlipay(order.id, query(status))).toEqual({ id: order.id, state: 'pending', paymentStatus: status, needsReview: false });
    expect(service.describeOrder(order.id).licenses).toHaveLength(0);
  }
  service.reconcileAlipay(order.id, query('TRADE_SUCCESS'));
  expect(service.reconcileAlipay(order.id, query('TRADE_CLOSED')).needsReview).toBe(true);
});

it('主动查单只供运营，对未绑定或错误配置在请求渠道前拒绝', async () => {
  const { checkout, service, order } = setup();
  const original = checkout.query.bind(checkout);
  const providerRequest = vi.fn<typeof fetch>(() => Promise.resolve(new Response(signed(JSON.stringify(fields(order.id))))));
  vi.spyOn(checkout, 'query').mockImplementation((id, verifier) => original(id, verifier, providerRequest));
  const admin = 'a'.repeat(48); const server = createLicensingServer(service, admin, notifications, checkout);
  await listenHttpTestServer(server);
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('缺少监听地址');
    const request = (token: string, body: unknown = {}, prefix = 'admin') => fetch(`http://127.0.0.1:${address.port}/${prefix}/orders/${order.id}/reconcile`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000)
    });
    expect((await request('')).status).toBe(401);
    expect((await request(admin, {}, 'v1')).status).toBe(401);
    expect((await request(admin, { amountFen: 1 })).status).toBe(400);
    expect((await request(admin)).status).toBe(409);
    expect(providerRequest).not.toHaveBeenCalled();
    service.prepareAlipayPayment(order.id, appId, sellerId);
    expect(() => service.alipayQueryOrder(order.id, '2026000000000002', sellerId)).toThrow('不匹配');
    const results = await Promise.all([request(admin), request(admin)]);
    for (const result of results) {
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({ id: order.id, state: 'fulfilled', paymentStatus: 'TRADE_SUCCESS', needsReview: false });
    }
    expect(service.describeOrder(order.id).licenses).toHaveLength(2);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

it('客户持原领取凭据可在通知丢失后查单补交付，不泄漏买家或运营信息', async () => {
  const { checkout, service, order } = setup();
  service.prepareAlipayPayment(order.id, appId, sellerId);
  const access = service.issueDeliveryAccess(order.id, { reason: '测试领取' });
  const original = checkout.query.bind(checkout);
  const providerRequest = vi.fn<typeof fetch>(() => Promise.resolve(new Response(signed(JSON.stringify(fields(order.id))))));
  vi.spyOn(checkout, 'query').mockImplementation((id, verifier) => original(id, verifier, providerRequest));
  const server = createLicensingServer(service, 'a'.repeat(48), notifications, checkout);
  await listenHttpTestServer(server);
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('未监听');
    const request = (token: string, body: unknown = {}) => fetch(`http://127.0.0.1:${address.port}/v1/orders/${order.id}/reconcile`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000)
    });
    expect((await request('')).status).toBe(401);
    expect((await request('TBD-' + '0'.repeat(64))).status).toBe(401);
    expect((await request(access.token, { amountFen: 1 })).status).toBe(400);
    expect(providerRequest).not.toHaveBeenCalled();
    const response = await request(access.token);
    expect(response.status).toBe(200);
    const delivery = purchaseDeliverySchema.parse(await response.json());
    expect(delivery).toEqual(service.readDelivery(order.id, access.token));
    expect(delivery.state).toBe('fulfilled'); expect(delivery.licenses).toHaveLength(2);
    expect(JSON.stringify(delivery)).not.toMatch(/private@|paymentReference|customer|machineCode/);
    expect((await request(access.token)).status).toBe(200);
    expect(providerRequest).toHaveBeenCalledTimes(1);
    service.revokeDeliveryAccess(order.id, { reason: '撤销测试' });
    expect((await request(access.token)).status).toBe(401);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

it.each(['pending', 'network', 'revoked', 'tampered'] as const)('客户查单并发限流及 %s 结果不误发码、不重试', async mode => {
  const { checkout, service, order } = setup();
  service.prepareAlipayPayment(order.id, appId, sellerId);
  const access = service.issueDeliveryAccess(order.id, { reason: '测试领取' });
  let started!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const original = checkout.query.bind(checkout);
  const providerRequest = vi.fn<typeof fetch>(async () => {
    started(); await waiting;
    if (mode === 'network') throw new Error('channel unavailable');
    const response = signed(JSON.stringify(fields(order.id, { trade_status: mode === 'pending' ? 'WAIT_BUYER_PAY' : 'TRADE_SUCCESS' })));
    return new Response(mode === 'tampered' ? response.replace('123.45', '999.00') : response);
  });
  vi.spyOn(checkout, 'query').mockImplementation((id, verifier) => original(id, verifier, providerRequest));
  const server = createLicensingServer(service, 'a'.repeat(48), notifications, checkout);
  await listenHttpTestServer(server);
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('未监听');
    const request = () => fetch(`http://127.0.0.1:${address.port}/v1/orders/${order.id}/reconcile`, {
      method: 'POST', headers: { Authorization: `Bearer ${access.token}`, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000)
    });
    const first = request(); await entered;
    expect((await request()).status).toBe(429);
    if (mode === 'revoked') service.revokeDeliveryAccess(order.id, { reason: '查单途中撤销' });
    release();
    const response = await first;
    expect(response.status).toBe(mode === 'pending' ? 200 : mode === 'revoked' ? 401 : 502);
    if (mode === 'pending') expect(await response.json()).toMatchObject({ state: 'pending', licenses: [] });
    expect((await request()).status).toBe(mode === 'revoked' ? 401 : 429);
    expect(providerRequest).toHaveBeenCalledTimes(1);
    expect(service.describeOrder(order.id).state).toBe('pending');
    expect(service.describeOrder(order.id).licenses).toEqual([]);
  } finally { release(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

it('付款期限过后查单确认交易不存在或已关闭才关单；仍待付款先调用 alipay.trade.close，未确认则保持待付款；每次转换写审计', async () => {
  let clock = now;
  const path = join(await mkdtemp(join(tmpdir(), 'tblink-close-')), 'license.db');
  const service = new LicensingService(path, issuer.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'test', randomBytes(32), () => clock);
  services.push(service);
  const checkout = new AlipayCheckout(appId, sellerId, merchant.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'production', 'https://api.tuanbo-link.jinhefilm.com', () => clock);
  const create = (reference: string) => {
    const order = service.createOrder({ reference, customer: '测试客户', customerType: 'company', quantity: 1, kind: 'perpetual', amountFen: 12345, useUntil: null, updatesUntil: '2027-09-28T00:00:00Z' });
    service.prepareAlipayPayment(order.id, appId, sellerId); return order.id;
  };
  const missing = create('close-missing'); const closed = create('close-closed'); const waiting = create('close-waiting');
  const replies: Record<string, (id: string) => string> = {};
  const closeRequests: string[] = [];
  const providerRequest = vi.fn<typeof fetch>((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input)); const method = url.searchParams.get('method')!;
    if (!(init?.body instanceof URLSearchParams)) throw new Error('应发送表单正文');
    const id = z.object({ out_trade_no: z.string() }).parse(JSON.parse(init.body.get('biz_content')!)).out_trade_no;
    if (method === 'alipay.trade.close') closeRequests.push(id);
    return Promise.resolve(new Response(replies[method]!(id)));
  });
  const query = checkout.query.bind(checkout); const close = checkout.close.bind(checkout);
  vi.spyOn(checkout, 'query').mockImplementation((id, verifier) => query(id, verifier, providerRequest));
  vi.spyOn(checkout, 'close').mockImplementation((id, verifier) => close(id, verifier, providerRequest));
  const status: Record<string, string> = { [missing]: 'TRADE_NOT_EXIST', [closed]: 'TRADE_CLOSED', [waiting]: 'WAIT_BUYER_PAY' };
  replies['alipay.trade.query'] = trade => {
    const order = [missing, closed, waiting].find(id => `TB_${id.replaceAll('-', '')}` === trade)!;
    return status[order] === 'TRADE_NOT_EXIST' ? signed(JSON.stringify({ code: '40004', msg: 'Business Failed', sub_code: 'ACQ.TRADE_NOT_EXIST' }))
      : signed(JSON.stringify(fields(order, { trade_status: status[order]!, total_amount: '123.45' })));
  };
  const closeReply = (body: unknown) => () => { const text = JSON.stringify(body); return `{"alipay_trade_close_response":${text},"sign":"${sign('RSA-SHA256', Buffer.from(text), provider.privateKey).toString('base64')}"}`; };
  replies['alipay.trade.close'] = closeReply({ code: '40004', msg: 'Business Failed', sub_code: 'ACQ.TRADE_STATUS_ERROR' });
  const admin = 'a'.repeat(48); const server = createLicensingServer(service, admin, notifications, checkout);
  await listenHttpTestServer(server);
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('未监听');
    const reconcile = (id: string) => fetch(`http://127.0.0.1:${address.port}/admin/orders/${id}/reconcile`, {
      method: 'POST', headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000)
    });
    for (const id of [missing, closed, waiting]) expect(await (await reconcile(id)).json()).toMatchObject({ state: 'pending' });
    expect(closeRequests).toEqual([]);
    clock += 15 * 60000;
    expect(await (await reconcile(missing)).json()).toMatchObject({ state: 'expired', paymentStatus: 'TRADE_NOT_EXIST' });
    expect(await (await reconcile(closed)).json()).toMatchObject({ state: 'closed', paymentStatus: 'TRADE_CLOSED' });
    const unconfirmed = await reconcile(waiting);
    expect(unconfirmed.status).toBe(502); expect(await unconfirmed.json()).toMatchObject({ code: 'PAYMENT_CLOSE_UNCONFIRMED' });
    expect(service.describeOrder(waiting).state).toBe('pending');
    replies['alipay.trade.close'] = closeReply({ code: '10000', msg: 'Success', out_trade_no: `TB_${waiting.replaceAll('-', '')}`, trade_no: '202609282200000000000001' });
    expect(await (await reconcile(waiting)).json()).toMatchObject({ state: 'closed', paymentStatus: 'WAIT_BUYER_PAY' });
    expect(closeRequests).toEqual([`TB_${waiting.replaceAll('-', '')}`, `TB_${waiting.replaceAll('-', '')}`]);
    expect(() => service.prepareAlipayPayment(waiting, appId, sellerId)).toThrow('已关闭');
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare("SELECT target, detail FROM audit WHERE action = 'order.state-changed' ORDER BY rowid").all()).toEqual([
        { target: missing, detail: 'pending->expired:alipay:TRADE_NOT_EXIST' }, { target: closed, detail: 'pending->closed:alipay:TRADE_CLOSED' },
        { target: waiting, detail: 'pending->closed:alipay:trade.close' }]);
    } finally { db.close(); }
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
