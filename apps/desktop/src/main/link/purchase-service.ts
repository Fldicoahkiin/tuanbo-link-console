import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  alipayGateways, paymentEnvironmentHeader, paymentEnvironmentSchema, purchaseCatalogResponseSchema, purchaseDeliverySchema, purchaseOrderSchema, purchaseReceiptSchema,
  licenseActivationSchema, purchaseRequestSchema, purchaseResponseSchema, type PurchaseReceipt
} from '@tb/schema';
import type { SecureProfileStore } from './secure-profile-store';

const credentialId = 'license.purchases';
const storedReceiptSchema = purchaseReceiptSchema.extend({ token: z.string().regex(/^TBD-[A-F0-9]{64}$/),
  renewalAuthorization: licenseActivationSchema.optional()
}).refine(value => Boolean(value.request.renewalLicenseId) === Boolean(value.renewalAuthorization), '续费凭证和购买类型对不上');
const receiptsSchema = z.array(storedReceiptSchema).max(100);
type StoredReceipt = z.infer<typeof storedReceiptSchema>;
type Credentials = Pick<SecureProfileStore, 'hasCredential' | 'loadCredential' | 'saveCredential'>;
const responseErrorSchema = z.object({ code: z.string(), requestId: z.string().optional() });
const messages: Record<string, string> = {
  OFFER_CHANGED: '商品价格或条款有变化，请重新查看后再购买',
  QUANTITY_LIMIT: '选的电脑数量超过了购买上限',
  PAYMENTS_UNAVAILABLE: '暂时还不能购买，请联系售后',
  INVALID_DELIVERY_ACCESS: '领取凭证已过期或被撤销，请联系售后核对原订单',
  PURCHASE_CONFLICT: '和原来的购买请求对不上，请联系售后核对订单',
  INVALID_RENEWAL_AUTHORIZATION: '续费授权无效，请在原来绑定的电脑上检查激活码',
  RENEWAL_NOT_SUBSCRIPTION: '只能用订阅商品续费原订阅授权',
  RENEWAL_DETAILS_MISMATCH: '续费时客户信息要和原来一致，并且每次只能续一台电脑',
  PAYMENT_QUERY_FAILED: '查询支付宝订单超时或网络出错，原订单已保留，请稍后再查询',
  PAYMENT_QUERY_UNCONFIRMED: '支付宝还没确认这笔交易，请保留原订单，不要重复付款',
  PAYMENT_REFUNDED: '这笔订单涉及退款，请联系售后核对',
  PAYMENT_REQUIRES_REVIEW: '订单的收款状态需要人工核对，请联系售后',
  PAYMENT_CLOSE_UNCONFIRMED: '支付宝还没确认关闭原交易，原订单已保留，请稍后再查询，不要重复付款',
  RATE_LIMITED: '查询太频繁，请稍后再试'
};
class PurchaseResponseError extends Error {
  constructor(readonly code: string, readonly status: number) { super(messages[code] ?? `购买服务请求失败（${status}），请保留原订单，稍后再查询`); }
}
// 服务端经渠道确认原交易关闭或不存在且未收款，本机可另建新单。
const ended = (receipt: StoredReceipt): boolean => receipt.order?.state === 'closed' || receipt.order?.state === 'expired';

export class PurchaseService {
  private readonly origin: URL;
  private busy = false;
  constructor(serverUrl: string, private readonly credentials: Credentials,
    private readonly openExternal: (url: string) => Promise<void>, private readonly request: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly renewalAuthorization?: (licenseId: string) => Promise<z.infer<typeof licenseActivationSchema>>) {
    this.origin = new URL(serverUrl);
    if (this.origin.protocol !== 'https:' || this.origin.username || this.origin.password || this.origin.search || this.origin.hash || this.origin.pathname !== '/') throw new Error('购买服务器必须是固定的 HTTPS 域名');
  }
  private async load(): Promise<StoredReceipt[]> {
    if (!await this.credentials.hasCredential(credentialId)) return [];
    try { return receiptsSchema.parse(JSON.parse(await this.credentials.loadCredential(credentialId))); }
    catch { throw new Error('读不了本机的购买记录，没有创建新订单。请不要删除本机数据，并联系售后'); }
  }
  private async save(receipts: StoredReceipt[]): Promise<void> {
    await this.credentials.saveCredential(credentialId, JSON.stringify(receiptsSchema.parse(receipts)));
  }
  private summary(receipt: StoredReceipt): PurchaseReceipt {
    return purchaseReceiptSchema.strip().parse(receipt);
  }
  async list(): Promise<PurchaseReceipt[]> { return (await this.load()).map(receipt => this.summary(receipt)); }
  async code(localId: string, licenseId: string): Promise<string> {
    const receipt = this.find(await this.load(), localId);
    const id = z.string().uuid().parse(licenseId);
    const license = receipt.delivery?.state === 'fulfilled' ? receipt.delivery.licenses.find(item => item.id === id) : undefined;
    if (!license?.code || license.revoked) throw new Error('还没有可复制的激活码，请先查询原订单');
    return license.code;
  }
  async catalog() { return purchaseCatalogResponseSchema.parse((await this.json('/v1/catalog')).body); }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('当前购买还在处理中，请不要重复下单');
    this.busy = true;
    try { return await action(); }
    finally { this.busy = false; }
  }
  async create(input: unknown): Promise<PurchaseReceipt> {
    const request = purchaseRequestSchema.parse(input);
    return this.exclusive(async () => {
      const receipts = await this.load();
      if (receipts.some(receipt => !receipt.rejected && receipt.delivery?.state !== 'fulfilled' && !ended(receipt))) throw new Error('还有一笔购买没处理完，请先恢复原订单，不要重复付款');
      if (receipts.length >= 100) throw new Error('本机的购买记录已达上限，请联系售后');
      if (request.renewalLicenseId && !this.renewalAuthorization) throw new Error('本机的续费凭证不可用，没有创建订单');
      const renewalAuthorization = request.renewalLicenseId
        ? licenseActivationSchema.parse(await this.renewalAuthorization!(request.renewalLicenseId)) : undefined;
      const receipt: StoredReceipt = { localId: randomUUID(), createdAt: new Date(this.now()).toISOString(), request,
        order: null, delivery: null, rejected: false, token: `TBD-${randomBytes(32).toString('hex').toUpperCase()}`,
        ...(renewalAuthorization ? { renewalAuthorization } : {}) };
      receipts.push(receipt);
      // Save before the first request so a lost response cannot lose the recovery credential.
      await this.save(receipts);
      await this.recover(receipt, receipts);
      return this.summary(receipt);
    });
  }
  async refresh(localId: string): Promise<PurchaseReceipt> {
    return this.exclusive(async () => {
      const receipts = await this.load(); const receipt = this.find(receipts, localId);
      if (receipt.rejected) throw new Error('这笔购买还没下单，请重新查看商品');
      if (!receipt.order) await this.recover(receipt, receipts);
      const order = receipt.order;
      if (!order) throw new Error('还没拿到订单，请保留记录，稍后恢复');
      const delivery = purchaseDeliverySchema.parse((await this.json(`/v1/orders/${order.id}/reconcile`, receipt.token, {})).body);
      if (delivery.id !== order.id || delivery.amountFen !== order.amountFen || delivery.quantity !== order.quantity || delivery.kind !== order.offer.kind || delivery.renewalLicenseId !== receipt.request.renewalLicenseId
        || receipt.delivery?.state === 'fulfilled' && delivery.state !== 'fulfilled'
        || ended(receipt) && delivery.state === 'pending' && !delivery.paymentConfirmed) throw new Error('交付信息和原订单对不上，请联系售后');
      receipt.delivery = delivery;
      if (delivery.state !== 'pending') receipt.order = { ...order, state: delivery.state, payable: false };
      else if (delivery.paymentConfirmed) receipt.order = { ...order, state: 'pending', payable: false };
      await this.save(receipts);
      return this.summary(receipt);
    });
  }
  async openPayment(localId: string): Promise<void> {
    return this.exclusive(async () => {
      const receipts = await this.load(); const receipt = this.find(receipts, localId);
      if (receipt.rejected || receipt.delivery?.state === 'fulfilled') throw new Error('这笔记录不能再次付款');
      const { response, environment } = await this.recover(receipt, receipts);
      if (response.state === 'closed' || response.state === 'expired') throw new Error('原订单已关闭且未收款，可以重新创建订单');
      if (!response.payable || !response.paymentUrl || Date.parse(response.expiresAt) - this.now() < 60000) throw new Error('付款页面已关闭或过期，请先查询原订单，不要重复下单');
      const url = new URL(response.paymentUrl);
      const params = url.searchParams;
      const gateway = paymentEnvironmentSchema.safeParse(environment);
      if (!gateway.success || `${url.origin}${url.pathname}` !== alipayGateways[gateway.data] || url.username || url.password || url.hash
        || [...new Set(params.keys())].some(key => params.getAll(key).length !== 1)
        || params.get('method') !== 'alipay.trade.page.pay' || params.get('sign_type') !== 'RSA2' || !params.get('sign')
        || params.has('return_url') || params.get('notify_url') !== new URL('/v1/payments/alipay/notify', this.origin).href) throw new Error('付款链接没通过安全检查，请联系售后');
      const business = z.object({ out_trade_no: z.literal(`TB_${response.id.replaceAll('-', '')}`),
        total_amount: z.literal((response.amountFen / 100).toFixed(2)), product_code: z.literal('FAST_INSTANT_TRADE_PAY') });
      if (!business.safeParse(JSON.parse(params.get('biz_content') ?? 'null')).success) throw new Error('付款链接和原订单对不上，请联系售后');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([this.openExternal(url.href), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('browser timeout')), 10000);
        })]);
      } catch { throw new Error('没能确认浏览器已打开，原订单已保留。请检查浏览器后再试'); }
      finally { if (timer) clearTimeout(timer); }
    });
  }
  private find(receipts: StoredReceipt[], localId: string): StoredReceipt {
    const id = z.string().uuid().parse(localId); const receipt = receipts.find(item => item.localId === id);
    if (!receipt) throw new Error('找不到本机的购买记录，请联系售后');
    return receipt;
  }
  private async recover(receipt: StoredReceipt, receipts: StoredReceipt[]) {
    try {
      const { body, headers } = await this.json('/v1/orders', receipt.token, receipt.request, receipt.order ? undefined : receipt.renewalAuthorization);
      const result = purchaseResponseSchema.parse(body);
      const { request, order } = receipt;
      if (result.offer.id !== request.offerId || result.offer.revision !== request.revision || result.offer.unitAmountFen !== request.quotedUnitAmountFen || result.renewalLicenseId !== request.renewalLicenseId
        || result.quantity !== request.quantity || order && (result.id !== order.id || result.amountFen !== order.amountFen || result.expiresAt !== order.expiresAt || JSON.stringify(result.offer) !== JSON.stringify(order.offer))
        || receipt.delivery?.state === 'fulfilled' && result.state !== 'fulfilled') throw new Error('购买结果和保存的请求对不上，请联系售后');
      receipt.order = purchaseOrderSchema.strip().parse(result);
      await this.save(receipts);
      return { response: result, environment: headers.get(paymentEnvironmentHeader) };
    } catch (error) {
      // Only explicit, pre-creation rejections permit a new purchase. Timeouts and 5xx remain uncertain.
      if (!receipt.order && error instanceof PurchaseResponseError && (
        error.code === 'OFFER_CHANGED' && error.status === 409 || error.code === 'QUANTITY_LIMIT' && error.status === 400
        || error.code === 'PAYMENTS_UNAVAILABLE' && error.status === 503
        || error.code === 'INVALID_RENEWAL_AUTHORIZATION' && error.status === 403
        || error.code === 'RENEWAL_NOT_SUBSCRIPTION' && error.status === 409
        || error.code === 'RENEWAL_DETAILS_MISMATCH' && error.status === 400)) {
        receipt.rejected = true;
        await this.save(receipts);
      }
      throw error;
    }
  }
  private async json(path: string, token?: string, body?: unknown, renewal?: z.infer<typeof licenseActivationSchema>): Promise<{ body: unknown; headers: Headers }> {
    let response: Response; let text: string;
    try {
      response = await this.request(new URL(path, this.origin), { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(renewal ? { 'X-Tblink-Renewal-Code': renewal.code, 'X-Tblink-Machine-Code': renewal.machineCode } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
      if (!response.body) throw new Error('empty');
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 65536) throw new Error('size'); chunks.push(chunk.value); }
      } finally { await reader.cancel(); reader.releaseLock(); }
      text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    } catch { throw new Error('连不上购买服务或返回出错，原购买记录已保留，请稍后恢复原订单'); }
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { throw new Error(response.status === 404 ? '购买服务还没开放，请联系售后' : '购买服务返回的内容无法识别，请保留原订单并联系售后'); }
    if (!response.ok) {
      const error = responseErrorSchema.safeParse(value);
      throw new PurchaseResponseError(error.success ? error.data.code : 'UNKNOWN', response.status);
    }
    return { body: value, headers: response.headers };
  }
}
