import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { ServiceError } from './service';

const identity = z.string().regex(/^\d{16}$/);
const amount = z.string().regex(/^(0|[1-9]\d{0,6})(\.\d{1,2})?$/);
const tradeStatus = z.enum(['TRADE_SUCCESS', 'TRADE_FINISHED', 'WAIT_BUYER_PAY', 'TRADE_CLOSED']);
const channelOrderId = (id: string): string => `TB_${z.string().uuid().parse(id).replaceAll('-', '')}`;
const time = (value: number): string => new Date(value + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
function amountFen(value: string): number {
  const [yuan, fraction = ''] = amount.parse(value).split('.');
  return Number(yuan) * 100 + Number(fraction.padEnd(2, '0'));
}
// 新请求用渠道允许的字母、数字、下划线；既有通知契约的 UUID 仍须能验签处理。
const orderId = z.union([z.string().uuid(), z.string().regex(/^TB_[a-f0-9]{32}$/).transform(value => {
  const id = value.slice(3);
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}).pipe(z.string().uuid())]);
const notificationSchema = z.object({
  app_id: identity, seller_id: identity, out_trade_no: orderId,
  trade_no: z.string().regex(/^\d{16,64}$/), sign_type: z.literal('RSA2'),
  charset: z.string().refine(value => value.toLowerCase() === 'utf-8'),
  notify_type: z.literal('trade_status_sync'),
  trade_status: tradeStatus,
  total_amount: amount,
  sign: z.string().min(100).max(1400).regex(/^[A-Za-z0-9+/]+={0,2}$/)
});

/** Alipay website-payment RSA2 notifications: decode the form once, then verify every field. */
export class AlipayNotifications {
  private readonly key: KeyObject;
  constructor(private readonly appId: string, private readonly sellerId: string, publicKey: string) {
    identity.parse(appId); identity.parse(sellerId);
    this.key = createPublicKey(publicKey);
    if (this.key.asymmetricKeyType !== 'rsa' || (this.key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error('支付宝验签公钥必须为至少 2048 位 RSA 公钥');
  }
  verify(body: Buffer): { orderId: string; paymentReference: string; amountFen: number; appId: string; sellerId: string } {
    let form: URLSearchParams;
    try { form = new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
    catch { throw new ServiceError(400, 'INVALID_FORM', '支付通知编码无效'); }
    const fields: Record<string, string> = {};
    for (const [name, value] of form) {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(name) || Object.hasOwn(fields, name)) throw new ServiceError(400, 'INVALID_FORM', '支付通知存在无效或重复字段');
      Object.defineProperty(fields, name, { value, enumerable: true });
    }
    const notification = notificationSchema.parse(fields);
    // Keep unknown provider fields in the signature; never decode their values a second time.
    const signed = Object.keys(fields).filter(name => name !== 'sign' && name !== 'sign_type').sort().map(name => `${name}=${fields[name]}`).join('&');
    if (!verify('RSA-SHA256', Buffer.from(signed, 'utf8'), this.key, Buffer.from(notification.sign, 'base64'))) throw new ServiceError(401, 'INVALID_PAYMENT_SIGNATURE', '支付通知验签失败');
    if (notification.app_id !== this.appId || notification.seller_id !== this.sellerId) throw new ServiceError(409, 'PAYMENT_IDENTITY_MISMATCH', '支付通知商户或应用不匹配');
    if (notification.trade_status !== 'TRADE_SUCCESS' && notification.trade_status !== 'TRADE_FINISHED') throw new ServiceError(409, 'PAYMENT_NOT_SETTLED', '通知不是支付成功状态，不能发码');
    if (fields.refund_fee && !/^0(\.0{1,2})?$/.test(fields.refund_fee)) throw new ServiceError(409, 'PAYMENT_REFUNDED', '含退款的通知需要先核对退款状态');
    if (fields.trans_currency && fields.trans_currency !== 'CNY') throw new ServiceError(409, 'PAYMENT_CURRENCY_MISMATCH', '仅接受人民币订单');
    const total = amountFen(notification.total_amount);
    if (total < 1 || total > 100_000_000) throw new ServiceError(400, 'INVALID_PAYMENT_AMOUNT', '支付金额超出订单范围');
    return { orderId: notification.out_trade_no, paymentReference: `alipay:${notification.trade_no}`, amountFen: total, appId: this.appId, sellerId: this.sellerId };
  }
  /** 公钥模式只接收 response + sign 信封。仅解析验签覆盖的原始对象，禁止重序列化后验签。 */
  private signedResponse(body: string, method: 'alipay.trade.query' | 'alipay.trade.close') {
    const label = method === 'alipay.trade.query' ? '查单' : '关单';
    const envelope = new RegExp(`^\\s*\\{\\s*"${method.replaceAll('.', '_')}_response"\\s*:\\s*(\\{[\\s\\S]*\\})\\s*,\\s*"sign"\\s*:\\s*"([A-Za-z0-9+/]+={0,2})"\\s*\\}\\s*$`).exec(body);
    if (!envelope || !verify('RSA-SHA256', Buffer.from(envelope[1]!, 'utf8'), this.key, Buffer.from(envelope[2]!, 'base64'))) throw new ServiceError(502, 'INVALID_PAYMENT_SIGNATURE', `支付宝${label}响应验签失败`);
    let data: unknown;
    try { data = JSON.parse(envelope[1]!) as unknown; }
    catch { throw new ServiceError(502, 'INVALID_PAYMENT_RESPONSE', `支付宝${label}响应格式无效`); }
    const result = z.object({ code: z.string(), sub_code: z.string().optional() }).safeParse(data);
    return { data, code: result.success ? result.data.code : null, subCode: result.success ? result.data.sub_code : undefined };
  }
  verifyQuery(body: string, expectedId: string) {
    const { data, code, subCode } = this.signedResponse(body, 'alipay.trade.query');
    // 买家未打开收银台时渠道无交易；只有已验签的明确业务结果才能用于关单。
    if (code === '40004' && subCode === 'ACQ.TRADE_NOT_EXIST') return { orderId: expectedId, status: 'TRADE_NOT_EXIST' as const, appId: this.appId, sellerId: this.sellerId };
    if (code !== '10000') throw new ServiceError(502, 'PAYMENT_QUERY_UNCONFIRMED', '支付宝尚未返回可确认的交易结果，请核对渠道后重试');
    const parsed = z.object({
      out_trade_no: z.string(), trade_no: z.string().regex(/^\d{16,64}$/), trade_status: tradeStatus,
      total_amount: amount, trans_currency: z.literal('CNY').optional(),
      app_id: identity.optional(), seller_id: identity.optional(), refund_fee: amount.optional(),
      additional_status: z.string().optional()
    }).safeParse(data);
    if (!parsed.success) throw new ServiceError(502, 'INVALID_PAYMENT_RESPONSE', '支付宝查单响应字段无效');
    const payment = parsed.data;
    if (payment.out_trade_no !== channelOrderId(expectedId)) throw new ServiceError(409, 'PAYMENT_ORDER_MISMATCH', '查单返回了其他订单');
    if (payment.app_id && payment.app_id !== this.appId || payment.seller_id && payment.seller_id !== this.sellerId) throw new ServiceError(409, 'PAYMENT_IDENTITY_MISMATCH', '查单返回的商户或应用不匹配');
    if (payment.refund_fee && amountFen(payment.refund_fee) !== 0) throw new ServiceError(409, 'PAYMENT_REFUNDED', '交易涉及退款，须先核对退款状态');
    if (payment.additional_status) throw new ServiceError(409, 'PAYMENT_REQUIRES_REVIEW', '交易存在附加状态，须先核对收款状态');
    const total = amountFen(payment.total_amount);
    if (total < 1 || total > 100_000_000) throw new ServiceError(502, 'INVALID_PAYMENT_AMOUNT', '查单金额超出订单范围');
    return { orderId: expectedId, status: payment.trade_status, paymentReference: `alipay:${payment.trade_no}`, amountFen: total, appId: this.appId, sellerId: this.sellerId };
  }
  verifyClose(body: string, expectedId: string): void {
    const { data, code } = this.signedResponse(body, 'alipay.trade.close');
    if (code !== '10000') throw new ServiceError(502, 'PAYMENT_CLOSE_UNCONFIRMED', '支付宝未确认关闭原交易，订单保持待付款，请稍后再查询');
    const closed = z.object({ out_trade_no: z.string().optional() }).safeParse(data);
    if (!closed.success || closed.data.out_trade_no !== undefined && closed.data.out_trade_no !== channelOrderId(expectedId)) throw new ServiceError(409, 'PAYMENT_ORDER_MISMATCH', '关单返回了其他订单');
  }
}

const checkoutSchema = z.object({
  id: z.string().uuid(), amountFen: z.number().int().min(1).max(100_000_000),
  quantity: z.number().int().min(1).max(100), expiresAt: z.string().datetime()
}).strict();

/** 网站支付、主动查单与关单；只向固定支付宝网关发送签名请求，不在适配器中交付授权。 */
export class AlipayCheckout {
  private readonly key: KeyObject;
  constructor(readonly appId: string, readonly sellerId: string, privateKey: string, private readonly now: () => number = Date.now) {
    identity.parse(appId); identity.parse(sellerId);
    this.key = createPrivateKey(privateKey);
    if (this.key.asymmetricKeyType !== 'rsa' || (this.key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error('支付宝请求私钥必须为至少 2048 位 RSA 私钥');
  }
  createUrl(input: unknown): string {
    const order = checkoutSchema.parse(input);
    const now = this.now();
    if (Date.parse(order.expiresAt) - now < 60000) throw new ServiceError(409, 'PAYMENT_LINK_EXPIRED', '付款入口已过期，请先核对原订单是否已付款');
    const params = this.signedParams('alipay.trade.page.pay',
      { out_trade_no: channelOrderId(order.id), product_code: 'FAST_INSTANT_TRADE_PAY',
        total_amount: (order.amountFen / 100).toFixed(2), subject: `团播联动台授权 ${order.quantity} 台`,
        goods_type: '0', qr_pay_mode: '2', time_expire: time(Date.parse(order.expiresAt)) },
      { notify_url: 'https://api.tuanbo-link.jinhefilm.com/v1/payments/alipay/notify' });
    return `https://openapi.alipay.com/gateway.do?${new URLSearchParams(params)}`;
  }
  private signedParams(method: string, business: Record<string, string>, extra: Record<string, string> = {}): Record<string, string> {
    const params: Record<string, string> = { app_id: this.appId, method, format: 'JSON', charset: 'utf-8',
      sign_type: 'RSA2', timestamp: time(this.now()), version: '1.0', ...extra, biz_content: JSON.stringify(business) };
    // 请求签名包含 sign_type；通知验签排除它，两者不能共用同一拼串规则。
    const content = Object.keys(params).sort().map(name => `${name}=${params[name]}`).join('&');
    params.sign = sign('RSA-SHA256', Buffer.from(content, 'utf8'), this.key).toString('base64');
    return params;
  }
  private async call(method: 'alipay.trade.query' | 'alipay.trade.close', id: string, request: typeof fetch): Promise<string> {
    const label = method === 'alipay.trade.query' ? '查单' : '关单';
    const { biz_content: business, ...params } = this.signedParams(method, { out_trade_no: channelOrderId(id) });
    try {
      const response = await request(`https://openapi.alipay.com/gateway.do?${new URLSearchParams(params)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8', Accept: 'application/json' },
        body: new URLSearchParams({ biz_content: business! }), redirect: 'error', signal: AbortSignal.timeout(8000)
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new ServiceError(502, 'PAYMENT_QUERY_FAILED', `支付宝${label}失败，订单保持原状态`);
      }
      const chunks: Uint8Array[] = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 65536) throw new ServiceError(502, 'INVALID_PAYMENT_RESPONSE', `支付宝${label}响应超过大小限制`);
        chunks.push(chunk);
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(502, 'PAYMENT_QUERY_FAILED', `支付宝${label}超时或网络异常，订单保持原状态`);
    }
  }
  async query(id: string, notifications: AlipayNotifications, request: typeof fetch = fetch) {
    return notifications.verifyQuery(await this.call('alipay.trade.query', id, request), id);
  }
  async close(id: string, notifications: AlipayNotifications, request: typeof fetch = fetch): Promise<void> {
    notifications.verifyClose(await this.call('alipay.trade.close', id, request), id);
  }
}
