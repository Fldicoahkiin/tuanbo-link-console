import { createServer, type IncomingMessage } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { LicensingService, ServiceError } from './service';
import type { AlipayCheckout, AlipayNotifications } from './alipay';
import { purchaseCatalogSchema, type PurchaseCatalog } from '../../../packages/schema/src/purchase';
import type { WechatPay } from './wechat';
import { clientAddress, rateBucket } from './client-address';
import { SourceRates } from './source-rates';
import { dispatchConsole, type ConsoleHttp } from './console-http';

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

export function createLicensingServer(service: LicensingService, adminToken: string, alipay?: AlipayNotifications, checkout?: AlipayCheckout, purchaseCatalog?: PurchaseCatalog, trustLoopbackProxy = false, wechat?: WechatPay, wechatCheckoutEnabled = false, consoleOptions?: ConsoleHttp) {
  if (adminToken.length < 32) throw new Error('后台访问令牌至少 32 位');
  if (checkout && !alipay) throw new Error('启用支付宝付款入口必须同时配置通知验签');
  if (wechatCheckoutEnabled && !wechat) throw new Error('启用微信付款必须同时配置签名、验签和解密凭据');
  const nativeRequests = new Set<string>();
  const catalog = purchaseCatalog === undefined ? undefined : purchaseCatalogSchema.parse(purchaseCatalog);
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
  const expected = digest(`Bearer ${adminToken}`);
  const rates = new SourceRates(10000);
  const paymentQueries = new Map<string, { until: number; running: boolean }>();
  return createServer({ requestTimeout: 10000, headersTimeout: 10000, maxHeaderSize: 8192 }, (request, response) => {
    const requestId = randomUUID();
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Request-Id', requestId);
    const deliver = (id: string, token: string, action: () => unknown) => {
      try { action(); }
      catch (error) {
        const delivery = service.readDelivery(id, token);
        if (!delivery.paymentConfirmed) throw error;
        console.error(JSON.stringify({ requestId, error: 'LICENSING_DELIVERY_PENDING', code: error instanceof ServiceError ? error.code : 'INTERNAL_ERROR' }));
        return delivery;
      }
      return service.readDelivery(id, token);
    };
    const dispatch = async (): Promise<unknown> => {
      const now = Date.now();
      const customerQuery = /^\/v1\/orders\/([a-f0-9-]{36})\/reconcile$/.exec(request.url ?? '');
      const group = request.url?.startsWith('/v1/payments/') ? 'payment-notify' : customerQuery ? 'payment-query' : request.url === '/v1/orders' ? 'purchase' : request.url?.startsWith('/v1/orders/') ? 'delivery' : 'product';
      const address = `${rateBucket(clientAddress(request.socket.remoteAddress, request.headers['x-tblink-client-ip'], trustLoopbackProxy))}:${group}`;
      // 渠道通知只靠验签把关：共享出口或计数表写满都不能拒收到账通知。
      if (group !== 'payment-notify' && rates.exceeded(address, group === 'purchase' || group === 'payment-query' ? 10 : 120, now)) throw new ServiceError(429, 'RATE_LIMITED', '请求过于频繁，请稍后再试');
      if (request.url?.startsWith('/console-api/')) {
        if (!consoleOptions) throw new ServiceError(404, 'NOT_FOUND', '接口不存在');
        return dispatchConsole(consoleOptions, request, response, requestId, address, () => readBody(request), async id => {
          if (service.paymentChannel(id) === 'wechat') {
            if (!wechat) throw new ServiceError(503, 'PAYMENTS_UNAVAILABLE', '微信查单尚未启用');
            service.wechatQueryOrder(id, wechat.appId, wechat.sellerId);
            return service.reconcileWechat(id, await wechat.query(id));
          }
          if (!checkout || !alipay) throw new ServiceError(503, 'PAYMENTS_UNAVAILABLE', '支付宝查单尚未启用');
          service.alipayQueryOrder(id, checkout.appId, checkout.sellerId);
          return service.reconcileAlipay(id, await checkout.query(id, alipay));
        });
      }
      if (request.method === 'GET' && request.url === '/health') return { status: 'ok' };
      if (request.method === 'POST' && request.url === '/v1/activate') return service.activate(await readBody(request));
      if (request.method === 'GET' && request.url === '/v1/catalog') {
        const channel = z.enum(['alipay', 'wechat']).parse(request.headers['x-tblink-payment-channel'] ?? 'alipay');
        response.setHeader('X-Tblink-Payment-Channel', channel);
        const enabled = channel === 'wechat' ? wechatCheckoutEnabled : Boolean(checkout);
        const offers = enabled && catalog ? service.listOffers(catalog) : [];
        return { available: offers.length > 0, currency: 'CNY', termStart: 'fulfillment', offers };
      }
      if (request.method === 'POST' && request.url === '/v1/orders') {
        const token = /^Bearer (TBD-[A-F0-9]{64})$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
        const channel = z.enum(['alipay', 'wechat']).parse(request.headers['x-tblink-payment-channel'] ?? 'alipay');
        const payment = channel === 'wechat' ? (wechatCheckoutEnabled ? wechat : undefined) : checkout;
        const input = await readBody(request);
        let purchase = service.createPurchase(input, token, catalog, payment, {
          product: 'tuanbo-link-console', code: request.headers['x-tblink-renewal-code'], machineCode: request.headers['x-tblink-machine-code']
        }, channel);
        if (channel === 'wechat') {
          let paymentUrl: string | null = null;
          if (purchase.payable && wechat) {
            if (nativeRequests.has(purchase.id) || nativeRequests.size >= 1000) throw new ServiceError(429, 'RATE_LIMITED', '原订单正在创建微信付款入口，请稍后恢复原单');
            nativeRequests.add(purchase.id);
            try {
              paymentUrl = service.wechatQueryOrder(purchase.id, wechat.appId, wechat.sellerId).codeUrl;
              if (!paymentUrl) {
                paymentUrl = await wechat.create({ id: purchase.id, amountFen: purchase.amountFen, quantity: purchase.quantity, expiresAt: purchase.expiresAt });
                service.saveWechatCodeUrl(purchase.id, wechat.appId, wechat.sellerId, paymentUrl);
              }
              service.readDelivery(purchase.id, token);
              // 通知可在渠道请求返回前到账；返回最新状态，不展示已收款订单的二维码。
              purchase = service.createPurchase(input, token, catalog, payment, undefined, channel);
            } catch (error) {
              if (error instanceof ServiceError) throw new ServiceError(error.status, error.code, error.message, purchase.id);
              throw error;
            } finally { nativeRequests.delete(purchase.id); }
          }
          return { ...purchase, paymentUrl: purchase.payable ? paymentUrl : null };
        }
        const paymentUrl = purchase.payable && checkout ? checkout.createUrl({ id: purchase.id, amountFen: purchase.amountFen, quantity: purchase.quantity, expiresAt: purchase.expiresAt }) : null;
        return { ...purchase, paymentUrl };
      }
      const delivery = /^\/v1\/orders\/([a-f0-9-]{36})$/.exec(request.url ?? '');
      if (request.method === 'GET' && delivery) return service.readDelivery(delivery[1]!, /^Bearer (TBD-[A-F0-9]{64})$/.exec(request.headers.authorization ?? '')?.[1] ?? '');
      if (request.method === 'POST' && customerQuery) {
        const id = customerQuery[1]!;
        const token = /^Bearer (TBD-[A-F0-9]{64})$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
        service.readDelivery(id, token);
        z.object({}).strict().parse(await readBody(request));
        const existing = service.readDelivery(id, token);
        if (existing.state === 'fulfilled') return existing;
        if (existing.paymentConfirmed) return deliver(id, token, () => service.retryDelivery(id, { reason: '客户持原凭据请求补交付' }));
        const channel = service.paymentChannel(id);
        if (channel === 'wechat') {
          if (!wechat) throw new ServiceError(503, 'PAYMENTS_UNAVAILABLE', '微信查单尚未启用，请保留原订单并联系支持');
          service.wechatQueryOrder(id, wechat.appId, wechat.sellerId);
        } else {
          if (!checkout || !alipay) throw new ServiceError(503, 'PAYMENTS_UNAVAILABLE', '支付宝查单尚未启用，请保留原订单并联系支持');
          service.alipayQueryOrder(id, checkout.appId, checkout.sellerId);
        }
        for (const [key, gate] of paymentQueries) if (!gate.running && gate.until <= now) paymentQueries.delete(key);
        if (paymentQueries.has(id) || paymentQueries.size >= 10000) throw new ServiceError(429, 'RATE_LIMITED', '原订单正在查询或刚完成查询，请十秒后手动重试');
        const gate = { until: now + 10000, running: true };
        paymentQueries.set(id, gate);
        try {
          if (channel === 'wechat' && wechat) {
            const payment = await wechat.query(id);
            service.readDelivery(id, token);
            return deliver(id, token, () => service.reconcileWechat(id, payment));
          }
          if (!checkout || !alipay) throw new ServiceError(503, 'PAYMENTS_UNAVAILABLE', '支付宝查单尚未启用');
          const payment = await checkout.query(id, alipay);
          // The credential may expire or be revoked while the channel request is in flight.
          service.readDelivery(id, token);
          return deliver(id, token, () => service.reconcileAlipay(id, payment));
        } finally { gate.running = false; gate.until = Date.now() + 10000; }
      }
      if (request.method === 'POST' && request.url === '/v1/payments/wechat/notify' && wechat) {
        if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) throw new ServiceError(415, 'CONTENT_TYPE', '需要 UTF-8 JSON 通知');
        const headers = new Headers();
        for (const name of ['wechatpay-timestamp', 'wechatpay-nonce', 'wechatpay-serial', 'wechatpay-signature', 'wechatpay-signature-type']) {
          const value = request.headers[name];
          if (typeof value === 'string') headers.set(name, value);
        }
        const payment = wechat.notification(await readBytes(request), headers);
        service.fulfill(payment.orderId, { paymentReference: payment.paymentReference, amountFen: payment.amountFen }, 'wechat', payment);
        return { code: 'SUCCESS', message: '成功' };
      }
      if (request.method === 'POST' && request.url === '/v1/payments/alipay/notify' && alipay) {
        if (!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) throw new ServiceError(415, 'CONTENT_TYPE', '需要 UTF-8 表单通知');
        const payment = alipay.verify(await readBytes(request));
        service.fulfill(payment.orderId, { paymentReference: payment.paymentReference, amountFen: payment.amountFen }, 'alipay', payment);
        return 'success';
      }
      if (!request.url?.startsWith('/admin/')) throw new ServiceError(404, 'NOT_FOUND', '接口不存在');
      if (!timingSafeEqual(digest(request.headers.authorization ?? ''), expected)) throw new ServiceError(401, 'UNAUTHORIZED', '后台认证失败');
      const exceptions = /^\/admin\/payment-exceptions(?:\?after=(0|[1-9]\d{0,15}))?$/.exec(request.url);
      if (request.method === 'GET' && exceptions) return service.paymentExceptions(Number(exceptions[1] ?? 0));
      const retry = /^\/admin\/orders\/([a-f0-9-]{36})\/retry-delivery$/.exec(request.url);
      if (request.method === 'POST' && retry) {
        const result = service.retryDelivery(retry[1]!, await readBody(request));
        return { id: result.id, state: result.state };
      }
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
        if (service.paymentChannel(reconcile[1]!) === 'wechat') {
          if (!wechat) throw new ServiceError(503, 'PAYMENTS_UNAVAILABLE', '微信查单尚未启用');
          service.wechatQueryOrder(reconcile[1]!, wechat.appId, wechat.sellerId);
          return service.reconcileWechat(reconcile[1]!, await wechat.query(reconcile[1]!));
        }
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
      if (response.writableEnded) return;
      if (result === 'success') { response.setHeader('Content-Type', 'text/plain; charset=utf-8'); response.end('success'); }
      else response.end(JSON.stringify(result));
    }).catch((error: unknown) => {
      const known = error instanceof ServiceError;
      response.statusCode = known ? error.status : error instanceof z.ZodError ? 400 : 500;
      if (response.statusCode === 500) console.error(JSON.stringify({ requestId, error: 'LICENSING_INTERNAL_ERROR' }));
      response.end(JSON.stringify({ code: known ? error.code : response.statusCode === 400 ? 'INVALID_REQUEST' : 'INTERNAL_ERROR', ...(known && error.orderId ? { orderId: error.orderId } : {}), message: known ? error.message : response.statusCode === 400 ? '请求字段或期限无效' : '授权服务暂时不可用，请联系发行方', requestId }));
    });
  });
}
