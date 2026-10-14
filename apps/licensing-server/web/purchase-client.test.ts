import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { AlipayCheckout, AlipayNotifications } from '../src/alipay';
import { LicensingService } from '../src/service';
import { createLicensingServer } from '../src/http';
import { purchaseCatalogSchema, purchaseRequestSchema } from '../../../packages/schema/src/purchase';
import { WebPurchaseClient } from './purchase-client';

const issuer = generateKeyPairSync('ed25519');
const provider = generateKeyPairSync('rsa', { modulusLength: 2048 });
const identity = { appId: '2026000000000001', sellerId: '2088000000000001' };
const offer = { id: 'test-month', revision: 'test-1', name: '测试套餐', unitAmountFen: 19900,
  kind: 'subscription', useDays: 30, updatesDays: 30, maxQuantity: 2, saleUntil: '2099-01-01T00:00:00Z' };
const catalog = purchaseCatalogSchema.parse({ version: 1, maxOrderAmountFen: 50000, offers: [offer] });
const request = purchaseRequestSchema.parse({ offerId: offer.id, revision: offer.revision,
  quotedUnitAmountFen: offer.unitAmountFen, quantity: 1, customer: '测试工作室', customerType: 'company' });
const servers: Server[] = []; const services: LicensingService[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  for (const service of services.splice(0)) service.close();
  vi.restoreAllMocks();
});
function storage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}
async function setup(now: () => number = Date.now) {
  const service = new LicensingService(':memory:', issuer.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'test', randomBytes(32), now);
  services.push(service);
  const notifications = new AlipayNotifications(identity.appId, identity.sellerId, provider.publicKey.export({ type: 'spki', format: 'pem' }).toString());
  const checkout = new AlipayCheckout(identity.appId, identity.sellerId, provider.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), now);
  const server = createLicensingServer(service, 'a'.repeat(48), notifications, checkout, catalog); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('未监听');
  const send: typeof fetch = (path, init) => fetch(`http://127.0.0.1:${address.port}${(typeof path === 'string' ? path : path instanceof URL ? path.href : path.url)}`, init);
  return { service, send, checkout };
}

it('网页显式查询请求渠道补交付，网络失败保留同一凭据且不自动重试', async () => {
  const { service, send, checkout } = await setup();
  const client = new WebPurchaseClient(storage(), send); client.prepare(request);
  const order = await client.submit(); const receipt = client.receipt;
  const original = checkout.query.bind(checkout);
  const body = JSON.stringify({ code: '10000', out_trade_no: `TB_${order.id.replaceAll('-', '')}`, trade_no: '202609282200000000000704',
    trade_status: 'TRADE_SUCCESS', total_amount: '199.00' });
  const providerRequest = vi.fn<typeof fetch>(() => Promise.resolve(new Response(`{"alipay_trade_query_response":${body},"sign":"${sign('RSA-SHA256', Buffer.from(body), provider.privateKey).toString('base64')}"}`)));
  vi.spyOn(checkout, 'query').mockImplementation((id, verifier) => original(id, verifier, providerRequest));
  let calls = 0;
  const offline = new WebPurchaseClient(storage(), () => { calls++; return Promise.reject(new Error('网络断开')); });
  offline.importReceipt(JSON.stringify(receipt));
  await expect(offline.delivery(true)).rejects.toThrow('网络断开');
  expect(calls).toBe(1); expect(offline.receipt).toEqual(receipt);
  expect((await client.delivery()).state).toBe('pending'); expect(providerRequest).not.toHaveBeenCalled();
  const delivered = await client.delivery(true);
  expect(delivered.state).toBe('fulfilled'); expect(delivered.licenses).toHaveLength(1);
  expect((await client.delivery(true)).licenses).toEqual(service.readDelivery(order.id, receipt!.token).licenses);
  expect(providerRequest).toHaveBeenCalledTimes(1);
});

async function paid(send: typeof fetch, orderId: string, tradeNo: string): Promise<void> {
  const fields: Record<string, string> = { app_id: identity.appId, seller_id: identity.sellerId,
    out_trade_no: `TB_${orderId.replaceAll('-', '')}`, trade_no: tradeNo, charset: 'utf-8',
    notify_type: 'trade_status_sync', trade_status: 'TRADE_SUCCESS', total_amount: '199.00' };
  const content = Object.keys(fields).sort().map(key => `${key}=${fields[key]}`).join('&');
  const body = new URLSearchParams({ ...fields, sign_type: 'RSA2', sign: sign('RSA-SHA256', Buffer.from(content), provider.privateKey).toString('base64') });
  const response = await send('/v1/payments/alipay/notify', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  expect(await response.text()).toBe('success');
}

it('首次下单丢失响应后，导入事先导出的凭据恢复同单，再通过服务端交付领码', async () => {
  const { send } = await setup(); let loseResponse = true; let headers: Headers | null = null;
  const saved = storage();
  const client = new WebPurchaseClient(saved, async (path, init) => {
    if (path === '/v1/orders') {
      expect(saved.getItem('tblink.purchase.receipt')).toContain('TBD-');
      headers = new Headers(init?.headers);
    }
    const response = await send(path, init);
    if (path === '/v1/orders' && loseResponse) { loseResponse = false; throw new Error('模拟响应丢失'); }
    return response;
  });
  expect((await client.catalog()).available).toBe(true);
  const draft = client.prepare(request);
  await expect(client.submit()).rejects.toThrow('响应丢失');
  expect(client.receipt?.orderId).toBeNull();
  expect(() => client.discard()).toThrow('状态尚未确认');
  const resumed = new WebPurchaseClient(storage(), send);
  resumed.importReceipt(JSON.stringify(draft));
  const order = await resumed.submit();
  expect(order.id).toBe((await client.submit()).id);
  expect(headers).not.toBeNull();
  expect((await resumed.delivery()).state).toBe('pending');
  await expect(resumed.finish()).rejects.toThrow('尚未交付');
  expect(resumed.receipt).not.toBeNull();
  await paid(send, order.id, '202609282200000000000701');
  const delivered = await resumed.delivery();
  expect(delivered.state).toBe('fulfilled'); expect(delivered.licenses[0]?.code).toBeTruthy();
  expect(JSON.stringify(resumed.receipt)).not.toContain(delivered.licenses[0]!.code);
  await resumed.finish(); expect(resumed.receipt).toBeNull();
});

it('订单已存在时禁止重复准备与跨单覆盖，重载标签页保留原凭据', () => {
  const saved = storage(); const client = new WebPurchaseClient(saved);
  const first = client.prepare(request);
  expect(() => client.prepare(request)).toThrow('尚未结束');
  const restored = new WebPurchaseClient(saved); expect(restored.restore()).toEqual(first);
  const other = new WebPurchaseClient(storage()).prepare(request);
  expect(() => restored.importReceipt(JSON.stringify(other))).toThrow('另一笔订单');
  expect(restored.receipt).toEqual(first);
  restored.discard(); expect(restored.receipt).toBeNull();
});

it('存储失败时不创建待发送状态，不发出任何下单请求', async () => {
  let calls = 0;
  const client = new WebPurchaseClient({ ...storage(), setItem: () => { throw new Error('无法保存'); } }, () => {
    calls++; throw new Error('不应联网');
  });
  expect(() => client.prepare(request)).toThrow('无法保存');
  await expect(client.submit()).rejects.toThrow('先准备');
  expect(calls).toBe(0);
});

it('售卖暂停不阻止已经付款的客户查询交付，未核款不能以客户端状态领码', async () => {
  const { service, send } = await setup(); const client = new WebPurchaseClient(storage(), send);
  client.prepare(request); const order = await client.submit();
  const stopped = createLicensingServer(service, 'b'.repeat(48)); servers.push(stopped);
  await new Promise<void>(resolve => stopped.listen(0, '127.0.0.1', resolve));
  const address = stopped.address(); if (!address || typeof address === 'string') throw new Error('未监听');
  const resumed = new WebPurchaseClient(storage(), (path, init) => fetch(`http://127.0.0.1:${address.port}${(typeof path === 'string' ? path : path instanceof URL ? path.href : path.url)}`, init));
  resumed.importReceipt(JSON.stringify(client.receipt));
  expect((await resumed.catalog()).available).toBe(false);
  expect((await resumed.submit()).paymentUrl).toBeNull();
  expect((await resumed.delivery()).licenses).toEqual([]);
  await paid(send, order.id, '202609282200000000000702');
  expect((await resumed.delivery()).licenses).toHaveLength(1);
});

it('拒绝续费凭据、过大凭据及被更改的报价，并保留原领取凭据', async () => {
  const { send } = await setup(); const client = new WebPurchaseClient(storage(), send);
  const draft = client.prepare(request);
  expect(() => client.importReceipt(JSON.stringify({ ...draft, request: { ...request, renewalLicenseId: crypto.randomUUID() } }))).toThrow();
  expect(() => client.importReceipt(' '.repeat(32769))).toThrow('大小');
  const forged = new WebPurchaseClient(storage(), send);
  forged.importReceipt(JSON.stringify({ ...draft, request: { ...request, quotedUnitAmountFen: 1 } }));
  await expect(forged.submit()).rejects.toThrow('商品已更新');
  expect(forged.receipt?.token).toBe(draft.token);
  forged.discard(); expect(forged.receipt).toBeNull();
});

it('拒绝恶意付款跳转和错单响应，不向凭据文件保存付款链接', async () => {
  const { send } = await setup(); const client = new WebPurchaseClient(storage(), send);
  client.prepare(request); const original = await client.submit();
  for (const paymentUrl of ['javascript:alert(1)', 'https://evil.example/gateway.do', 'https://user@openapi.alipay.com/gateway.do', 'https://openapi.alipay.com/not-payment']) {
    const attacker = new WebPurchaseClient(storage(), () => Promise.resolve(Response.json({ ...original, paymentUrl })));
    attacker.importReceipt(JSON.stringify(client.receipt));
    await expect(attacker.submit()).rejects.toThrow();
  }
  const wrong = new WebPurchaseClient(storage(), () => Promise.resolve(Response.json({ ...original, id: crypto.randomUUID() })));
  wrong.importReceipt(JSON.stringify(client.receipt)); await expect(wrong.submit()).rejects.toThrow('不一致');
  expect(JSON.stringify(client.receipt)).not.toContain('paymentUrl');
});


it('调用浏览器 fetch 时不把订单客户端作为 this，避免 Illegal invocation', async () => {
  const client = new WebPurchaseClient(storage(), function(this: unknown) {
    expect(this).toBeUndefined();
    return Promise.resolve(Response.json({ available: false, currency: 'CNY', termStart: 'fulfillment', offers: [] }));
  });
  expect((await client.catalog()).available).toBe(false);
});

it('付款期限过后服务端确认原单关闭，网页换新凭据重新准备同一购买；原单未关闭时拒绝重新生成', async () => {
  let clock = Date.parse('2026-10-14T00:00:00Z'); let missing = false;
  const { service, send, checkout } = await setup(() => clock);
  const query = checkout.query.bind(checkout);
  vi.spyOn(checkout, 'query').mockImplementation((id, verifier) => query(id, verifier, () => {
    const body = JSON.stringify(missing ? { code: '40004', sub_code: 'ACQ.TRADE_NOT_EXIST' }
      : { code: '10000', out_trade_no: `TB_${id.replaceAll('-', '')}`, trade_no: '202610142200000000000001', trade_status: 'WAIT_BUYER_PAY', total_amount: '199.00' });
    return Promise.resolve(new Response(`{"alipay_trade_query_response":${body},"sign":"${sign('RSA-SHA256', Buffer.from(body), provider.privateKey).toString('base64')}"}`));
  }));
  const waiting = new WebPurchaseClient(storage(), send); waiting.prepare(request); const kept = await waiting.submit();
  await expect(waiting.restart()).rejects.toThrow('尚未关闭');
  expect(waiting.receipt?.orderId).toBe(kept.id);
  const client = new WebPurchaseClient(storage(), send); const original = client.prepare(request); const first = await client.submit();
  clock += 15 * 60000; missing = true;
  const next = await client.restart();
  expect(service.readDelivery(first.id, original.token).state).toBe('expired');
  expect(next).toMatchObject({ orderId: null, discardable: true, request }); expect(next.token).not.toBe(original.token);
  const second = await client.submit();
  expect(second.id).not.toBe(first.id); expect(second).toMatchObject({ state: 'pending', payable: true });
});
