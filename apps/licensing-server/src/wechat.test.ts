import { listenHttpTestServer } from './http-test-server';
import { createCipheriv, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { WechatPay } from './wechat';
import { LicensingService } from './service';
import { createLicensingServer } from './http';
import { AlipayCheckout, AlipayNotifications } from './alipay';
import { WebPurchaseClient } from '../web/purchase-client';
import { purchaseCatalogSchema, purchaseRequestSchema, purchaseResponseSchema } from '../../../packages/schema/src/purchase';

const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 });
const platform = generateKeyPairSync('rsa', { modulusLength: 2048 });
const issuer = generateKeyPairSync('ed25519');
const apiKey = randomBytes(32);
const identity = { appId: 'wx1234567890abcdef', sellerId: '1900000001' };
const serial = '1234567890ABCDEF1234567890ABCDEF';
const publicKeyId = 'PUB_KEY_ID_3000000001';
const urlString = (url: Parameters<typeof fetch>[0]): string => typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
const fixed = Date.parse('2026-09-30T00:00:00Z');
const id = '12345678-1234-4234-8234-123456789012';
const catalog = purchaseCatalogSchema.parse({ version: 1, maxOrderAmountFen: 1000000, offers: [{
  id: 'month', revision: 'test-1', name: '测试月付', unitAmountFen: 80000, kind: 'subscription', useDays: 30,
  updatesDays: 30, maxQuantity: 1, saleUntil: '2099-01-01T00:00:00Z'
}] });
const input = purchaseRequestSchema.parse({ offerId: 'month', revision: 'test-1', quotedUnitAmountFen: 80000, quantity: 1, customer: '测试工作室', customerType: 'company' });
const transaction = (orderId = id) => ({ appid: identity.appId, mchid: identity.sellerId, out_trade_no: orderId.replaceAll('-', ''),
  trade_type: 'NATIVE', trade_state: 'SUCCESS', transaction_id: '4200000000000000000000000001', amount: { total: 80000, currency: 'CNY' } });
function signed(body: string, time = fixed): Headers {
  const timestamp = String(Math.floor(time / 1000)); const nonce = 'test-response-nonce';
  return new Headers({ 'Content-Type': 'application/json', 'Wechatpay-Timestamp': timestamp, 'Wechatpay-Nonce': nonce, 'Wechatpay-Serial': publicKeyId,
    'Wechatpay-Signature': sign('RSA-SHA256', Buffer.from(`${timestamp}\n${nonce}\n${body}\n`), platform.privateKey).toString('base64') });
}
function response(value: unknown, time = fixed): Response {
  const body = JSON.stringify(value); return new Response(body, { headers: signed(body, time) });
}
function callback(value: unknown = transaction(), time = fixed) {
  const nonce = '123456789012'; const aad = 'transaction';
  const cipher = createCipheriv('aes-256-gcm', apiKey, nonce); cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]).toString('base64');
  const body = JSON.stringify({ event_type: 'TRANSACTION.SUCCESS', resource_type: 'encrypt-resource', resource: {
    algorithm: 'AEAD_AES_256_GCM', original_type: 'transaction', nonce, associated_data: aad, ciphertext
  } });
  return { body, headers: signed(body, time) };
}
function provider(send: typeof fetch = () => Promise.reject(new Error('测试禁止外网')), now = () => fixed) {
  return new WechatPay(identity.appId, identity.sellerId, merchant.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), serial,
    platform.publicKey.export({ type: 'spki', format: 'pem' }).toString(), publicKeyId, apiKey, 'https://api.tuanbo-link.jinhefilm.com', now, send);
}
const order = { id, amountFen: 80000, quantity: 1, expiresAt: new Date(fixed + 15 * 60000).toISOString() };

it('Native 请求签名覆盖路径和原始金额，订单号 32 位且响应必须验签', async () => {
  const send = vi.fn<typeof fetch>((url, init) => {
    expect(url).toBe('https://api.mch.weixin.qq.com/v3/pay/transactions/native');
    expect(init?.redirect).toBe('error'); expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (typeof init?.body !== 'string') throw new Error('预期 JSON 字符串');
    const auth = new Headers(init?.headers).get('Authorization')!;
    const fields = Object.fromEntries(Array.from(auth.matchAll(/(\w+)="([^"]+)"/g), match => [match[1]!, match[2]!]));
    expect(fields.mchid).toBe(identity.sellerId); expect(fields.serial_no).toBe(serial);
    expect(verify('RSA-SHA256', Buffer.from(`POST\n/v3/pay/transactions/native\n${fields.timestamp}\n${fields.nonce_str}\n${init.body}\n`), merchant.publicKey, Buffer.from(fields.signature!, 'base64'))).toBe(true);
    expect(JSON.parse(init.body)).toMatchObject({ appid: identity.appId, mchid: identity.sellerId, out_trade_no: id.replaceAll('-', ''),
      amount: { total: 80000, currency: 'CNY' }, notify_url: 'https://api.tuanbo-link.jinhefilm.com/v1/payments/wechat/notify' });
    return Promise.resolve(response({ code_url: 'weixin://wxpay/bizpayurl?pr=test123' }));
  });
  expect(await provider(send).create(order)).toBe('weixin://wxpay/bizpayurl?pr=test123'); expect(send).toHaveBeenCalledTimes(1);
});

it('有效通知按原文验签、AES-GCM 解密并返回带渠道前缀的流水', () => {
  const notification = callback();
  expect(provider().notification(Buffer.from(notification.body), notification.headers)).toEqual({ orderId: id, ...identity, status: 'SUCCESS', amountFen: 80000, paymentReference: 'wechat:4200000000000000000000000001' });
});

it.each(['tamper', 'serial', 'timestamp', 'probe', 'ciphertext', 'aad', 'identity', 'currency', 'state', 'type', 'reference'])('拒绝通知异常：%s', mode => {
  const value = transaction();
  if (mode === 'identity') value.mchid = '1900000002';
  if (mode === 'currency') value.amount.currency = 'USD';
  if (mode === 'state') value.trade_state = 'REFUND';
  if (mode === 'type') value.trade_type = 'JSAPI';
  if (mode === 'reference') value.transaction_id = '';
  const notice = callback(value);
  if (mode === 'tamper') notice.body += ' ';
  if (mode === 'serial') notice.headers.set('Wechatpay-Serial', 'PUB_KEY_ID_3000000002');
  if (mode === 'timestamp') notice.headers = signed(notice.body, fixed - 301000);
  if (mode === 'probe') notice.headers.set('Wechatpay-Signature', 'WECHATPAY/SIGNTEST/invalid');
  if (mode === 'ciphertext' || mode === 'aad') {
    notice.body = mode === 'aad' ? notice.body.replace('"associated_data":"transaction"', '"associated_data":"different"') : notice.body.replace('"ciphertext":"', '"ciphertext":"AAAA');
    notice.headers = signed(notice.body);
  }
  expect(() => provider().notification(Buffer.from(notice.body), notice.headers)).toThrow();
});

it('查单签名包含查询参数，拒绝串单，未支付及退款不当作成功', async () => {
  const send = vi.fn<typeof fetch>((url, init) => {
    const path = `/v3/pay/transactions/out-trade-no/${id.replaceAll('-', '')}?mchid=${identity.sellerId}`;
    expect(url).toBe(`https://api.mch.weixin.qq.com${path}`); expect(init?.body).toBeUndefined();
    const fields = Object.fromEntries(Array.from(new Headers(init?.headers).get('Authorization')!.matchAll(/(\w+)="([^"]+)"/g), match => [match[1]!, match[2]!]));
    expect(verify('RSA-SHA256', Buffer.from(`GET\n${path}\n${fields.timestamp}\n${fields.nonce_str}\n\n`), merchant.publicKey, Buffer.from(fields.signature!, 'base64'))).toBe(true);
    return Promise.resolve(response({ ...transaction(), trade_state: 'NOTPAY', transaction_id: undefined }));
  });
  expect(await provider(send).query(id)).toMatchObject({ status: 'NOTPAY', paymentReference: '' });
  await expect(provider(() => Promise.resolve(response(transaction('12345678-1234-4234-8234-123456789013')))).query(id)).rejects.toThrow('其他订单');
  expect(await provider(() => Promise.resolve(response({ ...transaction(), trade_state: 'REFUND' }))).query(id)).toMatchObject({ status: 'REFUND' });
});

it('不接受不可信二维码地址、无签名响应、过大响应，网络异常只请求一次', async () => {
  for (const code_url of ['https://evil.example/pay', 'weixin://wxpay/bizpayurl?pr=x&redirect=evil', 'javascript:alert(1)']) {
    await expect(provider(() => Promise.resolve(response({ code_url }))).create(order)).rejects.toThrow('二维码地址无效');
  }
  await expect(provider(() => Promise.resolve(Response.json({ code_url: 'weixin://wxpay/bizpayurl?pr=test' }))).create(order)).rejects.toThrow('验签失败');
  await expect(provider(() => Promise.resolve(new Response('x'.repeat(65537)))).create(order)).rejects.toThrow('大小限制');
  const failed = vi.fn<typeof fetch>(() => Promise.reject(new Error('offline')));
  await expect(provider(failed).create(order)).rejects.toThrow('网络异常'); expect(failed).toHaveBeenCalledTimes(1);
  await expect(provider(failed).create({ ...order, expiresAt: new Date(fixed + 59000).toISOString() })).rejects.toThrow('已过期'); expect(failed).toHaveBeenCalledTimes(1);
});

const servers: Server[] = []; const services: LicensingService[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  for (const service of services.splice(0)) service.close();
});
function storage() {
  const entries = new Map<string, string>();
  return { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); } };
}
async function setup(send: typeof fetch, enabled = true) {
  const service = new LicensingService(':memory:', issuer.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'test', randomBytes(32), () => fixed); services.push(service);
  const alipayId = { appId: '2026000000000001', sellerId: '2088000000000001' };
  const alipay = new AlipayNotifications(alipayId.appId, alipayId.sellerId, platform.publicKey.export({ type: 'spki', format: 'pem' }).toString());
  const checkout = new AlipayCheckout(alipayId.appId, alipayId.sellerId, merchant.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'production', 'https://api.tuanbo-link.jinhefilm.com', () => fixed);
  const wechat = provider(send);
  const server = createLicensingServer(service, 'a'.repeat(48), alipay, checkout, catalog, false, wechat, enabled); servers.push(server);
  await listenHttpTestServer(server);
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('未监听');
  const request: typeof fetch = (url, init) => fetch(`http://127.0.0.1:${address.port}${urlString(url)}`, init);
  return { service, request, wechat, alipayId, client: new WebPurchaseClient(storage(), request) };
}

it('官网创建、重复恢复同一微信单，成功通知只交付一次，旧支付宝契约保持不变', async () => {
  const send = vi.fn<typeof fetch>(() => Promise.resolve(response({ code_url: 'weixin://wxpay/bizpayurl?pr=test123' })));
  const { client, request, service, alipayId } = await setup(send);
  expect((await client.catalog('wechat')).available).toBe(true);
  const receipt = client.prepare(input, 'wechat'); expect(receipt.version).toBe(2);
  const first = await client.submit(); const second = await client.submit(); expect(second).toEqual(first); expect(send).toHaveBeenCalledTimes(1);
  expect(() => service.createPurchase(input, receipt.token, catalog, alipayId)).toThrow('不能更换');
  expect(() => service.prepareAlipayPayment(first.id, alipayId.appId, alipayId.sellerId)).toThrow('不能另建');
  expect(() => service.fulfill(first.id, { paymentReference: 'manual:x', amountFen: 80000 })).toThrow('不能更换');
  const notice = callback(transaction(first.id));
  for (let index = 0; index < 2; index++) expect((await request('/v1/payments/wechat/notify', { method: 'POST', body: notice.body, headers: notice.headers })).status).toBe(200);
  const delivery = await client.delivery(); expect(delivery.state).toBe('fulfilled'); expect(delivery.licenses).toHaveLength(1);
  expect((await client.delivery()).licenses).toEqual(delivery.licenses);
  expect(await client.submit()).toMatchObject({ payable: false, paymentUrl: null, state: 'fulfilled' });
  const old = new WebPurchaseClient(storage(), request); expect(old.prepare(input).version).toBe(1);
  const oldOrder = purchaseResponseSchema.parse(await old.submit()); expect(new URL(oldOrder.paymentUrl!).hostname).toBe('openapi.alipay.com');
  expect(() => service.fulfill(oldOrder.id, { paymentReference: 'wechat:4200000000000000000000000001', amountFen: 80000 }, 'wechat', identity)).toThrow('不能更换');
});

it('微信下单响应丢失仍保留订单号，持原凭据主动查单可补交付', async () => {
  let createdId = '';
  const send = vi.fn<typeof fetch>((url, init) => {
    if (init?.method === 'POST') {
      if (typeof init.body !== 'string') throw new Error('预期 JSON 字符串');
      const body = JSON.parse(init.body) as { out_trade_no: string };
      const raw = body.out_trade_no; createdId = `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
      return Promise.reject(new Error('lost response'));
    }
    expect(urlString(url)).toContain(createdId.replaceAll('-', ''));
    return Promise.resolve(response(transaction(createdId)));
  });
  const { client, request } = await setup(send); const draft = client.prepare(input, 'wechat');
  await expect(client.submit()).rejects.toThrow('网络异常');
  expect(client.receipt).toMatchObject({ token: draft.token, orderId: createdId, discardable: false });
  expect((await client.delivery(true)).state).toBe('fulfilled'); expect(send).toHaveBeenCalledTimes(2);
  const restored = new WebPurchaseClient(storage(), request); restored.importReceipt(JSON.stringify(draft));
  expect((await restored.submit()).state).toBe('fulfilled'); expect(send).toHaveBeenCalledTimes(2);
});

it('金额或商户不一致的通知不交付；关闭微信不影响支付宝目录', async () => {
  const { client, service, request } = await setup(() => Promise.resolve(response({ code_url: 'weixin://wxpay/bizpayurl?pr=test' })));
  client.prepare(input, 'wechat'); const order = await client.submit();
  const notice = callback({ ...transaction(order.id), amount: { total: 1, currency: 'CNY' } });
  expect((await request('/v1/payments/wechat/notify', { method: 'POST', ...notice })).status).toBe(409);
  expect((await client.delivery()).licenses).toEqual([]); expect(service.paymentExceptions(0).items).toEqual([]);
  const closed = await setup(() => Promise.reject(new Error('不得请求')), false);
  expect((await closed.client.catalog('wechat')).available).toBe(false); expect((await closed.client.catalog()).available).toBe(true);
  closed.client.prepare(input, 'wechat'); await expect(closed.client.submit()).rejects.toThrow('购买尚未开放');
});

it('旧服务端忽略微信请求头时，官网拒绝把支付宝目录误当微信开通', async () => {
  const client = new WebPurchaseClient(storage(), () => Promise.resolve(Response.json({ available: true, currency: 'CNY', termStart: 'fulfillment', offers: catalog.offers })));
  await expect(client.catalog('wechat')).rejects.toThrow('尚未开放');
});


it('未支付与退款查单不发码，微信关闭新销售后仍可凭原单查询成功付款', async () => {
  const { service, request, client, wechat } = await setup(() => Promise.resolve(response({ code_url: 'weixin://wxpay/bizpayurl?pr=test' })));
  const receipt = client.prepare(input, 'wechat'); const order = await client.submit();
  for (const status of ['NOTPAY', 'REFUND', 'CLOSED'] as const) {
    expect(service.reconcileWechat(order.id, { orderId: order.id, ...identity, status, amountFen: 80000, paymentReference: '' }).state).toBe('pending');
    expect(service.readDelivery(order.id, receipt.token).licenses).toEqual([]);
  }
  const closed = createLicensingServer(service, 'a'.repeat(48), undefined, undefined, catalog, false, wechat, false); servers.push(closed);
  await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve));
  const address = closed.address(); if (!address || typeof address === 'string') throw new Error('未监听');
  const call: typeof fetch = (url, init) => fetch(`http://127.0.0.1:${address.port}${urlString(url)}`, init);
  const resumed = new WebPurchaseClient(storage(), call); resumed.importReceipt(JSON.stringify(client.receipt));
  expect(await resumed.submit()).toMatchObject({ id: order.id, payable: false, paymentUrl: null });
  const notice = callback(transaction(order.id));
  expect((await call('/v1/payments/wechat/notify', { method: 'POST', ...notice })).status).toBe(200);
  expect((await resumed.delivery()).state).toBe('fulfilled');
  expect((await request('/health')).status).toBe(200);
});


it('运营查单从原订单选择微信，不能改走支付宝', async () => {
  let target = '';
  const send = vi.fn<typeof fetch>(() => Promise.resolve(response(transaction(target))));
  const { service, request } = await setup(send);
  const credential = `TBD-${randomBytes(32).toString('hex').toUpperCase()}`;
  target = service.createPurchase(input, credential, catalog, identity, undefined, 'wechat').id;
  const result = await request(`/admin/orders/${target}/reconcile`, { method: 'POST', headers: {
    Authorization: `Bearer ${'a'.repeat(48)}`, 'Content-Type': 'application/json'
  }, body: '{}' });
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ id: target, state: 'fulfilled', paymentStatus: 'SUCCESS' });
  expect(send).toHaveBeenCalledTimes(1);
});
