import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { purchaseCatalogSchema, purchaseResponseSchema } from '@tb/schema';
import { LicensingService } from '../../../../licensing-server/src/service';
import { AlipayCheckout, AlipayNotifications } from '../../../../licensing-server/src/alipay';
import { createLicensingServer } from '../../../../licensing-server/src/http';
import { PurchaseService } from './purchase-service';

const now = Date.parse('2026-09-28T00:00:00Z');
const origin = 'https://api.tuanbo-link.jinhefilm.com';
const issuer = generateKeyPairSync('ed25519'); const provider = generateKeyPairSync('rsa', { modulusLength: 2048 });
const appId = '2026000000000001'; const sellerId = '2088000000000001';
const catalog = purchaseCatalogSchema.parse({ version: 1, maxOrderAmountFen: 10000, offers: [{
  id: 'test-only', revision: 'test-1', name: '测试商品', unitAmountFen: 100,
  kind: 'perpetual', useDays: null, updatesDays: 365, maxQuantity: 10, saleUntil: '2026-12-31T00:00:00Z'
}, { id: 'test-month', revision: 'test-1', name: '测试续费', unitAmountFen: 100,
  kind: 'subscription', useDays: 30, updatesDays: 30, maxQuantity: 1, saleUntil: '2026-12-31T00:00:00Z'
}] });
const request = { offerId: 'test-only', revision: 'test-1', quotedUnitAmountFen: 100, quantity: 2, customer: '测试企业', customerType: 'company' };
let service: LicensingService;
let server: ReturnType<typeof createLicensingServer>;
let base: string;
let data: Map<string, string>;
let queryStatus: 'WAIT_BUYER_PAY' | 'TRADE_SUCCESS';
let providerRequests = 0;
const storage = {
  hasCredential: (id: string) => Promise.resolve(data.has(id)),
  loadCredential: (id: string) => { const value = data.get(id); if (!value) throw new Error('不存在'); return Promise.resolve(value); },
  saveCredential: (id: string, value: string) => { data.set(id, value); return Promise.resolve(); }
};
const external = vi.fn<(url: string) => Promise<void>>();
const fetchLocal: typeof fetch = (input, options) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  expect(url.origin).toBe(origin);
  expect(options?.redirect).toBe('error');
  expect(options?.signal).toBeInstanceOf(AbortSignal);
  return fetch(`${base}${url.pathname}`, options);
};
function desktop(fetcher: typeof fetch = fetchLocal) { return new PurchaseService(origin, storage, external, fetcher, () => now); }
beforeEach(async () => {
  data = new Map(); external.mockReset(); external.mockResolvedValue(); queryStatus = 'WAIT_BUYER_PAY'; providerRequests = 0;
  service = new LicensingService(':memory:', issuer.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'test', randomBytes(32), () => now);
  const checkout = new AlipayCheckout(appId, sellerId, provider.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), () => now);
  const original = checkout.query.bind(checkout);
  vi.spyOn(checkout, 'query').mockImplementation((id, verifier) => original(id, verifier, () => {
    providerRequests++;
    const body = JSON.stringify({ code: '10000', out_trade_no: `TB_${id.replaceAll('-', '')}`, trade_no: '202609282200000000001234',
      trade_status: queryStatus, total_amount: (service.describeOrder(id).amountFen / 100).toFixed(2) });
    return Promise.resolve(new Response(`{"alipay_trade_query_response":${body},"sign":"${sign('RSA-SHA256', Buffer.from(body), provider.privateKey).toString('base64')}"}`));
  }));
  server = createLicensingServer(service, 'x'.repeat(48), new AlipayNotifications(appId, sellerId, provider.publicKey.export({ type: 'spki', format: 'pem' }).toString()), checkout, catalog);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('未监听');
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); service.close(); vi.restoreAllMocks(); });

it('桌面显式查询在缺失通知时补交付，重复查询不重复请求渠道或发码', async () => {
  const client = desktop(); const receipt = await client.create(request);
  queryStatus = 'TRADE_SUCCESS';
  const delivered = await client.refresh(receipt.localId);
  expect(delivered.delivery?.state).toBe('fulfilled'); expect(delivered.delivery?.licenses).toHaveLength(2);
  expect((await client.refresh(receipt.localId)).delivery?.licenses).toEqual(delivered.delivery?.licenses);
  expect(providerRequests).toBe(1); expect(external).not.toHaveBeenCalled();
});

async function pay(id: string, amount = '2.00') {
  const fields: Record<string, string> = { app_id: appId, seller_id: sellerId, out_trade_no: `TB_${id.replaceAll('-', '')}`,
    trade_no: '202609282200000000001234', charset: 'utf-8', notify_type: 'trade_status_sync', trade_status: 'TRADE_SUCCESS', total_amount: amount };
  const content = Object.keys(fields).sort().map(key => `${key}=${fields[key]}`).join('&');
  const body = new URLSearchParams({ ...fields, sign_type: 'RSA2', sign: sign('RSA-SHA256', Buffer.from(content), provider.privateKey).toString('base64') });
  const result = await fetch(`${base}/v1/payments/alipay/notify`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(5000) });
  expect(await result.text()).toBe('success');
}

it('桌面与真实本地服务贯通商品、下单、外部付款入口、通知和领取；IPC 不泄露领取凭据或付款链接', async () => {
  const client = desktop(); expect((await client.catalog()).available).toBe(true);
  const receipt = await client.create(request); expect(receipt.order?.amountFen).toBe(200);
  expect(JSON.stringify(receipt)).not.toMatch(/TBD-|gateway\.do|paymentUrl/);
  expect(JSON.stringify(await client.list())).not.toContain('TBD-');
  const saved = z.array(z.object({ token: z.string() })).parse(JSON.parse(data.get('license.purchases') ?? ''));
  expect(saved[0]?.token).toMatch(/^TBD-[A-F0-9]{64}$/);
  await client.openPayment(receipt.localId);
  expect(external).toHaveBeenCalledOnce(); expect(external.mock.calls[0]?.[0]).toMatch(/^https:\/\/openapi.alipay.com\/gateway.do\?/);
  const order = receipt.order; if (!order) throw new Error('未创建');
  await pay(order.id);
  const delivered = await client.refresh(receipt.localId);
  expect(delivered.delivery?.licenses).toHaveLength(2); expect(delivered.order?.payable).toBe(false);
  const license = delivered.delivery?.licenses[0]; if (!license?.code) throw new Error('未交付');
  expect(await client.code(receipt.localId, license.id)).toBe(license.code);
  await expect(client.code(receipt.localId, '9c8bab6c-2e5f-40d4-8327-9b8658ee0a53')).rejects.toThrow('未找到可复制');
  expect((await desktop().refresh(receipt.localId)).delivery?.licenses).toEqual(delivered.delivery?.licenses);
  await expect(client.openPayment(receipt.localId)).rejects.toThrow('不能再次付款');
  service.revoke(license.id, { reason: '测试撤销' });
  await client.refresh(receipt.localId);
  await expect(client.code(receipt.localId, license.id)).rejects.toThrow('未找到可复制');
  expect(external).toHaveBeenCalledOnce();
});

it('服务端建单后响应丢失，重启使用同一凭据恢复，不创建第二单或自动打开浏览器', async () => {
  let firstId = '';
  const lost: typeof fetch = async (input, options) => {
    expect(data.has('license.purchases')).toBe(true);
    const result = await fetchLocal(input, options);
    firstId = purchaseResponseSchema.parse(await result.json()).id;
    throw new Error('response lost');
  };
  await expect(desktop(lost).create(request)).rejects.toThrow('原购买记录已保留');
  const restored = desktop(); const [receipt] = await restored.list(); if (!receipt) throw new Error('凭据遗失');
  expect(receipt.order).toBeNull();
  await expect(restored.create(request)).rejects.toThrow('先恢复原订单');
  const recovered = await restored.refresh(receipt.localId);
  expect(recovered.order?.id).toBe(firstId); expect(recovered.delivery?.state).toBe('pending');
  expect(external).not.toHaveBeenCalled();
});

it('本地安全保存失败不请求服务器；收到订单后保存失败仍保留可恢复的初始凭据', async () => {
  const network = vi.fn(fetchLocal);
  const unavailable = { ...storage, saveCredential: () => Promise.reject(new Error('安全存储不可用')) };
  await expect(new PurchaseService(origin, unavailable, external, network).create(request)).rejects.toThrow('安全存储不可用');
  expect(network).not.toHaveBeenCalled();
  let writes = 0;
  const failOnce = { ...storage, saveCredential: (id: string, value: string) => ++writes === 2 ? Promise.reject(new Error('写入失败')) : storage.saveCredential(id, value) };
  await expect(new PurchaseService(origin, failOnce, external, network).create(request)).rejects.toThrow('写入失败');
  const client = desktop(); const [receipt] = await client.list(); if (!receipt) throw new Error('初始凭据遗失');
  expect((await client.refresh(receipt.localId)).order?.state).toBe('pending');
});

it('并发点击仅允许一次下单，显式价格拒绝后可重新选择商品', async () => {
  const client = desktop();
  const outcomes = await Promise.allSettled([client.create(request), client.create(request)]);
  expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter(item => item.status === 'rejected')).toHaveLength(1);
  expect(await client.list()).toHaveLength(1);
  data.clear();
  await expect(client.create({ ...request, quotedUnitAmountFen: 1 })).rejects.toThrow('商品价格或条款已变更');
  expect((await client.list())[0]?.rejected).toBe(true);
  expect((await client.create(request)).order?.state).toBe('pending');
});

it.each(['https://evil.example/pay', 'file:///tmp/payment', 'https://openapi.alipay.com.evil.example/gateway.do', 'https://openapi.alipay.com/gateway.do?method=alipay.trade.page.pay&return_url=https://evil.example'])('拒绝异常支付链接 %s', async paymentUrl => {
  const mutated: typeof fetch = async (input, options) => {
    const result = await fetchLocal(input, options);
    const purchase = purchaseResponseSchema.parse(await result.json());
    return Response.json({ ...purchase, paymentUrl });
  };
  const client = desktop(mutated); const receipt = await client.create(request);
  await expect(client.openPayment(receipt.localId)).rejects.toThrow('安全检查');
  expect(external).not.toHaveBeenCalled();
});

it('已知订单领取返回另一订单或错误金额时拒绝保存；过期凭据不能恢复', async () => {
  const client = desktop(); const receipt = await client.create(request); if (!receipt.order) throw new Error('未创建');
  const switched: typeof fetch = async (input, options) => {
    const result = await fetchLocal(input, options);
    const value = z.record(z.string(), z.unknown()).parse(await result.json());
    return Response.json({ ...value, amountFen: 1 });
  };
  await expect(desktop(switched).refresh(receipt.localId)).rejects.toThrow('交付信息与原订单不一致');
  expect((await client.list())[0]?.delivery).toBeNull();
  service.revokeDeliveryAccess(receipt.order.id, { reason: '测试撤销' });
  await expect(client.refresh(receipt.localId)).rejects.toThrow('领取凭据已过期或撤销');
  expect(external).not.toHaveBeenCalled();
});

it.each(['expiresAt', 'offer'] as const)('恢复原订单时拒绝改变已确认的 %s', async field => {
  let changed = false;
  const mutated: typeof fetch = async (input, options) => {
    const response = await fetchLocal(input, options);
    const value = purchaseResponseSchema.parse(await response.json());
    return Response.json(changed ? { ...value, ...(field === 'expiresAt' ? { expiresAt: '2026-09-28T01:00:00Z' } : { offer: { ...value.offer, updatesDays: 30 } }) } : value);
  };
  const client = desktop(mutated); const receipt = await client.create(request); changed = true;
  await expect(client.openPayment(receipt.localId)).rejects.toThrow('与已保存请求不一致');
  expect((await client.list())[0]?.order).toEqual(receipt.order);
  expect(external).not.toHaveBeenCalled();
});

it('系统浏览器启动无响应时限时返回，保留同一订单且不自动重试', async () => {
  let response: unknown;
  let saved = false;
  const fetcher: typeof fetch = async (input, options) => {
    if (saved) return Response.json(response);
    const result = await fetchLocal(input, options); response = await result.json(); saved = true;
    return Response.json(response);
  };
  const client = desktop(fetcher); const receipt = await client.create(request);
  external.mockImplementation(() => new Promise<void>(() => undefined));
  vi.useFakeTimers();
  try {
    const failure = expect(client.openPayment(receipt.localId)).rejects.toThrow('未能确认系统浏览器已打开');
    await vi.advanceTimersByTimeAsync(10001); await failure;
    expect((await client.list())[0]?.order?.id).toBe(receipt.order?.id);
    expect(external).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

it('拒绝重定向配置、超大或非 JSON 响应，不把 5xx 拒绝误判成未建单', async () => {
  expect(() => new PurchaseService('http://invalid.example', storage, external)).toThrow('HTTPS');
  const tooLarge: typeof fetch = () => Promise.resolve(new Response('x'.repeat(65537)));
  await expect(desktop(tooLarge).catalog()).rejects.toThrow('响应异常');
  const bad: typeof fetch = () => Promise.resolve(new Response('<html>closed</html>', { status: 404 }));
  await expect(desktop(bad).catalog()).rejects.toThrow('尚未开放');
  const unavailable: typeof fetch = () => Promise.resolve(Response.json({ code: 'OFFER_CHANGED' }, { status: 500 }));
  const client = desktop(unavailable);
  await expect(client.create(request)).rejects.toThrow();
  expect((await client.list())[0]?.rejected).toBe(false);
});

it('本机续费贯通私密认证头、丢失响应恢复、验签交付；不向界面暴露续费凭据或新码', async () => {
  const original = service.createOrder({ reference: 'renewal-fixture', customer: '测试企业', customerType: 'company', quantity: 1,
    kind: 'subscription', amountFen: 100, useUntil: new Date(now + 30 * 86400000).toISOString(), updatesUntil: new Date(now + 30 * 86400000).toISOString() });
  const license = service.fulfill(original.id, { amountFen: 100, paymentReference: 'manual:fixture' }).licenses[0]!;
  const authorization = { product: 'tuanbo-link-console' as const, code: license.code, machineCode: `TB1-${'A'.repeat(64)}` };
  service.activate(authorization);
  const renewal = { ...request, offerId: 'test-month', quantity: 1, renewalLicenseId: license.id };
  let id = '';
  const lost: typeof fetch = async (input, options) => {
    expect(new Headers(options?.headers).get('X-Tblink-Renewal-Code')).toBe(license.code);
    expect(data.has('license.purchases')).toBe(true);
    const response = await fetchLocal(input, options);
    id = purchaseResponseSchema.parse(await response.json()).id;
    throw new Error('lost response');
  };
  const getAuthorization = vi.fn((licenseId: string) => { expect(licenseId).toBe(license.id); return Promise.resolve(authorization); });
  const client = new PurchaseService(origin, storage, external, lost, () => now, getAuthorization);
  await expect(client.create(renewal)).rejects.toThrow('原购买记录已保留');
  expect(getAuthorization).toHaveBeenCalledOnce();
  const restored = desktop();
  const receipt = (await restored.list())[0]!;
  expect(JSON.stringify(receipt)).not.toMatch(/TBA-|TBD-|renewalAuthorization/);
  expect((await restored.refresh(receipt.localId)).order).toMatchObject({ id, renewalLicenseId: license.id });
  await restored.openPayment(receipt.localId);
  await pay(id, '1.00');
  const delivered = await restored.refresh(receipt.localId);
  expect(delivered.delivery).toMatchObject({ renewalLicenseId: license.id, state: 'fulfilled',
    useUntil: new Date(now + 60 * 86400000).toISOString(), licenses: [{ id: license.id, code: null, revoked: false }] });
  await expect(restored.code(receipt.localId, license.id)).rejects.toThrow('未找到可复制');
  expect(service.describeOrder(original.id).licenses[0]?.code).toBe(license.code);
});

it('缺失本机续费凭据时不保存购买、不发请求；服务端拒绝认证后可重新选择', async () => {
  const renewal = { ...request, offerId: 'test-month', quantity: 1, renewalLicenseId: '9c8bab6c-2e5f-40d4-8327-9b8658ee0a53' };
  const network = vi.fn(fetchLocal);
  await expect(new PurchaseService(origin, storage, external, network).create(renewal)).rejects.toThrow('续费凭据不可用');
  expect(network).not.toHaveBeenCalled(); expect(data.size).toBe(0);
  const client = new PurchaseService(origin, storage, external, network, () => now, () => Promise.resolve({ product: 'tuanbo-link-console', code: `TBA-${'B'.repeat(32)}`, machineCode: `TB1-${'A'.repeat(64)}` }));
  await expect(client.create(renewal)).rejects.toThrow('续费授权无效');
  expect((await client.list())[0]?.rejected).toBe(true);
  expect(external).not.toHaveBeenCalled();
});

it('已确认收款但续费被撤销时保存待处理提示，重启后仍禁止再次打开付款', async () => {
  const original = service.createOrder({ reference: 'pending-delivery-fixture', customer: request.customer, customerType: 'company', quantity: 1,
    kind: 'subscription', amountFen: 100, useUntil: new Date(now + 30 * 86400000).toISOString(), updatesUntil: new Date(now + 30 * 86400000).toISOString() });
  const license = service.fulfill(original.id, { amountFen: 100, paymentReference: 'manual:pending-fixture' }).licenses[0]!;
  const authorization = { product: 'tuanbo-link-console' as const, code: license.code, machineCode: `TB1-${'A'.repeat(64)}` };
  service.activate(authorization);
  const client = new PurchaseService(origin, storage, external, fetchLocal, () => now, () => Promise.resolve(authorization));
  const receipt = await client.create({ ...request, offerId: 'test-month', quantity: 1, renewalLicenseId: license.id });
  service.revoke(license.id, { reason: '建单后撤销，验证收款不丢失' });
  queryStatus = 'TRADE_SUCCESS';
  const pending = await client.refresh(receipt.localId);
  expect(pending.delivery).toMatchObject({ state: 'pending', paymentConfirmed: true, licenses: [] });
  expect(pending.order?.payable).toBe(false);
  expect((await desktop().list())[0]?.delivery?.paymentConfirmed).toBe(true);
  await expect(desktop().openPayment(receipt.localId)).rejects.toThrow('不要重复下单');
  expect(external).not.toHaveBeenCalled();
  expect(providerRequests).toBe(1);
});
