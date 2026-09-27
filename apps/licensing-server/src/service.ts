import { createCipheriv, createDecipheriv, createHmac, createPrivateKey, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { licenseActivationSchema, licenseClaimsSchema } from '../../../packages/schema/src/license';

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
  fulfill(id: string, input: unknown, source: 'manual' | 'alipay' = 'manual') {
    const payment = paymentSchema.parse(input);
    return this.transaction(() => {
      const order = this.order(id);
      if (order.details.amountFen !== payment.amountFen) throw new ServiceError(409, 'AMOUNT_MISMATCH', '核款金额与订单不一致');
      if (order.state === 'fulfilled') {
        if (order.payment_reference !== payment.paymentReference) throw new ServiceError(409, 'PAYMENT_CONFLICT', '订单已使用其他流水完成核款');
        return this.describeOrder(id);
      }
      if (this.db.prepare('SELECT id FROM orders WHERE payment_reference = ?').get(payment.paymentReference)) throw new ServiceError(409, 'PAYMENT_REUSED', '收款流水已用于另一订单');
      if (order.details.useUntil && Date.parse(order.details.useUntil) <= this.now() || Date.parse(order.details.updatesUntil) <= this.now()) throw new ServiceError(409, 'ORDER_EXPIRED', '订单期限已过，请重新确认订单');
      this.db.prepare("UPDATE orders SET state = 'fulfilled', payment_reference = ? WHERE id = ?").run(payment.paymentReference, id);
      for (let index = 0; index < order.details.quantity; index += 1) {
        const code = `TBA-${randomBytes(16).toString('hex').toUpperCase()}`;
        this.db.prepare('INSERT INTO licenses (id, order_id, code_hash, code_cipher) VALUES (?, ?, ?, ?)').run(randomUUID(), id, this.hash(code), this.encrypt(code));
      }
      this.audit(source === 'alipay' ? 'order.alipay-payment-confirmed' : 'order.manual-payment-confirmed', id, payment.paymentReference);
      return this.describeOrder(id);
    });
  }
  describeOrder(id: string) {
    const order = this.order(id);
    const licenses = this.db.prepare('SELECT * FROM licenses WHERE order_id = ? ORDER BY rowid').all(id).map(row => {
      const value = licenseRowSchema.parse(row);
      return { id: value.id, code: this.decrypt(value.code_cipher), machineCode: value.machine, revoked: Boolean(value.revoked), leaseUntil: value.lease_until ? new Date(value.lease_until).toISOString() : null };
    });
    return { id, state: order.state, ...order.details, licenses };
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
      this.audit('license.migrated', id, reason);
      return { code };
    });
  }
}
