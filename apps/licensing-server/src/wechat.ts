import { createDecipheriv, createPrivateKey, createPublicKey, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { wechatCodeUrlSchema } from '../../../packages/schema/src/purchase';
import { ServiceError } from './service';

export const wechatIdentitySchema = z.object({ appId: z.string().regex(/^wx[a-zA-Z0-9]{16}$/), sellerId: z.string().regex(/^\d{8,32}$/) });
const transactionSchema = z.object({
  appid: wechatIdentitySchema.shape.appId, mchid: wechatIdentitySchema.shape.sellerId,
  out_trade_no: z.string().regex(/^[a-f0-9]{32}$/), trade_type: z.literal('NATIVE'),
  trade_state: z.enum(['SUCCESS', 'REFUND', 'NOTPAY', 'CLOSED', 'REVOKED', 'USERPAYING', 'PAYERROR']),
  transaction_id: z.string().regex(/^\d{16,64}$/).optional(),
  amount: z.object({ total: z.number().int().min(1).max(100_000_000), currency: z.literal('CNY') })
});
const orderId = (id: string): string => z.string().uuid().parse(id).replaceAll('-', '');
const uuid = (id: string): string => z.string().uuid().parse(`${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`);

/** 公钥模式；响应和通知均先验原始字节，只有 SUCCESS 可以交付。 */
export class WechatPay {
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  constructor(readonly appId: string, readonly sellerId: string, privateKey: string, private readonly serial: string,
    publicKey: string, private readonly publicKeyId: string, private readonly apiKey: Buffer,
    private readonly now: () => number = Date.now, private readonly send: typeof fetch = fetch) {
    wechatIdentitySchema.parse({ appId, sellerId });
    z.string().regex(/^[A-Fa-f0-9]{16,64}$/).parse(serial);
    z.string().regex(/^PUB_KEY_ID_\d{10,64}$/).parse(publicKeyId);
    if (apiKey.length !== 32) throw new Error('微信 APIv3 密钥必须为 32 字节');
    this.privateKey = createPrivateKey(privateKey); this.publicKey = createPublicKey(publicKey);
    for (const key of [this.privateKey, this.publicKey]) {
      if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength !== 2048) throw new Error('微信支付密钥必须为 2048 位 RSA');
    }
  }
  private verify(body: Buffer, headers: Headers): void {
    const timestamp = headers.get('Wechatpay-Timestamp') ?? '';
    const nonce = headers.get('Wechatpay-Nonce') ?? '';
    const signature = headers.get('Wechatpay-Signature') ?? '';
    const type = headers.get('Wechatpay-Signature-Type');
    if (headers.get('Wechatpay-Serial') !== this.publicKeyId || type !== null && type !== 'WECHATPAY2-SHA256-RSA2048'
      || !/^\d{10,12}$/.test(timestamp) || Math.abs(this.now() / 1000 - Number(timestamp)) > 300
      || !/^[\x21-\x7e]{1,128}$/.test(nonce) || !/^[A-Za-z0-9+/]{342}==$/.test(signature)
      || !verify('RSA-SHA256', Buffer.concat([Buffer.from(`${timestamp}\n${nonce}\n`), body, Buffer.from('\n')]), this.publicKey, Buffer.from(signature, 'base64'))) {
      throw new ServiceError(401, 'INVALID_PAYMENT_SIGNATURE', '微信支付报文验签失败，请核对公钥配置和服务器时间');
    }
  }
  private parse(body: Buffer): unknown {
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown; }
    catch { throw new ServiceError(502, 'INVALID_PAYMENT_RESPONSE', '微信支付报文格式无效'); }
  }
  private transaction(input: unknown, expectedId?: string) {
    const parsed = transactionSchema.safeParse(input);
    if (!parsed.success) throw new ServiceError(502, 'INVALID_PAYMENT_RESPONSE', '微信支付交易字段无效');
    const payment = parsed.data;
    if (payment.appid !== this.appId || payment.mchid !== this.sellerId) throw new ServiceError(409, 'PAYMENT_IDENTITY_MISMATCH', '微信支付商户或应用不匹配');
    const id = uuid(payment.out_trade_no);
    if (expectedId && id !== expectedId) throw new ServiceError(409, 'PAYMENT_ORDER_MISMATCH', '微信查单返回了其他订单');
    if (payment.trade_state === 'SUCCESS' && !payment.transaction_id) throw new ServiceError(502, 'INVALID_PAYMENT_RESPONSE', '微信成功交易缺少流水号');
    return { orderId: id, appId: this.appId, sellerId: this.sellerId, status: payment.trade_state,
      amountFen: payment.amount.total, paymentReference: payment.transaction_id ? `wechat:${payment.transaction_id}` : '' };
  }
  notification(body: Buffer, headers: Headers) {
    this.verify(body, headers);
    const envelope = z.object({ event_type: z.literal('TRANSACTION.SUCCESS'), resource_type: z.literal('encrypt-resource'),
      resource: z.object({ algorithm: z.literal('AEAD_AES_256_GCM'), original_type: z.literal('transaction'),
        ciphertext: z.string().min(24).max(16384).regex(/^[A-Za-z0-9+/]+={0,2}$/), nonce: z.string().length(12), associated_data: z.string().max(16).optional() }) }).safeParse(this.parse(body));
    if (!envelope.success) throw new ServiceError(400, 'INVALID_PAYMENT_NOTIFICATION', '微信通知不是可处理的支付成功报文');
    const resource = envelope.data.resource;
    const ciphertext = Buffer.from(resource.ciphertext, 'base64');
    let plaintext: Buffer;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.apiKey, Buffer.from(resource.nonce));
      decipher.setAuthTag(ciphertext.subarray(-16)); decipher.setAAD(Buffer.from(resource.associated_data ?? ''));
      plaintext = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
    } catch { throw new ServiceError(401, 'INVALID_PAYMENT_ENCRYPTION', '微信通知解密失败'); }
    const payment = this.transaction(this.parse(plaintext));
    if (payment.status !== 'SUCCESS') throw new ServiceError(409, 'PAYMENT_NOT_SETTLED', '微信交易未成功，不能发码');
    return payment;
  }
  private async request(method: 'POST' | 'GET', path: string, input?: unknown): Promise<unknown> {
    const body = input === undefined ? '' : JSON.stringify(input);
    const timestamp = String(Math.floor(this.now() / 1000)); const nonce = randomBytes(16).toString('hex');
    const signature = sign('RSA-SHA256', Buffer.from(`${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`), this.privateKey).toString('base64');
    try {
      const response = await this.send(`https://api.mch.weixin.qq.com${path}`, {
        method, headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Wechatpay-Serial': this.publicKeyId,
          Authorization: `WECHATPAY2-SHA256-RSA2048 mchid="${this.sellerId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${this.serial}",signature="${signature}"` },
        ...(method === 'POST' ? { body } : {}), redirect: 'error', signal: AbortSignal.timeout(8000)
      });
      if (!response.body) throw new ServiceError(502, 'INVALID_PAYMENT_RESPONSE', '微信支付响应为空');
      const chunks: Uint8Array[] = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 65536) throw new ServiceError(502, 'INVALID_PAYMENT_RESPONSE', '微信支付响应超过大小限制');
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks); this.verify(bytes, response.headers);
      if (!response.ok) throw new ServiceError(502, 'WECHAT_REQUEST_UNCONFIRMED', '微信尚未确认本次请求，请保留凭据并查询原订单');
      return this.parse(bytes);
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(502, 'WECHAT_REQUEST_UNCONFIRMED', '微信支付网络异常或超时，请保留凭据并查询原订单');
    }
  }
  async create(input: { id: string; amountFen: number; quantity: number; expiresAt: string }): Promise<string> {
    const order = z.object({ id: z.string().uuid(), amountFen: z.number().int().min(1).max(100_000_000),
      quantity: z.number().int().min(1).max(100), expiresAt: z.string().datetime() }).parse(input);
    const remaining = Date.parse(order.expiresAt) - this.now();
    if (remaining < 60000 || remaining > 7 * 86400000) throw new ServiceError(409, 'PAYMENT_LINK_EXPIRED', '微信付款入口已过期，请查询原订单');
    const response = await this.request('POST', '/v3/pay/transactions/native', {
      appid: this.appId, mchid: this.sellerId, out_trade_no: orderId(order.id),
      description: `团播联动台授权 ${order.quantity} 台`, time_expire: order.expiresAt.replace(/\.\d{3}Z$/, '+00:00'),
      notify_url: 'https://api.tuanbo-link.jinhefilm.com/v1/payments/wechat/notify', amount: { total: order.amountFen, currency: 'CNY' }
    });
    const parsed = z.object({ code_url: wechatCodeUrlSchema }).safeParse(response);
    if (!parsed.success) throw new ServiceError(502, 'INVALID_PAYMENT_RESPONSE', '微信付款二维码地址无效');
    return parsed.data.code_url;
  }
  async query(id: string) {
    return this.transaction(await this.request('GET', `/v3/pay/transactions/out-trade-no/${orderId(id)}?mchid=${this.sellerId}`), id);
  }
}
