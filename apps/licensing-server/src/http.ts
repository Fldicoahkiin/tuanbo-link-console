import { createServer, type IncomingMessage } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { LicensingService, ServiceError } from './service';
import type { AlipayCheckout, AlipayNotifications } from './alipay';
import { purchaseCatalogSchema, type PurchaseCatalog } from '../../../packages/schema/src/purchase';
import { clientAddress } from './client-address';

async function readBytes(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const buffer = z.instanceof(Buffer).parse(chunk); size += buffer.length;
    if (size > 16384) throw new ServiceError(413, 'BODY_TOO_LARGE', '请求超过大小限制');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new ServiceError(415, 'CONTENT_TYPE', '需要 application/json');
  const body = await readBytes(request);
  try { return JSON.parse(body.toString('utf8')) as unknown; }
  catch { throw new ServiceError(400, 'INVALID_JSON', 'JSON 格式无效'); }
}

export function createLicensingServer(service: LicensingService, adminToken: string, alipay?: AlipayNotifications, checkout?: AlipayCheckout, purchaseCatalog?: PurchaseCatalog, trustLoopbackProxy = false) {
  if (adminToken.length < 32) throw new Error('后台访问令牌至少 32 位');
  if (checkout && !alipay) throw new Error('启用支付宝付款入口必须同时配置通知验签');
  const catalog = purchaseCatalog === undefined ? undefined : purchaseCatalogSchema.parse(purchaseCatalog);
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
  const expected = digest(`Bearer ${adminToken}`);
  const rates = new Map<string, { count: number; reset: number }>();
  return createServer({ requestTimeout: 10000, headersTimeout: 10000, maxHeaderSize: 8192 }, (request, response) => {
    const requestId = randomUUID();
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Request-Id', requestId);
    const dispatch = async (): Promise<unknown> => {
      const now = Date.now();
      for (const [key, value] of rates) if (value.reset <= now) rates.delete(key);
      const group = request.url === '/v1/payments/alipay/notify' ? 'alipay' : request.url === '/v1/orders' ? 'purchase' : request.url?.startsWith('/v1/orders/') ? 'delivery' : 'product';
      const address = `${clientAddress(request.socket.remoteAddress, request.headers['x-tblink-client-ip'], trustLoopbackProxy)}:${group}`;
      const rate = rates.get(address) ?? { count: 0, reset: now + 60000 };
      if (rates.size >= 10000 && !rates.has(address) || ++rate.count > (group === 'purchase' ? 10 : 120)) throw new ServiceError(429, 'RATE_LIMITED', '请求过于频繁，请稍后再试');
      rates.set(address, rate);
      if (request.method === 'GET' && request.url === '/health') return { status: 'ok' };
      if (request.method === 'POST' && request.url === '/v1/activate') return service.activate(await readBody(request));
      if (request.method === 'GET' && request.url === '/v1/catalog') {
        const offers = checkout && catalog ? service.listOffers(catalog) : [];
        return { available: offers.length > 0, currency: 'CNY', termStart: 'fulfillment', offers };
      }
      if (request.method === 'POST' && request.url === '/v1/orders') {
        const token = /^Bearer (TBD-[A-F0-9]{64})$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
        const purchase = service.createPurchase(await readBody(request), token, catalog, checkout, {
          product: 'tuanbo-link-console', code: request.headers['x-tblink-renewal-code'], machineCode: request.headers['x-tblink-machine-code']
        });
        const paymentUrl = purchase.payable && checkout ? checkout.createUrl({ id: purchase.id, amountFen: purchase.amountFen, quantity: purchase.quantity, expiresAt: purchase.expiresAt }) : null;
        return { ...purchase, paymentUrl };
      }
      const delivery = /^\/v1\/orders\/([a-f0-9-]{36})$/.exec(request.url ?? '');
      if (request.method === 'GET' && delivery) return service.readDelivery(delivery[1]!, /^Bearer (TBD-[A-F0-9]{64})$/.exec(request.headers.authorization ?? '')?.[1] ?? '');
      if (request.method === 'POST' && request.url === '/v1/payments/alipay/notify' && alipay) {
        if (!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) throw new ServiceError(415, 'CONTENT_TYPE', '需要 UTF-8 表单通知');
        const payment = alipay.verify(await readBytes(request));
        service.fulfill(payment.orderId, { paymentReference: payment.paymentReference, amountFen: payment.amountFen }, 'alipay', payment);
        return 'success';
      }
      if (!request.url?.startsWith('/admin/')) throw new ServiceError(404, 'NOT_FOUND', '接口不存在');
      if (!timingSafeEqual(digest(request.headers.authorization ?? ''), expected)) throw new ServiceError(401, 'UNAUTHORIZED', '后台认证失败');
      if (request.method === 'POST' && request.url === '/admin/orders') return service.createOrder(await readBody(request));
      const pay = /^\/admin\/orders\/([a-f0-9-]{36})\/payment-link$/.exec(request.url);
      if (request.method === 'POST' && pay) {
        z.object({}).strict().parse(await readBody(request));
        if (!checkout) throw new ServiceError(503, 'PAYMENTS_UNAVAILABLE', '支付宝付款入口尚未启用');
        const payment = service.prepareAlipayPayment(pay[1]!, checkout.appId, checkout.sellerId);
        return { ...payment, paymentUrl: checkout.createUrl(payment) };
      }
      const reconcile = /^\/admin\/orders\/([a-f0-9-]{36})\/reconcile$/.exec(request.url);
      if (request.method === 'POST' && reconcile) {
        z.object({}).strict().parse(await readBody(request));
        if (!checkout || !alipay) throw new ServiceError(503, 'PAYMENTS_UNAVAILABLE', '支付宝查单尚未启用');
        service.alipayQueryOrder(reconcile[1]!, checkout.appId, checkout.sellerId);
        const payment = await checkout.query(reconcile[1]!, alipay);
        return service.reconcileAlipay(reconcile[1]!, payment);
      }
      const deliveryAccess = /^\/admin\/orders\/([a-f0-9-]{36})\/delivery-access(\/revoke)?$/.exec(request.url);
      if (request.method === 'POST' && deliveryAccess) return deliveryAccess[2] ? service.revokeDeliveryAccess(deliveryAccess[1]!, await readBody(request)) : service.issueDeliveryAccess(deliveryAccess[1]!, await readBody(request));
      const order = /^\/admin\/orders\/([a-f0-9-]{36})(\/fulfill)?$/.exec(request.url);
      if (order) {
        if (request.method === 'GET' && !order[2]) return service.describeOrder(order[1]!);
        if (request.method === 'POST' && order[2]) return service.fulfill(order[1]!, await readBody(request));
      }
      const license = /^\/admin\/licenses\/([a-f0-9-]{36})\/(revoke|migrate)$/.exec(request.url);
      if (request.method === 'POST' && license) return license[2] === 'revoke' ? service.revoke(license[1]!, await readBody(request)) : service.migrate(license[1]!, await readBody(request));
      throw new ServiceError(404, 'NOT_FOUND', '接口不存在');
    };
    void dispatch().then(result => {
      if (result === 'success') { response.setHeader('Content-Type', 'text/plain; charset=utf-8'); response.end('success'); }
      else response.end(JSON.stringify(result));
    }).catch((error: unknown) => {
      const known = error instanceof ServiceError;
      response.statusCode = known ? error.status : error instanceof z.ZodError ? 400 : 500;
      if (response.statusCode === 500) console.error(JSON.stringify({ requestId, error: 'LICENSING_INTERNAL_ERROR' }));
      response.end(JSON.stringify({ code: known ? error.code : response.statusCode === 400 ? 'INVALID_REQUEST' : 'INTERNAL_ERROR', message: known ? error.message : response.statusCode === 400 ? '请求字段或期限无效' : '授权服务暂时不可用，请联系发行方', requestId }));
    });
  });
}
