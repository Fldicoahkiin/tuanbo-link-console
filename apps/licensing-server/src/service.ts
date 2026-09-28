import { createCipheriv, createDecipheriv, createHmac, createPrivateKey, randomBytes, randomUUID, sign, timingSafeEqual, type KeyObject } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { licenseActivationSchema, licenseClaimsSchema } from '../../../packages/schema/src/license';
import { purchaseOfferSchema, purchaseRequestSchema, type PurchaseCatalog } from '../../../packages/schema/src/purchase';

const orderSchema = z.object({
  reference: z.string().trim().min(1).max(100), customer: z.string().trim().min(1).max(160),
  customerType: z.enum(['personal', 'company']), quantity: z.number().int().min(1).max(100),
  kind: z.enum(['perpetual', 'subscription']), amountFen: z.number().int().min(1).max(100_000_000),
  useUntil: z.string().datetime().nullable(), updatesUntil: z.string().datetime()
}).strict().refine(value => (value.kind === 'perpetual') === (value.useUntil === null), '买断不设使用期限，订阅必须填写期限');
const paymentSchema = z.object({ paymentReference: z.string().trim().min(1).max(100), amountFen: z.number().int().positive() }).strict();
const licenseRowSchema = z.object({ id: z.string(), order_id: z.string(), code_hash: z.string(), code_cipher: z.string(), machine: z.string().nullable(), revoked: z.number(), lease_until: z.number() });
const orderRowSchema = z.object({ id: z.string(), body: z.string(), state: z.enum(['pending', 'fulfilled']), payment_reference: z.string().nullable() });

export class ServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/** Single SQLite writer; transactions also serialize activation across server processes. */
export class LicensingService {
  private readonly db: DatabaseSync;
  private readonly signingKey: KeyObject;
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
      CREATE TABLE IF NOT EXISTS purchase_requests (token_hash TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE REFERENCES orders(id), request_body TEXT NOT NULL, offer_body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, at TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL);`);
  }
  close(): void { this.db.close(); }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = work(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private audit(action: string, target: string, detail = ''): void {
    this.db.prepare('INSERT INTO audit VALUES (?, ?, ?, ?, ?)').run(randomUUID(), new Date(this.now()).toISOString(), action, target, detail);
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
  createOrder(input: unknown): { id: string; state: 'pending' | 'fulfilled' } {
    const order = orderSchema.parse(input);
    if (Date.parse(order.updatesUntil) <= this.now() || order.useUntil && Date.parse(order.useUntil) <= this.now()) throw new ServiceError(400, 'INVALID_TERM', '订单期限必须晚于当前时间');
    return this.transaction(() => {
      const prior = this.db.prepare('SELECT id, body, state FROM orders WHERE reference = ?').get(order.reference);
      if (prior) {
        if (prior.body !== JSON.stringify(order)) throw new ServiceError(409, 'ORDER_CONFLICT', '订单编号已存在且内容不同');
        return { id: z.string().parse(prior.id), state: z.enum(['pending', 'fulfilled']).parse(prior.state) };
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
  createPurchase(input: unknown, token: string, catalog: PurchaseCatalog | undefined, payment?: { appId: string; sellerId: string }) {
    const request = purchaseRequestSchema.parse(input);
    if (!/^TBD-[A-F0-9]{64}$/.test(token)) throw new ServiceError(401, 'INVALID_DELIVERY_ACCESS', '请先安全保存本次购买的随机领取凭据');
    const tokenHash = createHmac('sha256', this.dataKey).update(`purchase:v1:${token}`).digest('hex');
    return this.transaction(() => {
      const prior = this.db.prepare('SELECT order_id, request_body FROM purchase_requests WHERE token_hash = ?').get(tokenHash);
      let id: string;
      if (prior) {
        id = z.string().parse(prior.order_id);
        this.requireDeliveryAccess(id, token);
        if (prior.request_body !== JSON.stringify(request)) throw new ServiceError(409, 'PURCHASE_CONFLICT', '同一购买凭据已用于其他商品或数量，请先核对原订单');
      } else {
        if (!catalog || !payment) throw new ServiceError(503, 'PAYMENTS_UNAVAILABLE', '购买尚未开放，原订单可凭领取凭据查询');
        const { appId, sellerId } = z.object({ appId: z.string().regex(/^\d{16}$/), sellerId: z.string().regex(/^\d{16}$/) }).parse(payment);
        const offer = this.listOffers(catalog).find(item => item.id === request.offerId);
        if (!offer || offer.revision !== request.revision || offer.unitAmountFen !== request.quotedUnitAmountFen) throw new ServiceError(409, 'OFFER_CHANGED', '商品已更新或停止销售，请重新查看价格与授权条款');
        if (request.quantity > offer.maxQuantity) throw new ServiceError(400, 'QUANTITY_LIMIT', '数量超过当前商品或单笔金额限制');
        const now = this.now(); const expiresAt = Math.min(now + 15 * 60000, Date.parse(offer.saleUntil));
        id = randomUUID();
        const details = orderSchema.parse({ reference: `purchase:${tokenHash}`, customer: request.customer, customerType: request.customerType,
          quantity: request.quantity, amountFen: offer.unitAmountFen * request.quantity, kind: offer.kind,
          useUntil: offer.useDays === null ? null : new Date(now + offer.useDays * 86400000).toISOString(),
          updatesUntil: new Date(now + offer.updatesDays * 86400000).toISOString() });
        this.db.prepare("INSERT INTO orders VALUES (?, ?, ?, 'pending', NULL)").run(id, details.reference, JSON.stringify(details));
        this.db.prepare('INSERT INTO purchase_requests VALUES (?, ?, ?, ?)').run(tokenHash, id, JSON.stringify(request), JSON.stringify(offer));
        this.db.prepare('INSERT INTO order_delivery_access VALUES (?, ?, ?, 0)').run(id, this.deliveryHash(id, token).toString('hex'), now + 7 * 86400000);
        this.db.prepare('INSERT INTO alipay_payment_links VALUES (?, ?, ?, ?)').run(id, appId, sellerId, expiresAt);
        this.audit('order.purchase-created', id, `${offer.id}:${offer.revision}`);
      }
      const order = this.order(id);
      const link = z.object({ expires_at: z.number(), app_id: z.string(), seller_id: z.string() }).parse(this.db.prepare('SELECT * FROM alipay_payment_links WHERE order_id = ?').get(id));
      const snapshot = z.object({ offer_body: z.string() }).parse(this.db.prepare('SELECT offer_body FROM purchase_requests WHERE order_id = ?').get(id));
      return { id, state: order.state, amountFen: order.details.amountFen, quantity: order.details.quantity,
        offer: purchaseOfferSchema.parse(JSON.parse(snapshot.offer_body)),
        expiresAt: new Date(link.expires_at).toISOString(), payable: order.state === 'pending' && link.expires_at - this.now() >= 60000 && link.app_id === payment?.appId && link.seller_id === payment.sellerId };
    });
  }
  prepareAlipayPayment(id: string, appId: string, sellerId: string) {
    z.string().regex(/^\d{16}$/).parse(appId); z.string().regex(/^\d{16}$/).parse(sellerId);
    return this.transaction(() => {
      const order = this.order(id);
      if (order.state !== 'pending') throw new ServiceError(409, 'ORDER_ALREADY_FULFILLED', '订单已交付，无需再次付款');
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
    const payment = z.object({ orderId: z.string().uuid(), amountFen: z.number().int().positive(), paymentReference: z.string(),
      appId: z.string().regex(/^\d{16}$/), sellerId: z.string().regex(/^\d{16}$/),
      status: z.enum(['TRADE_SUCCESS', 'TRADE_FINISHED', 'WAIT_BUYER_PAY', 'TRADE_CLOSED']) }).strict().parse(input);
    return this.transaction(() => {
      const order = this.alipayQueryOrder(id, payment.appId, payment.sellerId);
      if (payment.orderId !== id) throw new ServiceError(409, 'PAYMENT_ORDER_MISMATCH', '查单返回了其他订单');
      if (payment.amountFen !== order.amountFen) throw new ServiceError(409, 'AMOUNT_MISMATCH', '查单金额与订单不一致');
      const settled = payment.status === 'TRADE_SUCCESS' || payment.status === 'TRADE_FINISHED';
      const result = settled ? this.fulfillOrder(id, { paymentReference: payment.paymentReference, amountFen: payment.amountFen }, 'alipay', payment) : order;
      this.audit('order.alipay-queried', id, payment.status);
      // 已交付订单的 CLOSED 可能代表退款，记录事实但不推断退款金额或撤销席位。
      return { id, state: result.state, paymentStatus: payment.status, needsReview: !settled && result.state === 'fulfilled' };
    });
  }
  fulfill(id: string, input: unknown, source: 'manual' | 'alipay' = 'manual', paymentIdentity?: { appId: string; sellerId: string }) {
    const payment = paymentSchema.parse(input);
    return this.transaction(() => this.fulfillOrder(id, payment, source, paymentIdentity));
  }
  private fulfillOrder(id: string, payment: z.infer<typeof paymentSchema>, source: 'manual' | 'alipay', paymentIdentity?: { appId: string; sellerId: string }) {
    const order = this.order(id);
    const link = this.db.prepare('SELECT app_id, seller_id FROM alipay_payment_links WHERE order_id = ?').get(id);
    if (link && source === 'alipay' && (link.app_id !== paymentIdentity?.appId || link.seller_id !== paymentIdentity?.sellerId)) throw new ServiceError(409, 'PAYMENT_IDENTITY_MISMATCH', '支付通知与订单绑定的商户或应用不匹配');
    if (link && source === 'manual') throw new ServiceError(409, 'PAYMENT_CHANNEL_MISMATCH', '已生成支付宝付款入口的订单必须先核对渠道交易，不能改成人工核款');
    if (order.details.amountFen !== payment.amountFen) throw new ServiceError(409, 'AMOUNT_MISMATCH', '核款金额与订单不一致');
    if (order.state === 'fulfilled') {
      if (order.payment_reference !== payment.paymentReference) throw new ServiceError(409, 'PAYMENT_CONFLICT', '订单已使用其他流水完成核款');
      return this.describeOrder(id);
    }
    if (this.db.prepare('SELECT id FROM orders WHERE payment_reference = ?').get(payment.paymentReference)) throw new ServiceError(409, 'PAYMENT_REUSED', '收款流水已用于另一订单');
    const purchase = this.db.prepare('SELECT offer_body FROM purchase_requests WHERE order_id = ?').get(id);
    if (purchase) {
      // 自助订单按首次核款发码时间起算，重试和回调不会再次延长期限。
      const offer = purchaseOfferSchema.parse(JSON.parse(z.string().parse(purchase.offer_body)));
      const now = this.now();
      order.details.useUntil = offer.useDays === null ? null : new Date(now + offer.useDays * 86400000).toISOString();
      order.details.updatesUntil = new Date(now + offer.updatesDays * 86400000).toISOString();
      this.db.prepare('UPDATE orders SET body = ? WHERE id = ?').run(JSON.stringify(order.details), id);
    } else if (order.details.useUntil && Date.parse(order.details.useUntil) <= this.now() || Date.parse(order.details.updatesUntil) <= this.now()) throw new ServiceError(409, 'ORDER_EXPIRED', '订单期限已过，请重新确认订单');
    this.db.prepare("UPDATE orders SET state = 'fulfilled', payment_reference = ? WHERE id = ?").run(payment.paymentReference, id);
    for (let index = 0; index < order.details.quantity; index += 1) {
      const code = `TBA-${randomBytes(16).toString('hex').toUpperCase()}`;
      this.db.prepare('INSERT INTO licenses (id, order_id, code_hash, code_cipher) VALUES (?, ?, ?, ?)').run(randomUUID(), id, this.hash(code), this.encrypt(code));
    }
    this.audit(source === 'alipay' ? 'order.alipay-payment-confirmed' : 'order.manual-payment-confirmed', id, payment.paymentReference);
    return this.describeOrder(id);
  }
  describeOrder(id: string) {
    const order = this.order(id);
    const licenses = this.db.prepare('SELECT * FROM licenses WHERE order_id = ? ORDER BY rowid').all(id).map(row => {
      const value = licenseRowSchema.parse(row);
      return { id: value.id, code: this.decrypt(value.code_cipher), machineCode: value.machine, revoked: Boolean(value.revoked), leaseUntil: value.lease_until ? new Date(value.lease_until).toISOString() : null };
    });
    return { id, state: order.state, ...order.details, licenses };
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
      const licenses = order.state === 'fulfilled' ? this.db.prepare('SELECT * FROM licenses WHERE order_id = ? ORDER BY rowid').all(id).map(row => {
        const license = licenseRowSchema.parse(row);
        return { id: license.id, code: license.revoked ? null : this.decrypt(license.code_cipher), revoked: Boolean(license.revoked) };
      }) : [];
      return { id, state: order.state, amountFen: order.details.amountFen, quantity: order.details.quantity,
        kind: order.details.kind, useUntil: order.details.useUntil, updatesUntil: order.details.updatesUntil, licenses };
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
      const order = this.order(license.order_id).details;
      const now = this.now();
      if (order.useUntil && Date.parse(order.useUntil) <= now) throw new ServiceError(403, 'EXPIRED', '授权使用期限已结束');
      const leaseUntil = Math.min(now + 7 * 86400000, order.useUntil ? Date.parse(order.useUntil) : Infinity);
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
