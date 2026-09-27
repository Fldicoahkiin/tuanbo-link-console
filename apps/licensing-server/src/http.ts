import { createServer, type IncomingMessage } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { LicensingService, ServiceError } from './service';
import type { AlipayNotifications } from './alipay';

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

export function createLicensingServer(service: LicensingService, adminToken: string, alipay?: AlipayNotifications) {
  if (adminToken.length < 32) throw new Error('后台访问令牌至少 32 位');
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
  const expected = digest(`Bearer ${adminToken}`);
  const rates = new Map<string, { count: number; reset: number }>();
  return createServer({ requestTimeout: 10000, headersTimeout: 10000, maxHeaderSize: 8192 }, (request, response) => {
    const requestId = randomUUID();
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Request-Id', requestId);
    const dispatch = async (): Promise<unknown> => {
      const now = Date.now();
      for (const [key, value] of rates) if (value.reset <= now) rates.delete(key);
      const address = `${request.socket.remoteAddress ?? 'unknown'}:${request.url === '/v1/payments/alipay/notify' ? 'alipay' : 'product'}`;
      const rate = rates.get(address) ?? { count: 0, reset: now + 60000 };
      if (rates.size >= 10000 && !rates.has(address) || ++rate.count > 120) throw new ServiceError(429, 'RATE_LIMITED', '请求过于频繁，请稍后再试');
      rates.set(address, rate);
      if (request.method === 'GET' && request.url === '/health') return { status: 'ok' };
      if (request.method === 'POST' && request.url === '/v1/activate') return service.activate(await readBody(request));
      if (request.method === 'POST' && request.url === '/v1/payments/alipay/notify' && alipay) {
        if (!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) throw new ServiceError(415, 'CONTENT_TYPE', '需要 UTF-8 表单通知');
        const payment = alipay.verify(await readBytes(request));
        service.fulfill(payment.orderId, { paymentReference: payment.paymentReference, amountFen: payment.amountFen }, 'alipay');
        return 'success';
      }
      if (!request.url?.startsWith('/admin/')) throw new ServiceError(404, 'NOT_FOUND', '接口不存在');
      if (!timingSafeEqual(digest(request.headers.authorization ?? ''), expected)) throw new ServiceError(401, 'UNAUTHORIZED', '后台认证失败');
      if (request.method === 'POST' && request.url === '/admin/orders') return service.createOrder(await readBody(request));
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
