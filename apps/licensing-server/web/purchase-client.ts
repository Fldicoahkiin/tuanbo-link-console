import { z } from 'zod';
import { purchaseCatalogResponseSchema, purchaseDeliverySchema, purchaseRequestSchema, purchaseResponseSchema, wechatCodeUrlSchema, paymentChannelSchema, type PaymentChannel, type PurchaseRequest } from '../../../packages/schema/src/purchase';

const receiptFields = z.object({ product: z.literal('tuanbo-link-console'),
  createdAt: z.string().datetime(), token: z.string().regex(/^TBD-[A-F0-9]{64}$/),
  request: purchaseRequestSchema.refine(value => value.renewalLicenseId === undefined, '请在原电脑的软件内续费'),
  orderId: z.string().uuid().nullable(), discardable: z.boolean().default(false)
}).strict();
export const webReceiptSchema = z.discriminatedUnion('version', [
  receiptFields.extend({ version: z.literal(1) }),
  receiptFields.extend({ version: z.literal(2), paymentChannel: z.literal('wechat') })
]);
export type WebReceipt = z.infer<typeof webReceiptSchema>;
const storageKey = 'tblink.purchase.receipt';
const paymentSchema = purchaseResponseSchema.refine(value => {
  if (value.paymentUrl === null) return true;
  const url = new URL(value.paymentUrl);
  return url.origin === 'https://openapi.alipay.com' && url.pathname === '/gateway.do' && !url.username && !url.password && !url.hash;
}, '付款地址不是支付宝正式网关');
const errorSchema = z.object({ code: z.string(), message: z.string().max(300), orderId: z.string().uuid().optional() });
class OrderResponseError extends Error {
  constructor(readonly code: string, message: string, readonly orderId?: string) { super(message); }
}

export class WebPurchaseClient {
  private current: WebReceipt | null = null;
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, private readonly send: typeof fetch = fetch) {}

  restore(): WebReceipt | null {
    const raw = this.storage.getItem(storageKey);
    this.current = raw === null ? null : webReceiptSchema.parse(JSON.parse(raw) as unknown);
    return this.receipt;
  }

  get receipt(): WebReceipt | null { return this.current === null ? null : structuredClone(this.current); }

  importReceipt(raw: string): WebReceipt {
    if (raw.length > 32768) throw new Error('订单凭据超过大小限制');
    const receipt = webReceiptSchema.parse(JSON.parse(raw) as unknown);
    if (this.current && this.current.token !== receipt.token) throw new Error('当前还有另一笔订单，请先在另一个标签页恢复此凭据');
    receipt.discardable = false;
    this.persist(receipt);
    return structuredClone(receipt);
  }

  prepare(input: PurchaseRequest, channel: PaymentChannel = 'alipay'): WebReceipt {
    paymentChannelSchema.parse(channel);
    if (this.current) throw new Error('当前订单尚未结束，请先查询或恢复原订单');
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const receipt = webReceiptSchema.parse({ ...(channel === 'wechat' ? { version: 2, paymentChannel: channel } : { version: 1 }), product: 'tuanbo-link-console', createdAt: new Date().toISOString(),
      token: `TBD-${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase()}`, request: input, orderId: null, discardable: true });
    this.persist(receipt);
    return structuredClone(receipt);
  }

  private persist(receipt: WebReceipt): void {
    // Persist before every network mutation. A failed write must leave the request unsent.
    this.storage.setItem(storageKey, JSON.stringify(receipt));
    this.current = receipt;
  }

  private async api(path: string, init: RequestInit = {}): Promise<unknown> {
    const send = this.send;
    const response = await send(path, { ...init, credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(12000) });
    if (path === '/v1/catalog' && new Headers(init.headers).get('X-Tblink-Payment-Channel') === 'wechat'
      && response.headers.get('X-Tblink-Payment-Channel') !== 'wechat') throw new Error('微信付款尚未开放，请选择支付宝或稍后重试');
    const body: unknown = await response.json();
    if (!response.ok) {
      const error = errorSchema.safeParse(body);
      if (error.success) throw new OrderResponseError(error.data.code, error.data.message, error.data.orderId);
      throw new Error(`订单服务返回 ${response.status}，请保留凭据后查询原单`);
    }
    return body;
  }

  async catalog(channel: PaymentChannel = 'alipay') {
    return purchaseCatalogResponseSchema.parse(await this.api('/v1/catalog', { headers: { 'X-Tblink-Payment-Channel': paymentChannelSchema.parse(channel) } }));
  }

  async submit() {
    const receipt = this.receipt;
    if (!receipt) throw new Error('请先准备并保存订单凭据');
    this.persist({ ...receipt, discardable: false });
    let body: unknown;
    try { body = await this.api('/v1/orders', { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: `Bearer ${receipt.token}`,
      'X-Tblink-Payment-Channel': receipt.version === 2 ? 'wechat' : 'alipay'
    }, body: JSON.stringify(receipt.request) }); }
    catch (error) {
      if (receipt.version === 2 && error instanceof OrderResponseError && error.orderId) {
        if (receipt.orderId !== null && receipt.orderId !== error.orderId) throw new Error('渠道返回的原订单编号不一致，请保留凭据并联系支持');
        this.persist({ ...receipt, orderId: error.orderId, discardable: false });
      }
      // These codes occur only when no order exists for this token. Unknown failures retain the original receipt.
      if (receipt.orderId === null && error instanceof OrderResponseError && !error.orderId && ['OFFER_CHANGED', 'QUANTITY_LIMIT', 'PAYMENTS_UNAVAILABLE'].includes(error.code)) this.persist({ ...receipt, discardable: true });
      throw error;
    }
    const result = receipt.version === 2 ? purchaseResponseSchema.refine(value => value.paymentUrl === null || wechatCodeUrlSchema.safeParse(value.paymentUrl).success, '微信二维码地址无效').parse(body) : paymentSchema.parse(body);
    if (result.offer.id !== receipt.request.offerId || result.offer.revision !== receipt.request.revision
      || result.offer.unitAmountFen !== receipt.request.quotedUnitAmountFen || result.quantity !== receipt.request.quantity
      || result.renewalLicenseId !== undefined || receipt.orderId !== null && result.id !== receipt.orderId) {
      throw new Error('返回的订单与原购买信息不一致，请保留凭据并联系支持');
    }
    this.persist({ ...receipt, orderId: result.id, discardable: false });
    return result;
  }

  async delivery(reconcile = false) {
    const receipt = this.receipt;
    if (!receipt?.orderId) throw new Error('请先恢复原订单');
    const result = purchaseDeliverySchema.parse(await this.api(`/v1/orders/${receipt.orderId}${reconcile ? '/reconcile' : ''}`, {
      headers: { Authorization: `Bearer ${receipt.token}`, ...(reconcile ? { 'Content-Type': 'application/json' } : {}) },
      ...(reconcile ? { method: 'POST', body: '{}' } : {})
    }));
    if (result.id !== receipt.orderId || result.amountFen !== receipt.request.quantity * receipt.request.quotedUnitAmountFen
      || result.quantity !== receipt.request.quantity || result.renewalLicenseId !== undefined) throw new Error('交付与原订单不一致，请联系支持');
    return result;
  }

  /** 付款入口过期后经服务端查单确认原单关闭且未收款，才换新凭据为同一购买请求准备新订单。 */
  async restart(): Promise<WebReceipt> {
    const receipt = this.receipt;
    if (!receipt?.orderId) throw new Error('请先恢复原订单');
    const delivery = await this.delivery(true);
    if (delivery.state === 'fulfilled') throw new Error('原订单已付款，请点击查询并领取激活码，不要重复购买');
    if (delivery.state === 'pending') throw new Error(delivery.paymentConfirmed ? '原订单付款已确认，授权待处理，请联系支持；无需再次付款' : '原订单尚未关闭，仍可能到账；请稍后再试，不要重复付款');
    this.storage.removeItem(storageKey); this.current = null;
    return this.prepare(receipt.request, receipt.version === 2 ? 'wechat' : 'alipay');
  }

  discard(): void {
    if (!this.current?.discardable || this.current.orderId !== null) throw new Error('原订单状态尚未确认，不能重新下单');
    this.storage.removeItem(storageKey); this.current = null;
  }

  async finish(): Promise<void> {
    const delivery = await this.delivery();
    if (delivery.state !== 'fulfilled') throw new Error('订单尚未交付，请继续查询原订单');
    this.storage.removeItem(storageKey);
    this.current = null;
  }
}
