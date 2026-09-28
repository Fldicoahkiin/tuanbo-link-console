import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  purchaseCatalogResponseSchema, purchaseDeliverySchema, purchaseOrderSchema, purchaseReceiptSchema,
  purchaseRequestSchema, purchaseResponseSchema, type PurchaseReceipt
} from '@tb/schema';
import type { SecureProfileStore } from './secure-profile-store';

const credentialId = 'license.purchases';
const storedReceiptSchema = purchaseReceiptSchema.extend({ token: z.string().regex(/^TBD-[A-F0-9]{64}$/) });
const receiptsSchema = z.array(storedReceiptSchema).max(100);
type StoredReceipt = z.infer<typeof storedReceiptSchema>;
type Credentials = Pick<SecureProfileStore, 'hasCredential' | 'loadCredential' | 'saveCredential'>;
const responseErrorSchema = z.object({ code: z.string(), requestId: z.string().optional() });
const messages: Record<string, string> = {
  OFFER_CHANGED: '商品价格或条款已变更，请重新查看商品后购买',
  QUANTITY_LIMIT: '所选机器数超过当前购买限制',
  PAYMENTS_UNAVAILABLE: '购买尚未开放，请联系发行方',
  INVALID_DELIVERY_ACCESS: '领取凭据已过期或撤销，请联系发行方核对原订单',
  PURCHASE_CONFLICT: '原购买请求不一致，请联系发行方核对订单',
  RATE_LIMITED: '查询过于频繁，请稍后手动重试'
};
class PurchaseResponseError extends Error {
  constructor(readonly code: string, readonly status: number) { super(messages[code] ?? `购买服务请求失败（${status}），请保留原订单并手动核对`); }
}

export class PurchaseService {
  private readonly origin: URL;
  private busy = false;
  constructor(serverUrl: string, private readonly credentials: Credentials,
    private readonly openExternal: (url: string) => Promise<void>, private readonly request: typeof fetch = fetch,
    private readonly now: () => number = Date.now) {
    this.origin = new URL(serverUrl);
    if (this.origin.protocol !== 'https:' || this.origin.username || this.origin.password || this.origin.search || this.origin.hash || this.origin.pathname !== '/') throw new Error('购买服务器必须是固定的 HTTPS 域名');
  }
  private async load(): Promise<StoredReceipt[]> {
    if (!await this.credentials.hasCredential(credentialId)) return [];
    try { return receiptsSchema.parse(JSON.parse(await this.credentials.loadCredential(credentialId))); }
    catch { throw new Error('本机购买记录无法读取，请保留本机数据并联系发行方；未创建新订单'); }
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
    if (!license?.code || license.revoked) throw new Error('未找到可复制的已交付激活码，请先查询原订单');
    return license.code;
  }
  async catalog() { return purchaseCatalogResponseSchema.parse(await this.json('/v1/catalog')); }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('请等待当前购买操作完成，不要重复下单');
    this.busy = true;
    try { return await action(); }
    finally { this.busy = false; }
  }
  async create(input: unknown): Promise<PurchaseReceipt> {
    const request = purchaseRequestSchema.parse(input);
    return this.exclusive(async () => {
      const receipts = await this.load();
      if (receipts.some(receipt => !receipt.rejected && receipt.delivery?.state !== 'fulfilled')) throw new Error('还有待核对的购买，请先恢复原订单；不要重复付款');
      if (receipts.length >= 100) throw new Error('本机购买记录已达上限，请联系发行方核对');
      const receipt: StoredReceipt = { localId: randomUUID(), createdAt: new Date(this.now()).toISOString(), request,
        order: null, delivery: null, rejected: false, token: `TBD-${randomBytes(32).toString('hex').toUpperCase()}` };
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
      if (receipt.rejected) throw new Error('该购买未建单，请重新查看商品');
      if (!receipt.order) await this.recover(receipt, receipts);
      const order = receipt.order;
      if (!order) throw new Error('尚未取得订单，请保留记录并手动恢复');
      const delivery = purchaseDeliverySchema.parse(await this.json(`/v1/orders/${order.id}`, receipt.token));
      if (delivery.id !== order.id || delivery.amountFen !== order.amountFen || delivery.quantity !== order.quantity || delivery.kind !== order.offer.kind
        || receipt.delivery?.state === 'fulfilled' && delivery.state !== 'fulfilled') throw new Error('交付信息与原订单不一致，请联系发行方');
      receipt.delivery = delivery;
      if (delivery.state === 'fulfilled') receipt.order = { ...order, state: 'fulfilled', payable: false };
      await this.save(receipts);
      return this.summary(receipt);
    });
  }
  async openPayment(localId: string): Promise<void> {
    return this.exclusive(async () => {
      const receipts = await this.load(); const receipt = this.find(receipts, localId);
      if (receipt.rejected || receipt.delivery?.state === 'fulfilled') throw new Error('这笔记录不能再次付款');
      const response = await this.recover(receipt, receipts);
      if (!response.payable || !response.paymentUrl || Date.parse(response.expiresAt) - this.now() < 60000) throw new Error('付款入口已关闭或过期，请核对原订单；不要重复下单');
      const url = new URL(response.paymentUrl);
      const params = url.searchParams;
      if (url.origin !== 'https://openapi.alipay.com' || url.pathname !== '/gateway.do' || url.username || url.password || url.hash
        || [...new Set(params.keys())].some(key => params.getAll(key).length !== 1)
        || params.get('method') !== 'alipay.trade.page.pay' || params.get('sign_type') !== 'RSA2' || !params.get('sign')
        || params.has('return_url') || params.get('notify_url') !== new URL('/v1/payments/alipay/notify', this.origin).href) throw new Error('付款链接未通过安全检查，请联系发行方');
      const business = z.object({ out_trade_no: z.literal(`TB_${response.id.replaceAll('-', '')}`),
        total_amount: z.literal((response.amountFen / 100).toFixed(2)), product_code: z.literal('FAST_INSTANT_TRADE_PAY') });
      if (!business.safeParse(JSON.parse(params.get('biz_content') ?? 'null')).success) throw new Error('付款链接与原订单不一致，请联系发行方');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([this.openExternal(url.href), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('browser timeout')), 10000);
        })]);
      } catch { throw new Error('未能确认系统浏览器已打开，原订单已保留，请先检查浏览器再手动重试'); }
      finally { if (timer) clearTimeout(timer); }
    });
  }
  private find(receipts: StoredReceipt[], localId: string): StoredReceipt {
    const id = z.string().uuid().parse(localId); const receipt = receipts.find(item => item.localId === id);
    if (!receipt) throw new Error('未找到本机购买记录，请联系发行方核对');
    return receipt;
  }
  private async recover(receipt: StoredReceipt, receipts: StoredReceipt[]) {
    try {
      const result = purchaseResponseSchema.parse(await this.json('/v1/orders', receipt.token, receipt.request));
      const { request, order } = receipt;
      if (result.offer.id !== request.offerId || result.offer.revision !== request.revision || result.offer.unitAmountFen !== request.quotedUnitAmountFen
        || result.quantity !== request.quantity || order && (result.id !== order.id || result.amountFen !== order.amountFen || result.expiresAt !== order.expiresAt || JSON.stringify(result.offer) !== JSON.stringify(order.offer))
        || receipt.delivery?.state === 'fulfilled' && result.state !== 'fulfilled') throw new Error('购买响应与已保存请求不一致，请联系发行方');
      receipt.order = purchaseOrderSchema.strip().parse(result);
      await this.save(receipts);
      return result;
    } catch (error) {
      // Only explicit, pre-creation rejections permit a new purchase. Timeouts and 5xx remain uncertain.
      if (!receipt.order && error instanceof PurchaseResponseError && (
        error.code === 'OFFER_CHANGED' && error.status === 409 || error.code === 'QUANTITY_LIMIT' && error.status === 400
        || error.code === 'PAYMENTS_UNAVAILABLE' && error.status === 503)) {
        receipt.rejected = true;
        await this.save(receipts);
      }
      throw error;
    }
  }
  private async json(path: string, token?: string, body?: unknown): Promise<unknown> {
    let response: Response; let text: string;
    try {
      response = await this.request(new URL(path, this.origin), { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
      if (!response.body) throw new Error('empty');
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 65536) throw new Error('size'); chunks.push(chunk.value); }
      } finally { await reader.cancel(); reader.releaseLock(); }
      text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    } catch { throw new Error('购买服务连接失败或响应异常，原购买记录已保留，请手动恢复原订单'); }
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { throw new Error(response.status === 404 ? '购买服务尚未开放，请联系发行方' : '购买服务返回格式异常，请保留原订单并联系发行方'); }
    if (!response.ok) {
      const error = responseErrorSchema.safeParse(value);
      throw new PurchaseResponseError(error.success ? error.data.code : 'UNKNOWN', response.status);
    }
    return value;
  }
}
