import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { ServiceError } from './service';

const identity = z.string().regex(/^\d{16}$/);
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
  trade_status: z.enum(['TRADE_SUCCESS', 'TRADE_FINISHED', 'WAIT_BUYER_PAY', 'TRADE_CLOSED']),
  total_amount: z.string().regex(/^(0|[1-9]\d{0,6})(\.\d{1,2})?$/),
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
    const [yuan, fraction = ''] = notification.total_amount.split('.');
    const amountFen = Number(yuan) * 100 + Number(fraction.padEnd(2, '0'));
    if (amountFen < 1 || amountFen > 100_000_000) throw new ServiceError(400, 'INVALID_PAYMENT_AMOUNT', '支付金额超出订单范围');
    return { orderId: notification.out_trade_no, paymentReference: `alipay:${notification.trade_no}`, amountFen, appId: this.appId, sellerId: this.sellerId };
  }
}

const checkoutSchema = z.object({
  id: z.string().uuid(), amountFen: z.number().int().min(1).max(100_000_000),
  quantity: z.number().int().min(1).max(100), expiresAt: z.string().datetime()
}).strict();

/** 生成网站支付请求，本方法不请求支付宝、不扣款、不交付授权。 */
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
    const time = (value: number): string => new Date(value + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
    const params: Record<string, string> = {
      app_id: this.appId, method: 'alipay.trade.page.pay', format: 'JSON', charset: 'utf-8',
      sign_type: 'RSA2', timestamp: time(now), version: '1.0',
      notify_url: 'https://api.tuanbo-link.jinhefilm.com/v1/payments/alipay/notify',
      biz_content: JSON.stringify({ out_trade_no: `TB_${order.id.replaceAll('-', '')}`, product_code: 'FAST_INSTANT_TRADE_PAY',
        total_amount: (order.amountFen / 100).toFixed(2), subject: `团播联动台授权 ${order.quantity} 台`,
        goods_type: '0', qr_pay_mode: '2', time_expire: time(Date.parse(order.expiresAt)) })
    };
    // 请求签名包含 sign_type；通知验签排除它，两者不能共用同一拼串规则。
    const content = Object.keys(params).sort().map(name => `${name}=${params[name]}`).join('&');
    params.sign = sign('RSA-SHA256', Buffer.from(content, 'utf8'), this.key).toString('base64');
    return `https://openapi.alipay.com/gateway.do?${new URLSearchParams(params)}`;
  }
}
