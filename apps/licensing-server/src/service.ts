import { createCipheriv, createDecipheriv, createHmac, createPrivateKey, createPublicKey, randomBytes, randomUUID, sign, timingSafeEqual, verify, type KeyObject } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { licenseActivationSchema, licenseClaimsSchema } from '../../../packages/schema/src/license';
import { purchaseOfferSchema, purchaseRequestSchema, wechatCodeUrlSchema, type PurchaseCatalog } from '../../../packages/schema/src/purchase';
import { ConsoleService } from './console-service';
import { FeedbackStore, migrateFeedback, type FeedbackOptions } from './feedback';

const orderSchema = z.object({
  reference: z.string().trim().min(1).max(100), customer: z.string().trim().min(1).max(160),
  customerType: z.enum(['personal', 'company']), quantity: z.number().int().min(1).max(100),
  kind: z.enum(['perpetual', 'subscription']), amountFen: z.number().int().min(0).max(100_000_000),
  useUntil: z.string().datetime().nullable(), updatesUntil: z.string().datetime()
}).strict().refine(value => (value.kind === 'perpetual') === (value.useUntil === null), '买断不设使用期限，订阅必须填写期限');
const paymentSchema = z.object({ paymentReference: z.string().trim().min(1).max(100), amountFen: z.number().int().positive() }).strict();
const licenseRowSchema = z.object({ id: z.string(), order_id: z.string(), code_hash: z.string(), code_cipher: z.string(), machine: z.string().nullable(), revoked: z.number(), lease_until: z.number() });
/** Signed lease on activation: bounds client offline starts and how long operator migration waits for the old machine. */
const LEASE_MS = 48 * 3600000;
const orderStateSchema = z.enum(['pending', 'paid', 'fulfilled', 'refunded', 'closed', 'expired']);
type OrderState = z.infer<typeof orderStateSchema>;
// 生产库只允许新增表，旧版“有收款记录但仍为 pending”的行不回填；收到收款事实时经 settle() 收敛为 paid。
const orderTransitions: Readonly<Record<OrderState, readonly OrderState[]>> = {
  pending: ['paid', 'closed', 'expired'], paid: ['fulfilled', 'refunded'], fulfilled: ['refunded'], refunded: [],
  // 关单后仍收到验签成功的付款：保留收款事实并照常交付，审计中可见 closed→paid。
  closed: ['paid'], expired: ['paid']
};
const orderRowSchema = z.object({ id: z.string(), body: z.string(), state: orderStateSchema, payment_reference: z.string().nullable() });
const alipayIdentity = { orderId: z.string().uuid(), appId: z.string().regex(/^\d{16}$/), sellerId: z.string().regex(/^\d{16}$/) };
const alipayTradeStatus = z.enum(['TRADE_SUCCESS', 'TRADE_FINISHED', 'WAIT_BUYER_PAY', 'TRADE_CLOSED']);
const alipayQuerySchema = z.union([
  z.object({ ...alipayIdentity, status: z.literal('TRADE_NOT_EXIST') }).strict(),
  z.object({ ...alipayIdentity, status: alipayTradeStatus, amountFen: z.number().int().positive(), paymentReference: z.string() }).strict()
]);
const alipayNoticeSchema = z.object({ ...alipayIdentity, status: alipayTradeStatus, amountFen: z.number().int().positive(),
  refundFen: z.number().int().nonnegative(), paymentReference: z.string() }).strict();

type PaymentSource = 'manual' | 'alipay' | 'wechat';
type PaymentChannel = Exclude<PaymentSource, 'manual'>;

export class ServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly orderId?: string) { super(message); }
}

/** Single SQLite writer; transactions also serialize activation across server processes. */
export class LicensingService {
  private readonly db: DatabaseSync;
  private readonly signingKey: KeyObject;
  private transactionDepth = 0;
  constructor(databasePath: string, privateKey: string, private readonly kid: string, private readonly dataKey: Buffer, private readonly now: () => number = Date.now) {
    if (dataKey.length !== 32) throw new Error('数据加密密钥必须为 32 字节');
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(kid)) throw new Error('签名 keyId 无效');
    this.signingKey = createPrivateKey(privateKey);
    if (this.signingKey.asymmetricKeyType !== 'ed25519') throw new Error('签名密钥必须为 Ed25519');
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE, body TEXT NOT NULL, state TEXT NOT NULL, payment_reference TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS licenses (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), code_hash TEXT NOT NULL UNIQUE, code_cipher TEXT NOT NULL, machine TEXT, revoked INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS order_delivery_access (order_id TEXT PRIMARY KEY REFERENCES orders(id), token_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS alipay_payment_links (order_id TEXT PRIMARY KEY REFERENCES orders(id), app_id TEXT NOT NULL, seller_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS wechat_payment_links (order_id TEXT PRIMARY KEY REFERENCES orders(id), app_id TEXT NOT NULL, seller_id TEXT NOT NULL, expires_at INTEGER NOT NULL, code_url TEXT);
      CREATE TABLE IF NOT EXISTS purchase_requests (token_hash TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE REFERENCES orders(id), request_body TEXT NOT NULL, offer_body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS license_renewals (order_id TEXT PRIMARY KEY REFERENCES orders(id), license_id TEXT NOT NULL REFERENCES licenses(id), use_until TEXT, updates_until TEXT);
      CREATE TABLE IF NOT EXISTS license_term_overrides (license_id TEXT PRIMARY KEY REFERENCES licenses(id), use_until TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS license_renewals_license ON license_renewals(license_id);
      CREATE TABLE IF NOT EXISTS payment_receipts (order_id TEXT PRIMARY KEY REFERENCES orders(id), payment_reference TEXT NOT NULL UNIQUE, amount_fen INTEGER NOT NULL, source TEXT NOT NULL, app_id TEXT, seller_id TEXT, received_at TEXT NOT NULL, last_error TEXT);
      CREATE TABLE IF NOT EXISTS payment_events (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), channel TEXT NOT NULL, event_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, trade_status TEXT NOT NULL, payment_reference TEXT NOT NULL, amount_fen INTEGER NOT NULL, refund_fen INTEGER NOT NULL, received_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS payment_events_order ON payment_events(order_id);
      CREATE TABLE IF NOT EXISTS alipay_refunds (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), amount_fen INTEGER NOT NULL, reason TEXT NOT NULL, actor TEXT NOT NULL, state TEXT NOT NULL, refunded_total_fen INTEGER, created_at TEXT NOT NULL, confirmed_at TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS alipay_refunds_pending ON alipay_refunds(order_id) WHERE state = 'pending';
      CREATE TABLE IF NOT EXISTS refund_reviews (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), refund_fen INTEGER NOT NULL, decision TEXT NOT NULL, reason TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS refund_reviews_order ON refund_reviews(order_id);
      CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, at TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL);`);
    migrateFeedback(this.db);
  }
  close(): void { this.db.close(); }
  console(key: Buffer): ConsoleService { return new ConsoleService(this.db, this, key, this.now); }
  /** In-app problem reports, with packages kept in `directory`. Senders are hashed with a key derived from the data key. */
  feedback(directory: string, options?: FeedbackOptions): FeedbackStore {
    return new FeedbackStore(this.db, directory, createHmac('sha256', this.dataKey).update('tblink:feedback-source:v1').digest(),
      (token, machineCode) => this.feedbackLicense(token, machineCode), this.now, options);
  }
  /**
   * The license a problem report carries, when it is one this server signed for that machine and has not revoked;
   * null otherwise. It only decides how large a diagnostic package the report may attach.
   */
  feedbackLicense(token: string, machineCode: string): string | null {
    const [header, body, signature, ...rest] = token.split('.');
    if (!header || !body || !signature || rest.length) return null;
    const signatureBytes = Buffer.from(signature, 'base64url');
    if (signatureBytes.length !== 64 || !verify(null, Buffer.from(`${header}.${body}`), createPublicKey(this.signingKey), signatureBytes)) return null;
    let payload: unknown;
    try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
    catch (error) { if (error instanceof SyntaxError) return null; throw error; }
    const claims = licenseClaimsSchema.safeParse(payload);
    if (!claims.success || claims.data.machineCode !== machineCode) return null;
    return this.db.prepare('SELECT id FROM licenses WHERE id=? AND machine=? AND revoked=0').get(claims.data.licenseId, machineCode) ? claims.data.licenseId : null;
  }
  consoleTransaction<T>(work: () => T): T { return this.transaction(work); }
  private transaction<T>(work: () => T): T {
    const nested = this.transactionDepth > 0;
    const savepoint = `operation_${randomBytes(8).toString('hex')}`;
    this.db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    this.transactionDepth++;
    try { const value = work(); this.db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT'); return value; }
    catch (error) { this.db.exec(nested ? `ROLLBACK TO ${savepoint}` : 'ROLLBACK'); if (nested) this.db.exec(`RELEASE ${savepoint}`); throw error; }
    finally { this.transactionDepth--; }
  }
  private audit(action: string, target: string, detail = ''): void {
    this.db.prepare('INSERT INTO audit VALUES (?, ?, ?, ?, ?)').run(randomUUID(), new Date(this.now()).toISOString(), action, target, detail);
  }
  /** 订单状态的唯一写入口；须在事务内调用，每次转换写审计。 */
  private transition(id: string, to: OrderState, reason: string): void {
    if (this.transactionDepth === 0) throw new Error('订单状态转换必须在事务内执行');
    const from = this.order(id).state;
    if (!orderTransitions[from].includes(to)) throw new ServiceError(409, 'ORDER_STATE_CONFLICT', '订单当前状态不允许此操作，请刷新后核对', id);
    if (this.db.prepare('UPDATE orders SET state = ? WHERE id = ? AND state = ?').run(to, id, from).changes !== 1) throw new Error('订单状态写入未生效');
    this.audit('order.state-changed', id, `${from}->${to}:${reason}`);
  }
  /** 已有可信收款的订单至少处于 paid。 */
  private settle(id: string, reason: string): void {
    const { state } = this.order(id);
    if ((state === 'pending' || state === 'closed' || state === 'expired') && this.hasPayment(id)) this.transition(id, 'paid', reason);
  }
  /** 对客户只公开 pending/fulfilled/closed/expired，旧版桌面端仍能解析已收款与已交付订单。 */
  private publicState(order: { state: OrderState; payment_reference: string | null }): 'pending' | 'fulfilled' | 'closed' | 'expired' {
    switch (order.state) {
      case 'pending': case 'paid': return 'pending';
      case 'fulfilled': return 'fulfilled';
      // 退款不自动撤销授权：已交付的码照常可领，未交付即退款的按关闭处理。
      case 'refunded': return order.payment_reference === null ? 'closed' : 'fulfilled';
      case 'closed': case 'expired': return order.state;
    }
  }
  private hash(code: string): string { return createHmac('sha256', this.dataKey).update(`activation:${code}`).digest('hex'); }
  private encrypt(code: string): string {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.dataKey, iv);
    cipher.setAAD(Buffer.from('tblink:activation:v1'));
    const body = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }
  private decrypt(value: string): string {
    const bytes = Buffer.from(value, 'base64'); const decipher = createDecipheriv('aes-256-gcm', this.dataKey, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from('tblink:activation:v1')); decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  }
  private order(id: string) {
    const row = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!row) throw new ServiceError(404, 'ORDER_NOT_FOUND', '订单不存在');
    const parsed = orderRowSchema.parse(row);
    return { ...parsed, details: orderSchema.parse(JSON.parse(parsed.body)) };
  }
  createOrder(input: unknown): { id: string; state: OrderState } {
    const order = orderSchema.parse(input);
    if (order.amountFen < 1) throw new ServiceError(400, 'INVALID_AMOUNT', '销售订单金额必须大于零');
    if (Date.parse(order.updatesUntil) <= this.now() || order.useUntil && Date.parse(order.useUntil) <= this.now()) throw new ServiceError(400, 'INVALID_TERM', '订单期限必须晚于当前时间');
    return this.transaction(() => {
      const prior = this.db.prepare('SELECT id, body, state FROM orders WHERE reference = ?').get(order.reference);
      if (prior) {
        if (prior.body !== JSON.stringify(order)) throw new ServiceError(409, 'ORDER_CONFLICT', '订单编号已存在且内容不同');
        return { id: z.string().parse(prior.id), state: orderStateSchema.parse(prior.state) };
      }
      const id = randomUUID();
      this.db.prepare("INSERT INTO orders VALUES (?, ?, ?, 'pending', NULL)").run(id, order.reference, JSON.stringify(order));
      this.audit('order.created', id);
      return { id, state: 'pending' as const };
    });
  }
  listOffers(catalog: PurchaseCatalog) {
    return catalog.offers.filter(offer => Date.parse(offer.saleUntil) - this.now() >= 60000)
      .map(offer => ({ ...offer, maxQuantity: Math.min(offer.maxQuantity, Math.floor(catalog.maxOrderAmountFen / offer.unitAmountFen)) }))
      .filter(offer => offer.maxQuantity > 0);
  }
  createPurchase(input: unknown, token: string, catalog: PurchaseCatalog | undefined, payment?: { appId: string; sellerId: string }, renewalAuthorization?: unknown, channel: PaymentChannel = 'alipay') {
    const request = purchaseRequestSchema.parse(input);
    const table = channel === 'wechat' ? 'wechat_payment_links' : 'alipay_payment_links';
    if (!/^TBD-[A-F0-9]{64}$/.test(token)) throw new ServiceError(401, 'INVALID_DELIVERY_ACCESS', '请先安全保存本次购买的随机领取凭据');
    const tokenHash = createHmac('sha256', this.dataKey).update(`purchase:v1:${token}`).digest('hex');
    return this.transaction(() => {
      const prior = this.db.prepare('SELECT order_id, request_body FROM purchase_requests WHERE token_hash = ?').get(tokenHash);
      let id: string;
      if (prior) {
        id = z.string().parse(prior.order_id);
        this.requireDeliveryAccess(id, token);
        if (this.paymentChannel(id) !== channel) throw new ServiceError(409, 'PAYMENT_CHANNEL_MISMATCH', '原订单不能更换支付渠道，请恢复原凭据');
        if (prior.request_body !== JSON.stringify(request)) throw new ServiceError(409, 'PURCHASE_CONFLICT', '同一购买凭据已用于其他商品或数量，请先核对原订单');
      } else {
        if (!catalog || !payment) throw new ServiceError(503, 'PAYMENTS_UNAVAILABLE', '购买尚未开放，原订单可凭领取凭据查询');
        const { appId, sellerId } = z.object({ appId: z.string().regex(channel === 'wechat' ? /^wx[a-zA-Z0-9]{16}$/ : /^\d{16}$/), sellerId: z.string().regex(channel === 'wechat' ? /^\d{8,32}$/ : /^\d{16}$/) }).parse(payment);
        const offer = this.listOffers(catalog).find(item => item.id === request.offerId);
        if (!offer || offer.revision !== request.revision || offer.unitAmountFen !== request.quotedUnitAmountFen) throw new ServiceError(409, 'OFFER_CHANGED', '商品已更新或停止销售，请重新查看价格与授权条款');
        if (request.quantity > offer.maxQuantity) throw new ServiceError(400, 'QUANTITY_LIMIT', '数量超过当前商品或单笔金额限制');
        if (request.renewalLicenseId) {
          const license = this.authorizeRenewal(request.renewalLicenseId, renewalAuthorization);
          const original = this.order(license.order_id).details;
          if (offer.kind !== 'subscription' || original.kind !== 'subscription') throw new ServiceError(409, 'RENEWAL_NOT_SUBSCRIPTION', '只能为原订阅购买订阅续期');
          if (request.quantity !== 1 || request.customer !== original.customer || request.customerType !== original.customerType) throw new ServiceError(400, 'RENEWAL_DETAILS_MISMATCH', '续费必须保留原授权客户且每次只续一台机器');
        }
        const now = this.now(); const expiresAt = Math.min(now + 15 * 60000, Date.parse(offer.saleUntil));
        id = randomUUID();
        const details = orderSchema.parse({ reference: `purchase:${tokenHash}`, customer: request.customer, customerType: request.customerType,
          quantity: request.quantity, amountFen: offer.unitAmountFen * request.quantity, kind: offer.kind,
          useUntil: offer.useDays === null ? null : new Date(now + offer.useDays * 86400000).toISOString(),
          updatesUntil: new Date(now + offer.updatesDays * 86400000).toISOString() });
        this.db.prepare("INSERT INTO orders VALUES (?, ?, ?, 'pending', NULL)").run(id, details.reference, JSON.stringify(details));
        this.db.prepare('INSERT INTO purchase_requests VALUES (?, ?, ?, ?)').run(tokenHash, id, JSON.stringify(request), JSON.stringify(offer));
        this.db.prepare('INSERT INTO order_delivery_access VALUES (?, ?, ?, 0)').run(id, this.deliveryHash(id, token).toString('hex'), now + 7 * 86400000);
        this.db.prepare(`INSERT INTO ${table} (order_id, app_id, seller_id, expires_at) VALUES (?, ?, ?, ?)`).run(id, appId, sellerId, expiresAt);
        if (request.renewalLicenseId) this.db.prepare('INSERT INTO license_renewals (order_id, license_id) VALUES (?, ?)').run(id, request.renewalLicenseId);
        this.audit('order.purchase-created', id, `${offer.id}:${offer.revision}`);
      }
      const order = this.order(id);
      const link = z.object({ expires_at: z.number(), app_id: z.string(), seller_id: z.string() }).parse(this.db.prepare(`SELECT * FROM ${table} WHERE order_id = ?`).get(id));
      const snapshot = z.object({ offer_body: z.string() }).parse(this.db.prepare('SELECT offer_body FROM purchase_requests WHERE order_id = ?').get(id));
      return { id, state: this.publicState(order), amountFen: order.details.amountFen, quantity: order.details.quantity, ...this.renewalTarget(id),
        offer: purchaseOfferSchema.parse(JSON.parse(snapshot.offer_body)),
        expiresAt: new Date(link.expires_at).toISOString(), payable: order.state === 'pending' && !this.hasPayment(id) && link.expires_at - this.now() >= 60000 && link.app_id === payment?.appId && link.seller_id === payment.sellerId };
    });
  }
  paymentChannel(id: string): PaymentChannel | null {
    const alipay = this.db.prepare('SELECT order_id FROM alipay_payment_links WHERE order_id = ?').get(id);
    const wechat = this.db.prepare('SELECT order_id FROM wechat_payment_links WHERE order_id = ?').get(id);
    if (alipay && wechat) throw new ServiceError(409, 'PAYMENT_CHANNEL_MISMATCH', '订单支付渠道记录冲突，请联系支持');
    return wechat ? 'wechat' : alipay ? 'alipay' : null;
  }
  wechatQueryOrder(id: string, appId: string, sellerId: string) {
    const order = this.order(id);
    const raw = this.db.prepare('SELECT * FROM wechat_payment_links WHERE order_id = ?').get(id);
    if (!raw) throw new ServiceError(409, 'PAYMENT_NOT_PREPARED', '订单尚未准备微信付款');
    const link = z.object({ app_id: z.string(), seller_id: z.string(), code_url: z.string().nullable() }).parse(raw);
    if (link.app_id !== appId || link.seller_id !== sellerId) throw new ServiceError(409, 'PAYMENT_IDENTITY_MISMATCH', '微信订单的商户或应用与当前配置不匹配');
    return { id, state: order.state, amountFen: order.details.amountFen, codeUrl: link.code_url };
  }
  saveWechatCodeUrl(id: string, appId: string, sellerId: string, url: string): void {
    wechatCodeUrlSchema.parse(url);
    this.transaction(() => {
      this.wechatQueryOrder(id, appId, sellerId);
      this.db.prepare('UPDATE wechat_payment_links SET code_url = ? WHERE order_id = ? AND code_url IS NULL').run(url, id);
    });
  }
  reconcileWechat(id: string, input: unknown) {
    const payment = z.object({ orderId: z.string().uuid(), amountFen: z.number().int().positive(), paymentReference: z.string(),
      appId: z.string().regex(/^wx[a-zA-Z0-9]{16}$/), sellerId: z.string().regex(/^\d{8,32}$/),
      status: z.enum(['SUCCESS', 'REFUND', 'NOTPAY', 'CLOSED', 'REVOKED', 'USERPAYING', 'PAYERROR']) }).strict().parse(input);
    const order = this.wechatQueryOrder(id, payment.appId, payment.sellerId);
    if (payment.orderId !== id) throw new ServiceError(409, 'PAYMENT_ORDER_MISMATCH', '微信查单返回了其他订单');
    if (payment.amountFen !== order.amountFen) throw new ServiceError(409, 'AMOUNT_MISMATCH', '微信查单金额与订单不一致');
    const settled = payment.status === 'SUCCESS';
    const result = settled ? this.fulfill(id, { paymentReference: payment.paymentReference, amountFen: payment.amountFen }, 'wechat', payment) : order;
    this.transaction(() => this.audit('order.wechat-queried', id, payment.status));
    return { id, state: result.state, paymentStatus: payment.status, needsReview: !settled && result.state === 'fulfilled' };
  }
  private renewalTarget(orderId: string): { renewalLicenseId?: string } {
    const row = this.db.prepare('SELECT license_id FROM license_renewals WHERE order_id = ?').get(orderId);
    return row ? { renewalLicenseId: z.string().uuid().parse(row.license_id) } : {};
  }
  private authorizeRenewal(id: string, input: unknown) {
    const parsed = licenseActivationSchema.safeParse(input);
    const row = parsed.success ? this.db.prepare('SELECT * FROM licenses WHERE id = ? AND code_hash = ?').get(id, this.hash(parsed.data.code)) : undefined;
    const license = row ? licenseRowSchema.parse(row) : null;
    if (!parsed.success || !license || license.revoked || !license.machine || license.machine !== parsed.data.machineCode) throw new ServiceError(403, 'INVALID_RENEWAL_AUTHORIZATION', '续费授权无效，请在原绑定机器核对激活码');
    return license;
  }
  private licenseTerms(license: z.infer<typeof licenseRowSchema>) {
    const original = this.order(license.order_id).details;
    const renewed = z.object({ use_until: z.string().nullable(), updates_until: z.string().nullable() }).parse(
      this.db.prepare('SELECT MAX(use_until) AS use_until, MAX(updates_until) AS updates_until FROM license_renewals WHERE license_id = ?').get(license.id));
    const later = (current: string, renewal: string | null): string => renewal && Date.parse(renewal) > Date.parse(current) ? renewal : current;
    const override = this.db.prepare('SELECT use_until FROM license_term_overrides WHERE license_id=?').get(license.id);
    return { ...original, kind: override ? 'subscription' as const : original.kind, useUntil: override ? z.string().parse(override.use_until) : original.useUntil ? later(original.useUntil, renewed.use_until) : null,
      updatesUntil: later(original.updatesUntil, renewed.updates_until) };
  }
  prepareAlipayPayment(id: string, appId: string, sellerId: string) {
    z.string().regex(/^\d{16}$/).parse(appId); z.string().regex(/^\d{16}$/).parse(sellerId);
    return this.transaction(() => {
      if (this.paymentChannel(id) === 'wechat') throw new ServiceError(409, 'PAYMENT_CHANNEL_MISMATCH', '微信订单不能另建支付宝付款入口');
      const order = this.order(id);
      if (order.state === 'fulfilled' || order.state === 'refunded') throw new ServiceError(409, 'ORDER_ALREADY_FULFILLED', '订单已交付，无需再次付款');
      if (order.state === 'closed' || order.state === 'expired') throw new ServiceError(409, 'ORDER_STATE_CONFLICT', '订单已关闭，不能再生成付款入口', id);
      if (this.hasPayment(id)) throw new ServiceError(409, 'PAYMENT_ALREADY_RECEIVED', '付款已确认，授权待处理，请勿重复付款');
      const now = this.now();
      const expiresAt = Math.min(now + 15 * 60000, Date.parse(order.details.updatesUntil), order.details.useUntil ? Date.parse(order.details.useUntil) : Infinity);
      const old = this.db.prepare('SELECT app_id, seller_id, expires_at FROM alipay_payment_links WHERE order_id = ?').get(id);
      const payment = old ? z.object({ app_id: z.string(), seller_id: z.string(), expires_at: z.number() }).parse(old)
        : { app_id: appId, seller_id: sellerId, expires_at: expiresAt };
      if (payment.app_id !== appId || payment.seller_id !== sellerId) throw new ServiceError(409, 'PAYMENT_IDENTITY_MISMATCH', '订单已绑定其他支付配置，请核对原交易');
      if (payment.expires_at - now < 60000) throw new ServiceError(409, 'PAYMENT_LINK_EXPIRED', '付款入口已过期，请先核对原订单是否已付款');
      if (!old) {
        this.db.prepare('INSERT INTO alipay_payment_links VALUES (?, ?, ?, ?)').run(id, appId, sellerId, expiresAt);
        this.audit('order.alipay-link-created', id);
      }
      return { id, amountFen: order.details.amountFen, quantity: order.details.quantity, expiresAt: new Date(payment.expires_at).toISOString() };
    });
  }
  alipayQueryOrder(id: string, appId: string, sellerId: string) {
    const order = this.order(id);
    const link = this.db.prepare('SELECT app_id, seller_id FROM alipay_payment_links WHERE order_id = ?').get(id);
    if (!link) throw new ServiceError(409, 'PAYMENT_NOT_PREPARED', '订单尚未生成支付宝付款入口');
    if (link.app_id !== appId || link.seller_id !== sellerId) throw new ServiceError(409, 'PAYMENT_IDENTITY_MISMATCH', '订单绑定的商户或应用与查单配置不匹配');
    return { id, state: order.state, amountFen: order.details.amountFen };
  }
  reconcileAlipay(id: string, input: unknown) {
    const payment = alipayQuerySchema.parse(input);
    const order = this.alipayQueryOrder(id, payment.appId, payment.sellerId);
    if (payment.orderId !== id) throw new ServiceError(409, 'PAYMENT_ORDER_MISMATCH', '查单返回了其他订单');
    if (payment.status !== 'TRADE_NOT_EXIST' && payment.amountFen !== order.amountFen) throw new ServiceError(409, 'AMOUNT_MISMATCH', '查单金额与订单不一致');
    const settled = payment.status === 'TRADE_SUCCESS' || payment.status === 'TRADE_FINISHED';
    if (settled) this.fulfill(id, { paymentReference: payment.paymentReference, amountFen: payment.amountFen }, 'alipay', payment);
    return this.transaction(() => {
      this.audit('order.alipay-queried', id, payment.status);
      const closure = payment.status === 'TRADE_NOT_EXIST' ? 'expired' : payment.status === 'TRADE_CLOSED' ? 'closed' : null;
      if (closure && this.closable(id)) this.transition(id, closure, `alipay:${payment.status}`);
      const { state } = this.order(id);
      // 已交付订单的 CLOSED 可能代表退款，记录事实但不推断退款金额或撤销席位。
      return { id, state, paymentStatus: payment.status, needsReview: !settled && state === 'fulfilled' };
    });
  }
  /** 待付款、无收款记录且支付宝付款期限已过；仍须渠道确认交易关闭或不存在后才能关单。 */
  closable(id: string): boolean {
    const link = this.db.prepare('SELECT expires_at FROM alipay_payment_links WHERE order_id = ?').get(id);
    return this.order(id).state === 'pending' && !this.hasPayment(id) && link !== undefined && this.now() >= z.object({ expires_at: z.number() }).parse(link).expires_at;
  }
  closeOrder(id: string, to: 'closed' | 'expired', reason: string): void {
    this.transaction(() => {
      if (!this.closable(id)) throw new ServiceError(409, 'ORDER_STATE_CONFLICT', '订单已收款或付款期限未过，不能关闭', id);
      this.transition(id, to, reason);
    });
  }
  /** 支付宝付款期限已过一分钟以上仍待付款、无收款的订单，新近过期的在前；恢复任务逐单查单后由渠道结果关单、过期或交付。 */
  lapsedPaymentLinks(): { items: string[] } {
    const rows = this.db.prepare("SELECT o.id FROM orders o JOIN alipay_payment_links a ON a.order_id=o.id WHERE o.state='pending' AND a.expires_at<=? AND NOT EXISTS (SELECT 1 FROM payment_receipts p WHERE p.order_id=o.id) ORDER BY a.expires_at DESC LIMIT 100").all(this.now() - 60000);
    return { items: rows.map(row => z.string().parse(row.id)) };
  }
  /** 未生成任何付款入口且无收款的待付款订单（线下单）由运营关闭；有付款入口的须经渠道查单关闭。 */
  closeUnlinkedOrder(id: string): void {
    this.transaction(() => {
      if (this.order(id).state !== 'pending' || this.hasPayment(id) || this.paymentChannel(id) !== null) throw new ServiceError(409, 'ORDER_STATE_CONFLICT', '只能关闭未收款且未生成付款链接的待付款订单', id);
      this.transition(id, 'closed', 'console:close-order');
    });
  }
  /** 验签通过的支付宝异步通知：成功且无退款的交付；其余落事件表，退款进运营异常队列但不撤销授权。 */
  alipayNotification(input: unknown): void {
    const notice = alipayNoticeSchema.parse(input);
    if ((notice.status === 'TRADE_SUCCESS' || notice.status === 'TRADE_FINISHED') && notice.refundFen === 0) {
      this.fulfill(notice.orderId, { paymentReference: notice.paymentReference, amountFen: notice.amountFen }, 'alipay', notice);
      return;
    }
    this.transaction(() => {
      const order = this.alipayQueryOrder(notice.orderId, notice.appId, notice.sellerId);
      if (notice.amountFen !== order.amountFen) throw new ServiceError(409, 'AMOUNT_MISMATCH', '支付通知金额与订单不一致');
      const receipt = this.db.prepare('SELECT payment_reference FROM payment_receipts WHERE order_id = ?').get(order.id);
      if (receipt && receipt.payment_reference !== notice.paymentReference) throw new ServiceError(409, 'PAYMENT_CONFLICT', '通知流水与已确认收款不一致');
      const kind = notice.refundFen > 0 ? 'refund' : notice.status === 'TRADE_CLOSED' ? 'closed' : 'waiting';
      // refund_fee 是累计退款额，同一交易的重复通知按状态与累计额去重。
      const inserted = this.db.prepare(`INSERT INTO payment_events VALUES (?, ?, 'alipay', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_key) DO NOTHING`).run(randomUUID(), order.id,
        `${notice.paymentReference}:${notice.status}:${notice.refundFen}`, kind, notice.status, notice.paymentReference, notice.amountFen, notice.refundFen, new Date(this.now()).toISOString());
      if (inserted.changes === 0) return;
      this.audit('order.alipay-event', order.id, `${notice.status}:${notice.refundFen}`);
      this.settle(order.id, 'alipay-event');
      if (kind === 'refund' && notice.refundFen === notice.amountFen) {
        const { state } = this.order(order.id);
        if (state === 'paid' || state === 'fulfilled') this.transition(order.id, 'refunded', 'alipay:full-refund');
      }
      if (kind === 'closed' && this.closable(order.id)) this.transition(order.id, 'closed', 'alipay:TRADE_CLOSED-notice');
    });
  }
  /** 渠道累计已退款：通知中的累计退款额与本服务确认成功的原路退款取大，口径与运营异常队列一致。 */
  private channelRefundedFen(id: string): number {
    return z.number().int().parse(this.db.prepare(`SELECT MAX(COALESCE((SELECT MAX(refund_fen) FROM payment_events WHERE order_id = ?1), 0),
      COALESCE((SELECT SUM(amount_fen) FROM alipay_refunds WHERE order_id = ?1 AND state = 'succeeded'), 0),
      COALESCE((SELECT MAX(refunded_total_fen) FROM alipay_refunds WHERE order_id = ?1 AND state = 'succeeded'), 0)) AS fen`).get(id)?.fen);
  }
  /** 撤销订单自身签发的授权；续费单不拥有授权，不在此撤销原订单已付期限。 */
  private revokeOrderLicenses(id: string, reason: string): string[] {
    const ids = this.db.prepare('SELECT id FROM licenses WHERE order_id = ? AND revoked = 0 ORDER BY rowid').all(id).map(row => z.string().parse(row.id));
    for (const license of ids) this.revoke(license, { reason });
    return ids;
  }
  /** 运营发起原路退款前登记退款请求；同一订单仅一笔待确认请求，重试沿用同一 out_request_no 由支付宝去重。 */
  prepareAlipayRefund(id: string, amountFen: number, reason: string, actor: string): { orderId: string; refundId: string; amountFen: number; reason: string } {
    return this.transaction(() => {
      if (this.paymentChannel(id) !== 'alipay') throw new ServiceError(409, 'REFUND_CHANNEL_UNSUPPORTED', '只有支付宝订单可以原路退款；线下收款请人工办理后登记', id);
      const receipt = this.db.prepare('SELECT source FROM payment_receipts WHERE order_id = ?').get(id);
      if (!receipt || receipt.source !== 'alipay') throw new ServiceError(409, 'NOT_PAID', '订单尚无已确认的支付宝收款，不能退款', id);
      this.settle(id, 'alipay-refund');
      const order = this.order(id);
      if (order.state === 'refunded') throw new ServiceError(409, 'ORDER_REFUNDED', '订单已全额退款', id);
      const pending = this.db.prepare("SELECT id, amount_fen, reason FROM alipay_refunds WHERE order_id = ? AND state = 'pending'").get(id);
      if (pending) {
        const prior = z.object({ id: z.string(), amount_fen: z.number(), reason: z.string() }).parse(pending);
        if (prior.amount_fen !== amountFen) throw new ServiceError(409, 'REFUND_PENDING', `上一笔 ¥${(prior.amount_fen / 100).toFixed(2)} 退款尚未确认，请先按原金额重新提交确认`, id);
        return { orderId: id, refundId: prior.id, amountFen, reason: prior.reason };
      }
      if (this.channelRefundedFen(id) + amountFen > order.details.amountFen) throw new ServiceError(409, 'REFUND_EXCEEDED', '累计退款超过订单金额', id);
      const refundId = randomUUID();
      this.db.prepare("INSERT INTO alipay_refunds (id, order_id, amount_fen, reason, actor, state, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)").run(refundId, id, amountFen, reason, actor, new Date(this.now()).toISOString());
      this.audit('order.alipay-refund-requested', id, `${refundId}:${amountFen}`);
      return { orderId: id, refundId, amountFen, reason };
    });
  }
  /** 渠道确认退款成功：全额退款在同一事务内标记 refunded 并撤销订单授权；部分退款与续费单只记录，进入运营复核。 */
  confirmAlipayRefund(refundId: string, refundedTotalFen: number, actor: string) {
    return this.transaction(() => {
      const raw = this.db.prepare('SELECT order_id, amount_fen, reason, state FROM alipay_refunds WHERE id = ?').get(refundId);
      if (!raw) throw new ServiceError(404, 'REFUND_NOT_FOUND', '退款请求不存在');
      const refund = z.object({ order_id: z.string(), amount_fen: z.number(), reason: z.string(), state: z.enum(['pending', 'succeeded']) }).parse(raw);
      if (refund.state === 'succeeded') return null;
      this.db.prepare("UPDATE alipay_refunds SET state = 'succeeded', refunded_total_fen = ?, confirmed_at = ? WHERE id = ?").run(refundedTotalFen, new Date(this.now()).toISOString(), refundId);
      this.audit('order.alipay-refund-confirmed', refund.order_id, `${refundId}:${refund.amount_fen}`);
      this.settle(refund.order_id, 'alipay-refund');
      const order = this.order(refund.order_id); const total = this.channelRefundedFen(refund.order_id);
      const full = total >= order.details.amountFen; const renewal = Boolean(this.renewalTarget(refund.order_id).renewalLicenseId);
      let revoked: string[] = [];
      if (full && (order.state === 'paid' || order.state === 'fulfilled')) this.transition(refund.order_id, 'refunded', 'alipay:console-refund');
      if (full && !renewal) {
        revoked = this.revokeOrderLicenses(refund.order_id, `支付宝全额退款：${refund.reason}`);
        this.db.prepare("INSERT INTO refund_reviews VALUES (?, ?, ?, 'revoke', ?, ?, ?)").run(randomUUID(), refund.order_id, total, `全额原路退款自动撤销：${refund.reason}`, actor, new Date(this.now()).toISOString());
      }
      return { orderId: refund.order_id, amountFen: refund.amount_fen, full, renewal, revoked };
    });
  }
  /** 运营处理渠道退款（含支付宝后台直接退款的通知）：撤销本订单授权或保留结案；通知本身从不撤销授权。 */
  reviewRefund(id: string, decision: 'revoke' | 'keep', reason: string, actor: string): { revoked: string[] } {
    return this.transaction(() => {
      const total = this.channelRefundedFen(id);
      const reviewed = z.number().int().parse(this.db.prepare('SELECT COALESCE(MAX(refund_fen), 0) AS fen FROM refund_reviews WHERE order_id = ?').get(id)?.fen);
      if (total <= reviewed) throw new ServiceError(409, 'REFUND_REVIEW_NOT_NEEDED', '该订单没有待处理的渠道退款', id);
      if (decision === 'revoke' && this.renewalTarget(id).renewalLicenseId) throw new ServiceError(409, 'RENEWAL_REVOKE_UNSUPPORTED', '续费订单不拥有授权，撤销会吊销原订单已付期限；请用“调整到期时间”回退续期后选择保留授权结案', id);
      const revoked = decision === 'revoke' ? this.revokeOrderLicenses(id, `渠道退款处理：${reason}`) : [];
      this.db.prepare('INSERT INTO refund_reviews VALUES (?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), id, total, decision, reason, actor, new Date(this.now()).toISOString());
      this.audit('order.refund-reviewed', id, `${decision}:${total}`);
      return { revoked };
    });
  }
  private hasPayment(id: string): boolean {
    return Boolean(this.db.prepare('SELECT order_id FROM payment_receipts WHERE order_id = ?').get(id));
  }
  paymentExceptions(after: number) {
    const cursor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(after);
    const rows = this.db.prepare(`SELECT p.rowid AS cursor, p.order_id AS orderId, p.payment_reference AS paymentReference,
      p.amount_fen AS amountFen, p.source, p.received_at AS receivedAt, p.last_error AS lastError
      FROM payment_receipts p JOIN orders o ON o.id = p.order_id WHERE o.state IN ('pending', 'paid') AND p.rowid > ? ORDER BY p.rowid LIMIT 100`).all(cursor);
    const items = z.array(z.object({ cursor: z.number().int(), orderId: z.string().uuid(), paymentReference: z.string(),
      amountFen: z.number().int(), source: z.enum(['manual', 'alipay', 'wechat']), receivedAt: z.string().datetime(), lastError: z.string().nullable() })).parse(rows);
    return { items, nextCursor: items.length === 100 ? items[99]!.cursor : null };
  }
  retryDelivery(id: string, input: unknown) {
    const { reason } = z.object({ reason: z.string().trim().min(1).max(500) }).strict().parse(input);
    this.order(id);
    const raw = this.db.prepare('SELECT * FROM payment_receipts WHERE order_id = ?').get(id);
    if (!raw) throw new ServiceError(409, 'PAYMENT_NOT_RECEIVED', '订单尚无已确认收款记录，不能补发');
    const receipt = z.object({ payment_reference: z.string(), amount_fen: z.number(), source: z.enum(['manual', 'alipay', 'wechat']),
      app_id: z.string().nullable(), seller_id: z.string().nullable() }).parse(raw);
    this.transaction(() => this.audit('order.delivery-retry-requested', id, reason));
    return this.fulfill(id, { paymentReference: receipt.payment_reference, amountFen: receipt.amount_fen }, receipt.source,
      receipt.app_id && receipt.seller_id ? { appId: receipt.app_id, sellerId: receipt.seller_id } : undefined);
  }
  fulfill(id: string, input: unknown, source: PaymentSource = 'manual', paymentIdentity?: { appId: string; sellerId: string }) {
    const payment = paymentSchema.parse(input);
    // Verified receipt survives a later delivery rollback or a process exit between these transactions.
    this.transaction(() => {
      this.validatePayment(id, payment, source, paymentIdentity);
      const prior = this.db.prepare('SELECT * FROM payment_receipts WHERE order_id = ?').get(id);
      if (prior) {
        if (prior.payment_reference !== payment.paymentReference || prior.amount_fen !== payment.amountFen || prior.source !== source
          || prior.app_id !== (paymentIdentity?.appId ?? null) || prior.seller_id !== (paymentIdentity?.sellerId ?? null)) throw new ServiceError(409, 'PAYMENT_CONFLICT', '订单已确认其他收款流水或身份');
      } else {
        this.db.prepare('INSERT INTO payment_receipts VALUES (?, ?, ?, ?, ?, ?, ?, NULL)').run(id, payment.paymentReference, payment.amountFen, source,
          paymentIdentity?.appId ?? null, paymentIdentity?.sellerId ?? null, new Date(this.now()).toISOString());
        this.audit('order.payment-received', id, source);
      }
      this.settle(id, `${source}-payment`);
    });
    try { return this.transaction(() => {
      const result = this.fulfillOrder(id, payment, source, paymentIdentity);
      this.db.prepare('UPDATE payment_receipts SET last_error = NULL WHERE order_id = ?').run(id);
      return result;
    }); } catch (error) {
      this.transaction(() => {
        this.db.prepare('UPDATE payment_receipts SET last_error = ? WHERE order_id = ?').run(error instanceof ServiceError ? error.code : 'INTERNAL_ERROR', id);
        this.audit('order.delivery-failed', id, error instanceof ServiceError ? error.code : 'INTERNAL_ERROR');
      });
      throw error;
    }
  }
  private validatePayment(id: string, payment: z.infer<typeof paymentSchema>, source: PaymentSource, paymentIdentity?: { appId: string; sellerId: string }) {
    const order = this.order(id);
    if (order.details.amountFen === 0) throw new ServiceError(409, 'SPECIAL_GRANT', '特殊授权不能登记收款');
    const channel = this.paymentChannel(id);
    if (channel && channel !== source) throw new ServiceError(409, 'PAYMENT_CHANNEL_MISMATCH', '已生成付款入口的订单不能更换支付渠道，也不能改成人工核款');
    if (source === 'wechat') this.wechatQueryOrder(id, paymentIdentity?.appId ?? '', paymentIdentity?.sellerId ?? '');
    const link = this.db.prepare('SELECT app_id, seller_id FROM alipay_payment_links WHERE order_id = ?').get(id);
    if (link && source === 'alipay' && (link.app_id !== paymentIdentity?.appId || link.seller_id !== paymentIdentity?.sellerId)) throw new ServiceError(409, 'PAYMENT_IDENTITY_MISMATCH', '支付通知与订单绑定的商户或应用不匹配');
    if (order.details.amountFen !== payment.amountFen) throw new ServiceError(409, 'AMOUNT_MISMATCH', '核款金额与订单不一致');
    if (order.payment_reference !== null && order.payment_reference !== payment.paymentReference) throw new ServiceError(409, 'PAYMENT_CONFLICT', '订单已使用其他流水完成核款');
    if (this.db.prepare('SELECT id FROM orders WHERE payment_reference = ? AND id != ?').get(payment.paymentReference, id)
      || this.db.prepare('SELECT order_id FROM payment_receipts WHERE payment_reference = ? AND order_id != ?').get(payment.paymentReference, id)) throw new ServiceError(409, 'PAYMENT_REUSED', '收款流水已用于另一订单');
    return order;
  }
  private fulfillOrder(id: string, payment: z.infer<typeof paymentSchema>, source: PaymentSource, paymentIdentity?: { appId: string; sellerId: string }) {
    const order = this.validatePayment(id, payment, source, paymentIdentity);
    if (order.state === 'fulfilled' || order.state === 'refunded') return this.describeOrder(id);
    const purchase = this.db.prepare('SELECT offer_body FROM purchase_requests WHERE order_id = ?').get(id);
    const { renewalLicenseId } = this.renewalTarget(id);
    if (purchase) {
      // 自助订单按首次核款发码时间起算，重试和回调不会再次延长期限。
      const offer = purchaseOfferSchema.parse(JSON.parse(z.string().parse(purchase.offer_body)));
      const now = this.now();
      let useStart = now; let updatesStart = now;
      if (renewalLicenseId) {
        const license = licenseRowSchema.parse(this.db.prepare('SELECT * FROM licenses WHERE id = ?').get(renewalLicenseId));
        if (license.revoked) throw new ServiceError(409, 'RENEWAL_REVOKED', '原授权已撤销，续费付款需由发行方核对处理');
        const terms = this.licenseTerms(license);
        if (terms.kind !== 'subscription' || !terms.useUntil || offer.useDays === null) throw new ServiceError(409, 'RENEWAL_NOT_SUBSCRIPTION', '原订阅与续期商品不匹配');
        useStart = Math.max(now, Date.parse(terms.useUntil));
        updatesStart = Math.max(now, Date.parse(terms.updatesUntil));
      }
      order.details.useUntil = offer.useDays === null ? null : new Date(useStart + offer.useDays * 86400000).toISOString();
      order.details.updatesUntil = new Date(updatesStart + offer.updatesDays * 86400000).toISOString();
      orderSchema.parse(order.details);
      this.db.prepare('UPDATE orders SET body = ? WHERE id = ?').run(JSON.stringify(order.details), id);
    } else if (order.details.useUntil && Date.parse(order.details.useUntil) <= this.now() || Date.parse(order.details.updatesUntil) <= this.now()) throw new ServiceError(409, 'ORDER_EXPIRED', '订单期限已过，请重新确认订单');
    this.transition(id, 'fulfilled', source);
    this.db.prepare('UPDATE orders SET payment_reference = ? WHERE id = ?').run(payment.paymentReference, id);
    if (renewalLicenseId) {
      this.db.prepare('UPDATE license_renewals SET use_until = ?, updates_until = ? WHERE order_id = ?').run(order.details.useUntil, order.details.updatesUntil, id);
      this.db.prepare('UPDATE license_term_overrides SET use_until=? WHERE license_id=?').run(order.details.useUntil, renewalLicenseId);
      this.audit('license.renewed', renewalLicenseId, id);
    } else for (let index = 0; index < order.details.quantity; index += 1) {
      const code = `TBA-${randomBytes(16).toString('hex').toUpperCase()}`;
      this.db.prepare('INSERT INTO licenses (id, order_id, code_hash, code_cipher) VALUES (?, ?, ?, ?)').run(randomUUID(), id, this.hash(code), this.encrypt(code));
    }
    this.audit(`order.${source}-payment-confirmed`, id, payment.paymentReference);
    return this.describeOrder(id);
  }
  describeOrder(id: string) {
    const order = this.order(id);
    const licenses = this.orderLicenses(id).map(row => {
      const value = licenseRowSchema.parse(row);
      return { id: value.id, code: this.decrypt(value.code_cipher), machineCode: value.machine, revoked: Boolean(value.revoked), leaseUntil: value.lease_until ? new Date(value.lease_until).toISOString() : null };
    });
    return { id, state: order.state, ...order.details, ...this.renewalTarget(id), licenses };
  }
  private orderLicenses(id: string) {
    return this.db.prepare('SELECT * FROM licenses WHERE order_id = ? OR id IN (SELECT license_id FROM license_renewals WHERE order_id = ?) ORDER BY rowid').all(id, id);
  }
  private deliveryHash(id: string, token: string): Buffer {
    return createHmac('sha256', this.dataKey).update(`delivery:v1:${id}:${token}`).digest();
  }
  issueDeliveryAccess(id: string, input: unknown): { token: string; expiresAt: string } {
    const { reason } = z.object({ reason: z.string().trim().min(1).max(500) }).strict().parse(input);
    return this.transaction(() => {
      this.order(id);
      const token = `TBD-${randomBytes(32).toString('hex').toUpperCase()}`;
      const expiresAt = this.now() + 7 * 86400000;
      this.db.prepare(`INSERT INTO order_delivery_access (order_id, token_hash, expires_at, revoked) VALUES (?, ?, ?, 0)
        ON CONFLICT(order_id) DO UPDATE SET token_hash = excluded.token_hash, expires_at = excluded.expires_at, revoked = 0`).run(id, this.deliveryHash(id, token).toString('hex'), expiresAt);
      this.audit('order.delivery-access-issued', id, reason);
      return { token, expiresAt: new Date(expiresAt).toISOString() };
    });
  }
  revokeDeliveryAccess(id: string, input: unknown): { revoked: true } {
    const { reason } = z.object({ reason: z.string().trim().min(1).max(500) }).strict().parse(input);
    return this.transaction(() => {
      this.order(id);
      this.db.prepare('UPDATE order_delivery_access SET revoked = 1 WHERE order_id = ?').run(id);
      this.audit('order.delivery-access-revoked', id, reason);
      return { revoked: true as const };
    });
  }
  readDelivery(id: string, token: string) {
    return this.transaction(() => {
      this.requireDeliveryAccess(id, token);
      const order = this.order(id);
      const state = this.publicState(order);
      const target = this.renewalTarget(id);
      const licenses = state === 'fulfilled' ? this.orderLicenses(id).map(row => {
        const license = licenseRowSchema.parse(row);
        return { id: license.id, code: license.revoked || target.renewalLicenseId ? null : this.decrypt(license.code_cipher), revoked: Boolean(license.revoked) };
      }) : [];
      return { id, state, amountFen: order.details.amountFen, quantity: order.details.quantity,
        kind: order.details.kind, useUntil: order.details.useUntil, updatesUntil: order.details.updatesUntil, ...target, licenses,
        ...(state === 'pending' && this.hasPayment(id) ? { paymentConfirmed: true as const } : {}) };
    });
  }
  private requireDeliveryAccess(id: string, token: string): void {
    const row = this.db.prepare('SELECT token_hash, expires_at, revoked FROM order_delivery_access WHERE order_id = ?').get(id);
    const access = row ? z.object({ token_hash: z.string().regex(/^[a-f0-9]{64}$/), expires_at: z.number(), revoked: z.number() }).parse(row) : null;
    // Unknown orders and invalid credentials have the same public response; never accept an order ID alone.
    const matches = timingSafeEqual(this.deliveryHash(id, token), access ? Buffer.from(access.token_hash, 'hex') : Buffer.alloc(32));
    if (!/^TBD-[A-F0-9]{64}$/.test(token) || !access || !matches || access.revoked || this.now() >= access.expires_at) throw new ServiceError(401, 'INVALID_DELIVERY_ACCESS', '领取凭据无效或过期，请联系发行方核对购买记录');
  }
  activate(input: unknown): { license: string } {
    const request = licenseActivationSchema.parse(input);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM licenses WHERE code_hash = ?').get(this.hash(request.code));
      if (!row) throw new ServiceError(403, 'INVALID_CODE', '激活码无效或已撤销');
      const license = licenseRowSchema.parse(row);
      if (license.revoked) throw new ServiceError(403, 'REVOKED', '授权已撤销，请联系发行方');
      if (license.machine && license.machine !== request.machineCode) throw new ServiceError(409, 'MACHINE_BOUND', '激活码已绑定另一台机器，请办理换机');
      const order = this.licenseTerms(license);
      const now = this.now();
      if (order.useUntil && Date.parse(order.useUntil) <= now) throw new ServiceError(403, 'EXPIRED', '授权使用期限已结束');
      const leaseUntil = Math.min(now + LEASE_MS, order.useUntil ? Date.parse(order.useUntil) : Infinity);
      const claims = licenseClaimsSchema.parse({ version: 1, product: request.product, licenseId: license.id,
        customer: order.customer, machineCode: request.machineCode, kind: order.kind, issuedAt: new Date(now).toISOString(),
        useUntil: order.useUntil, updatesUntil: order.updatesUntil,
        online: { leaseUntil: new Date(leaseUntil).toISOString(), customerType: order.customerType } });
      const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: this.kid })).toString('base64url');
      const body = `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
      const token = `${body}.${sign(null, Buffer.from(body), this.signingKey).toString('base64url')}`;
      this.db.prepare('UPDATE licenses SET machine = ?, lease_until = ? WHERE id = ?').run(request.machineCode, Math.max(license.lease_until, leaseUntil), license.id);
      this.audit(license.machine ? 'license.refreshed' : 'license.activated', license.id);
      return { license: token };
    });
  }
  revoke(id: string, input: unknown): { revoked: true } {
    const { reason } = z.object({ reason: z.string().trim().min(1).max(500) }).strict().parse(input);
    return this.transaction(() => {
      if (!this.db.prepare('SELECT id FROM licenses WHERE id = ?').get(id)) throw new ServiceError(404, 'LICENSE_NOT_FOUND', '授权不存在');
      this.db.prepare('UPDATE licenses SET revoked = 1 WHERE id = ?').run(id);
      this.audit('license.revoked', id, reason);
      return { revoked: true as const };
    });
  }
  consoleLicense(id: string) {
    const row = this.db.prepare('SELECT * FROM licenses WHERE id=?').get(id);
    if (!row) throw new ServiceError(404, 'LICENSE_NOT_FOUND', '授权不存在');
    const license = licenseRowSchema.parse(row); const terms = this.licenseTerms(license);
    const last = this.db.prepare("SELECT MAX(at) AS at FROM audit WHERE target=? AND action IN ('license.activated','license.refreshed')").get(id);
    return { id, orderId: license.order_id, customer: terms.customer, kind: terms.kind, useUntil: terms.useUntil, updatesUntil: terms.updatesUntil,
      machineCode: license.machine, bound: Boolean(license.machine), revoked: Boolean(license.revoked), leaseUntil: license.lease_until ? new Date(license.lease_until).toISOString() : null,
      migrationAfter: license.lease_until ? new Date(license.lease_until + 300000).toISOString() : null, lastIssuedAt: last?.at ? z.string().parse(last.at) : null };
  }
  setLicenseExpiry(id: string, useUntil: string, reason: string): void {
    const until = z.string().datetime().parse(useUntil);
    if (Date.parse(until) <= this.now()) throw new ServiceError(400, 'INVALID_TERM', '截止时间必须晚于当前时间；立即停用请使用撤销授权');
    this.transaction(() => {
      const prior = this.consoleLicense(id);
      if (prior.revoked) throw new ServiceError(409, 'LICENSE_REVOKED', '已撤销授权不能修改期限');
      this.db.prepare('INSERT INTO license_term_overrides VALUES(?,?) ON CONFLICT(license_id) DO UPDATE SET use_until=excluded.use_until').run(id, until);
      this.audit('license.expiry-adjusted', id, JSON.stringify({ before: prior.useUntil, after: until, reason }));
    });
  }
  consoleReveal(id: string): string {
    const row = this.db.prepare('SELECT code_cipher FROM licenses WHERE id=?').get(id);
    if (!row) throw new ServiceError(404, 'LICENSE_NOT_FOUND', '授权不存在');
    return this.decrypt(z.string().parse(row.code_cipher));
  }
  createGrant(input: { customer: string; customerType: 'personal' | 'company'; quantity: number; useUntil: string }, reference: string): { id: string } {
    const details = orderSchema.parse({ ...input, reference, kind: 'subscription', amountFen: 0, updatesUntil: input.useUntil });
    if (Date.parse(details.useUntil!) <= this.now()) throw new ServiceError(400, 'INVALID_TERM', '截止时间必须晚于当前时间');
    return this.transaction(() => {
      const id = randomUUID();
      this.db.prepare("INSERT INTO orders VALUES(?,?,?,'fulfilled',NULL)").run(id, reference, JSON.stringify(details));
      for (let index = 0; index < details.quantity; index++) {
        const code = `TBA-${randomBytes(16).toString('hex').toUpperCase()}`;
        this.db.prepare('INSERT INTO licenses(id,order_id,code_hash,code_cipher) VALUES(?,?,?,?)').run(randomUUID(), id, this.hash(code), this.encrypt(code));
      }
      this.audit('license.special-grant', id); return { id };
    });
  }
  migrate(id: string, input: unknown): { code: string } {
    const { reason } = z.object({ reason: z.string().trim().min(1).max(500) }).strict().parse(input);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM licenses WHERE id = ?').get(id);
      if (!row) throw new ServiceError(404, 'LICENSE_NOT_FOUND', '授权不存在');
      const license = licenseRowSchema.parse(row);
      if (!license.revoked || license.lease_until + 300_000 > this.now()) throw new ServiceError(409, 'LEASE_OUTSTANDING', '请先撤销旧授权，等待已签发离线凭证到期及五分钟时钟容差后换机');
      const code = `TBA-${randomBytes(16).toString('hex').toUpperCase()}`;
      this.db.prepare('UPDATE licenses SET code_hash = ?, code_cipher = ?, machine = NULL, revoked = 0, lease_until = 0 WHERE id = ?').run(this.hash(code), this.encrypt(code), id);
      // A previous recipient must not retrieve the replacement code after a machine transfer.
      this.db.prepare('UPDATE order_delivery_access SET revoked = 1 WHERE order_id = ?').run(license.order_id);
      this.audit('license.migrated', id, reason);
      return { code };
    });
  }
}
