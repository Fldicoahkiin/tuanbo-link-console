import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import { ConsoleAuth, redactConsoleText, type ConsoleSession } from './console-auth';
import { migrateConsole } from './console-database';
import { commandSchema, detailSchema, pageSchema, permissions, resultSchema, rowSchema, sensitiveActions, type ConsoleAction, type ConsoleResult, type ConsoleRow, type PageQuery } from './console-contract';
import { ServiceError, type LicensingService } from './service';

const orderProjection = `SELECT o.id,o.reference,json_extract(o.body,'$.customer') AS customer,
  json_extract(o.body,'$.customerType') AS customerType,json_extract(o.body,'$.quantity') AS quantity,
  json_extract(o.body,'$.amountFen') AS amountFen,json_extract(o.body,'$.useUntil') AS useUntil,
  json_extract(o.body,'$.updatesUntil') AS updatesUntil,o.state,
  CASE WHEN m.source IN ('test','gift') THEN m.source ELSE COALESCE(p.source,CASE WHEN w.order_id IS NOT NULL THEN 'wechat' WHEN a.order_id IS NOT NULL THEN 'alipay' ELSE 'manual' END) END AS channel,
  CASE WHEN m.source IN ('test','gift') THEN 'not-applicable' WHEN p.order_id IS NOT NULL THEN 'confirmed' ELSE 'pending' END AS paymentStatus,
  p.payment_reference AS paymentReference,p.received_at AS receivedAt,p.last_error AS deliveryError,
  COALESCE(m.created,(SELECT MIN(at) FROM audit WHERE target=o.id AND action IN ('order.created','order.purchase-created'))) AS created,
  (SELECT COUNT(*) FROM console_tickets WHERE order_id=o.id AND state!='closed') AS openTickets,
  (SELECT COALESCE(SUM(amount_fen),0) FROM console_refunds WHERE order_id=o.id) AS refundedFen
  FROM orders o LEFT JOIN console_order_meta m ON m.order_id=o.id LEFT JOIN payment_receipts p ON p.order_id=o.id
  LEFT JOIN alipay_payment_links a ON a.order_id=o.id LEFT JOIN wechat_payment_links w ON w.order_id=o.id`;
export class ConsoleService {
  readonly auth: ConsoleAuth;
  constructor(private readonly db: DatabaseSync, private readonly service: LicensingService, key: Buffer, private readonly now: () => number = Date.now) {
    migrateConsole(db); this.auth = new ConsoleAuth(db, key, now);
  }
  private page(sql: string, params: SQLInputValue[], query: PageQuery) {
    const items = this.db.prepare(`${sql} LIMIT 51 OFFSET ?`).all(...params, (query.page - 1) * 50).map(row => rowSchema.parse(row));
    return pageSchema.parse({ items: items.slice(0, 50), page: query.page, hasMore: items.length > 50 });
  }
  private order(id: string): ConsoleRow {
    const value = this.db.prepare(`SELECT * FROM (${orderProjection}) WHERE id=?`).get(id);
    if (!value) throw new ServiceError(404, 'ORDER_NOT_FOUND', '订单不存在');
    return rowSchema.parse(value);
  }
  private financial(user: ConsoleSession): void { if (user.user.role !== 'owner' && user.user.role !== 'finance') throw new ServiceError(403, 'FORBIDDEN', '需要财务或负责人权限'); }
  list(resource: string, query: PageQuery, session: ConsoleSession) {
    const term = `%${query.q.replace(/[\\%_]/g, '\\$&')}%`;
    if (resource === 'orders' || resource === 'exceptions') {
      const extra = resource === 'exceptions' ? " AND paymentStatus='confirmed' AND state!='fulfilled'" : '';
      return this.page(`SELECT * FROM (${orderProjection}) WHERE (id LIKE ? ESCAPE '\\' OR reference LIKE ? ESCAPE '\\' OR customer LIKE ? ESCAPE '\\') AND (?='' OR state=?) AND (?='' OR channel=?) AND (?='' OR created>=?) AND (?='' OR created<?)${extra} ORDER BY created DESC,id`,
        [term, term, term, query.state, query.state, query.channel, query.channel, query.from, query.from ? new Date(`${query.from}T00:00:00+08:00`).toISOString() : '', query.to, query.to ? new Date(Date.parse(`${query.to}T00:00:00+08:00`) + 86400000).toISOString() : ''], query);
    }
    if (resource === 'licenses') {
      const selected = this.page(`SELECT l.id,m.source AS source FROM licenses l JOIN orders o ON o.id=l.order_id LEFT JOIN console_order_meta m ON m.order_id=o.id WHERE (l.id LIKE ? ESCAPE '\\' OR json_extract(o.body,'$.customer') LIKE ? ESCAPE '\\' OR l.machine LIKE ? ESCAPE '\\') AND (?='' OR (?='revoked' AND l.revoked=1) OR (?='bound' AND l.machine IS NOT NULL AND l.revoked=0) OR (?='unbound' AND l.machine IS NULL AND l.revoked=0)) ORDER BY l.rowid DESC`, [term, term, term, query.state, query.state, query.state, query.state], query);
      return pageSchema.parse({ ...selected, items: selected.items.map(row => ({ ...this.service.consoleLicense(z.string().parse(row.id)), source: row.source ?? 'sale' })) });
    }
    if (resource === 'tickets') return this.page(`SELECT t.*,o.reference AS orderReference FROM console_tickets t JOIN orders o ON o.id=t.order_id WHERE (t.id LIKE ? ESCAPE '\\' OR o.reference LIKE ? ESCAPE '\\' OR t.note LIKE ? ESCAPE '\\') AND (?='' OR t.state=?) ORDER BY t.created DESC,t.id`, [term, term, term, query.state, query.state], query);
    if (resource === 'finance') {
      this.financial(session);
      return this.page(`SELECT * FROM (SELECT id,order_id AS orderId,'refund' AS category,amount_fen AS amountFen,reference,handled_at AS created,'人工登记退款' AS state,reason,actor,NULL AS buyer,NULL AS taxId FROM console_refunds UNION ALL SELECT id,order_id,'invoice',NULL,reference,created,state,reason,actor,buyer,tax_id FROM console_invoices) WHERE (orderId LIKE ? ESCAPE '\\' OR reference LIKE ? ESCAPE '\\') ORDER BY created DESC,id`, [term, term], query);
    }
    if (resource === 'audit') {
      if (session.user.role !== 'owner') throw new ServiceError(403, 'FORBIDDEN', '只有负责人可以查看全局日志');
      return this.page("SELECT a.*,COALESCE(u.username,a.actor) AS operator FROM console_audit a LEFT JOIN console_users u ON u.id=a.actor WHERE (a.target LIKE ? ESCAPE '\\' OR a.action LIKE ? ESCAPE '\\') ORDER BY a.at DESC,a.id", [term, term], query);
    }
    if (resource === 'users') {
      if (session.user.role !== 'owner') throw new ServiceError(403, 'FORBIDDEN', '只有负责人可以管理人员');
      return pageSchema.parse({ items: this.auth.users(), page: 1, hasMore: false });
    }
    throw new ServiceError(404, 'NOT_FOUND', '页面不存在');
  }
  detail(resource: string, id: string, session: ConsoleSession) {
    let item: ConsoleRow; let related: ConsoleRow[] = []; let orderId: string;
    if (resource === 'orders') {
      item = this.order(id); orderId = id;
      const offer = this.db.prepare("SELECT json_extract(offer_body,'$.name') AS offerName,json_extract(offer_body,'$.revision') AS offerRevision,json_extract(offer_body,'$.unitAmountFen') AS unitAmountFen FROM purchase_requests WHERE order_id=?").get(id);
      if (offer) item = { ...item, ...rowSchema.parse(offer) };
      related = this.db.prepare('SELECT id FROM licenses WHERE order_id=? OR id IN (SELECT license_id FROM license_renewals WHERE order_id=?)').all(id, id).map(row => rowSchema.parse(this.service.consoleLicense(z.string().parse(row.id))));
    } else if (resource === 'licenses') {
      item = rowSchema.parse(this.service.consoleLicense(id)); orderId = z.string().parse(item.orderId);
      related = this.db.prepare('SELECT order_id AS id,use_until AS useUntil,updates_until AS updatesUntil FROM license_renewals WHERE license_id=? ORDER BY rowid DESC').all(id).map(row => rowSchema.parse(row));
    } else if (resource === 'tickets') {
      const row = this.db.prepare('SELECT * FROM console_tickets WHERE id=?').get(id);
      if (!row) throw new ServiceError(404, 'NOT_FOUND', '工单不存在');
      item = rowSchema.parse(row); orderId = z.string().parse(item.order_id); related = [this.order(orderId)];
    } else throw new ServiceError(404, 'NOT_FOUND', '详情不存在');
    const allowedHistory = session.user.role === 'owner' || session.user.role === 'operations' && Boolean(this.db.prepare("SELECT id FROM console_audit WHERE actor=? AND result='success' AND target IN (?,?) LIMIT 1").get(session.user.id, id, orderId));
    const history = allowedHistory ? this.db.prepare('SELECT a.at,a.action,a.reason,a.result,COALESCE(u.username,a.actor) AS operator FROM console_audit a LEFT JOIN console_users u ON u.id=a.actor WHERE target IN (?,?) ORDER BY a.at DESC LIMIT 100').all(id, orderId).map(row => rowSchema.parse(row)) : [];
    return detailSchema.parse({ item, related, history });
  }
  overview() {
    const counts = this.db.prepare(`SELECT SUM(CASE WHEN paymentStatus='pending' AND state='pending' THEN 1 ELSE 0 END) AS pendingOrders,SUM(CASE WHEN paymentStatus='confirmed' AND state!='fulfilled' THEN 1 ELSE 0 END) AS deliveryPending FROM (${orderProjection})`).get();
    const receipts = this.db.prepare("SELECT COALESCE(SUM(CASE WHEN source='manual' THEN amount_fen ELSE 0 END),0) AS manualFen,COALESCE(SUM(CASE WHEN source!='manual' THEN amount_fen ELSE 0 END),0) AS onlineFen FROM payment_receipts").get();
    const refunds = this.db.prepare('SELECT COALESCE(SUM(amount_fen),0) AS refundFen FROM console_refunds').get();
    const tickets = this.db.prepare("SELECT COUNT(*) AS openTickets FROM console_tickets WHERE state!='closed'").get();
    const expiring = this.db.prepare(`SELECT COUNT(*) AS expiring FROM licenses l JOIN orders o ON o.id=l.order_id WHERE l.revoked=0 AND COALESCE((SELECT use_until FROM license_term_overrides WHERE license_id=l.id),(SELECT MAX(use_until) FROM license_renewals WHERE license_id=l.id),json_extract(o.body,'$.useUntil'))>? AND COALESCE((SELECT use_until FROM license_term_overrides WHERE license_id=l.id),(SELECT MAX(use_until) FROM license_renewals WHERE license_id=l.id),json_extract(o.body,'$.useUntil'))<=?`).get(new Date(this.now()).toISOString(), new Date(this.now() + 7 * 86400000).toISOString());
    const health = this.db.prepare('SELECT name,state,checked_at AS checkedAt,detail FROM console_health ORDER BY name').all().map(row => rowSchema.parse(row));
    const customers = this.db.prepare("SELECT COUNT(*) AS customerCount FROM (SELECT DISTINCT json_extract(body,'$.customer') COLLATE NOCASE,json_extract(body,'$.customerType') FROM orders WHERE state='fulfilled')").get();
    const bindings = this.db.prepare('SELECT COUNT(*) AS boundLicenseCount FROM licenses WHERE machine IS NOT NULL AND revoked=0').get();
    const today = new Date(this.now() + 8 * 3600000).toISOString().slice(0, 10);
    const days = Array.from({ length: 30 }, (_, index) => new Date(Date.parse(`${today}T00:00:00Z`) - (29 - index) * 86400000).toISOString().slice(0, 10));
    const start = new Date(Date.parse(`${days[0]}T00:00:00+08:00`)).toISOString();
    const end = new Date(Date.parse(`${today}T00:00:00+08:00`) + 86400000).toISOString();
    const income = this.db.prepare("SELECT date(received_at,'+8 hours') AS day,SUM(amount_fen) AS amount FROM payment_receipts WHERE received_at>=? AND received_at<? GROUP BY day").all(start, end);
    const refunded = this.db.prepare("SELECT date(handled_at,'+8 hours') AS day,SUM(amount_fen) AS amount FROM console_refunds WHERE handled_at>=? AND handled_at<? GROUP BY day").all(start, end);
    const trend = days.map(day => ({ category: 'cashflow', day, incomeFen: Number(income.find(row => row.day === day)?.amount ?? 0), refundFen: Number(refunded.find(row => row.day === day)?.amount ?? 0) }));
    return detailSchema.parse({ item: { ...counts, ...receipts, ...refunds, ...tickets, ...expiring, ...customers, ...bindings, service: '正常', backup: health.find(row => row.name === 'backup-last-success')?.checkedAt ?? '未知：尚无成功备份回执', recovery: health.find(row => row.name === 'delivery-recovery')?.checkedAt ?? '未知：尚无恢复任务回执' }, related: [...health, ...trend], history: [] });
  }
  private authorize(input: ConsoleAction, session: ConsoleSession): void {
    if (!permissions[input.action].includes(session.user.role)) throw new ServiceError(403, 'FORBIDDEN', '当前角色不能执行此操作');
    if (sensitiveActions.has(input.action) && this.now() - session.verifiedAt >= 300000) throw new ServiceError(403, 'STEP_UP_REQUIRED', '请先在安全设置中完成二次验证');
  }
  operation(id: string, session: ConsoleSession): ConsoleResult {
    const row = this.db.prepare('SELECT result,state FROM console_operations WHERE id=? AND actor=?').get(id, session.user.id);
    if (!row) throw new ServiceError(404, 'OPERATION_NOT_FOUND', '尚无此操作记录，可按原操作编号重试');
    if (row.state === 'pending') throw new ServiceError(409, 'OPERATION_PENDING', '操作结果待确认，请查询对象当前状态，勿新建重复操作');
    // Recovered results never reveal stored secrets without a fresh privileged read.
    const result = resultSchema.parse(JSON.parse(this.auth.open(z.string().parse(row.result))));
    if (row.state === 'failed') return { ...(result.id ? { id: result.id } : {}), message: `原操作未完成：${result.message}。请核对订单状态后再发起新的操作。` };
    return resultSchema.parse({ ...(result.id ? { id: result.id } : {}), message: `${result.message}；如需完整凭据，请重新执行受保护的查看操作` });
  }
  async execute(value: unknown, session: ConsoleSession, requestId: string, reconcile: (id: string) => Promise<unknown>): Promise<ConsoleResult> {
    const { operationId, input } = commandSchema.parse(value); const target = 'id' in input ? input.id : operationId;
    const safeInput: ConsoleAction = { ...input, reason: redactConsoleText(input.reason) };
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    try {
      this.authorize(input, session);
      const prior = this.db.prepare('SELECT actor,fingerprint,result,state FROM console_operations WHERE id=?').get(operationId);
      if (prior) {
        if (prior.actor !== session.user.id || prior.fingerprint !== fingerprint) throw new ServiceError(409, 'OPERATION_CONFLICT', '操作编号已用于不同请求');
        return this.operation(operationId, session);
      }
      const begin = () => this.db.prepare("INSERT INTO console_operations VALUES(?,?,?,NULL,'pending',?)").run(operationId, session.user.id, fingerprint, new Date(this.now()).toISOString());
      const finish = (result: ConsoleResult) => {
        this.db.prepare("UPDATE console_operations SET state='done',result=? WHERE id=?").run(this.auth.seal(JSON.stringify(resultSchema.parse(result))), operationId);
        this.auth.audit(session.user.id, input.action, result.id ?? target, input.reason, 'success', requestId); return result;
      };
      if (input.action === 'reconcile' || input.action === 'fulfill' || input.action === 'retry-delivery') {
        this.service.consoleTransaction(begin);
        try {
          // Keep payment receipt durable even if the subsequent delivery transaction fails.
          let result: ConsoleResult;
          if (input.action === 'reconcile') { await reconcile(input.id); result = { id: input.id, message: '查单已完成，请刷新订单查看实际付款与交付状态' }; }
          else result = this.perform(safeInput, session, operationId);
          return this.service.consoleTransaction(() => finish(result));
        } catch (error) {
          this.db.prepare("UPDATE console_operations SET state='failed',result=? WHERE id=?").run(this.auth.seal(JSON.stringify({ id: input.id, message: error instanceof ServiceError ? error.message : '请求结果未确认，请检查订单付款和交付状态' })), operationId);
          throw error;
        }
      }
      return this.service.consoleTransaction(() => { begin(); return finish(this.perform(safeInput, session, operationId)); });
    } catch (error) {
      this.auth.audit(session.user.id, input.action, target, input.reason, error instanceof ServiceError ? error.code : 'INTERNAL_ERROR', requestId); throw error;
    }
  }
  private perform(input: ConsoleAction, session: ConsoleSession, operationId: string): ConsoleResult {
    const actor = session.user.id; const at = new Date(this.now()).toISOString();
    const success = (id: string, message: string): ConsoleResult => ({ id, message });
    switch (input.action) {
      case 'create-order': {
        const order = this.service.createOrder({ reference: input.reference, customer: input.customer, customerType: input.customerType, quantity: input.quantity, kind: 'subscription', amountFen: input.amountFen, useUntil: input.useUntil, updatesUntil: input.useUntil });
        this.db.prepare('INSERT OR IGNORE INTO console_order_meta VALUES(?,?,?,?,?)').run(order.id, at, 'manual', input.reason, actor);
        return success(order.id, '线下订单已创建，等待财务核款');
      }
      case 'fulfill': this.service.fulfill(input.id, { amountFen: input.amountFen, paymentReference: input.paymentReference }); this.auth.audit(actor, 'manual-payment-method', input.id, input.paymentMethod, 'success', operationId); return success(input.id, '核款与发码已完成');
      case 'retry-delivery': this.service.retryDelivery(input.id, { reason: input.reason }); return success(input.id, '补交付已完成');
      case 'delivery-access': { const result = this.service.issueDeliveryAccess(input.id, { reason: input.reason }); return { id: input.id, message: '新的领取凭据已签发，旧凭据失效', secret: result.token, expiresAt: result.expiresAt }; }
      case 'revoke-delivery-access': this.service.revokeDeliveryAccess(input.id, { reason: input.reason }); return success(input.id, '领取凭据已撤销');
      case 'reveal': return { id: input.id, message: '请仅向已核实的授权持有人交付', secret: this.service.consoleReveal(input.id) };
      case 'set-expiry': { const before = this.service.consoleLicense(input.id).useUntil; this.service.setLicenseExpiry(input.id, input.useUntil, input.reason); this.auth.audit(actor, 'license.expiry-adjusted', input.id, `原截止：${before ?? '永久'}；新截止：${input.useUntil}；${input.reason}`, 'success', operationId); return success(input.id, '到期时间已更新；下次联网验证生效，已签发凭证不会立即失效'); }
      case 'revoke': this.service.revoke(input.id, { reason: input.reason }); return success(input.id, '授权已撤销；已经开始的会话不会立即停止');
      case 'migrate': { const result = this.service.migrate(input.id, { reason: input.reason }); return { id: input.id, message: '换机完成，旧码失效，新码尚未绑定', secret: result.code }; }
      case 'grant': {
        const result = this.service.createGrant({ customer: input.customer, customerType: input.customerType, quantity: input.quantity, useUntil: input.useUntil }, `GRANT-${operationId}`);
        this.db.prepare('INSERT INTO console_order_meta VALUES(?,?,?,?,?)').run(result.id, at, input.purpose, input.reason, actor);
        return success(result.id, '特殊授权已签发，不计入收款台账；在订单详情中查看授权');
      }
      case 'create-user': { const result = this.auth.createUser(input.username, input.role); return { id: result.id, message: '请私下交付一次性开通凭据，24 小时内有效', secret: result.token }; }
      case 'update-user': this.auth.updateUser(input.id, input.role, input.enabled); return success(input.id, '人员权限已更新，已有会话已撤销');
      case 'reset-user': { const result = this.auth.resetUser(input.id); return { id: input.id, message: '认证已重置，原会话失效；请交付新的开通凭据', secret: result.token }; }
      case 'create-ticket': {
        this.order(input.id);
        if (input.licenseId && !this.db.prepare('SELECT id FROM licenses WHERE id=? AND (order_id=? OR id IN (SELECT license_id FROM license_renewals WHERE order_id=?))').get(input.licenseId, input.id, input.id)) throw new ServiceError(400, 'LICENSE_ORDER_MISMATCH', '授权不属于此订单');
        const id = randomUUID(); this.db.prepare("INSERT INTO console_tickets VALUES(?,?,?,?,?,'open','',?,?,?)").run(id, input.id, input.licenseId, input.category, input.note, at, at, actor);
        return success(id, '售后工单已创建');
      }
      case 'update-ticket': {
        const prior = this.db.prepare('SELECT id,state FROM console_tickets WHERE id=?').get(input.id);
        if (!prior) throw new ServiceError(404, 'NOT_FOUND', '工单不存在');
        if (prior.state === 'closed') throw new ServiceError(409, 'TICKET_CLOSED', '已关闭工单不能改写，请另建工单');
        if (input.state === 'closed' && !input.conclusion) throw new ServiceError(400, 'CONCLUSION_REQUIRED', '关闭前必须记录授权处理结论');
        this.db.prepare('UPDATE console_tickets SET state=?,conclusion=?,updated=? WHERE id=?').run(input.state, input.conclusion, at, input.id); return success(input.id, '工单已更新');
      }
      case 'refund': {
        const order = this.order(input.id); const receipt = this.db.prepare('SELECT amount_fen FROM payment_receipts WHERE order_id=?').get(input.id);
        if (!receipt || order.channel === 'test' || order.channel === 'gift') throw new ServiceError(409, 'NOT_PAID', '仅已确认收款订单可登记退款');
        if (Number(order.refundedFen) + input.amountFen > Number(receipt.amount_fen)) throw new ServiceError(409, 'REFUND_EXCEEDED', '累计退款超过已确认收款');
        if (Date.parse(input.handledAt) > this.now()) throw new ServiceError(400, 'FUTURE_REFUND', '实际办理时间不能晚于当前时间');
        if (this.db.prepare('SELECT id FROM console_refunds WHERE reference=?').get(input.reference)) throw new ServiceError(409, 'REFUND_REFERENCE_USED', '退款凭证编号已经登记');
        this.db.prepare('INSERT INTO console_refunds VALUES(?,?,?,?,?,?,?)').run(randomUUID(), input.id, input.amountFen, input.reference, input.handledAt, input.reason, actor);
        return success(input.id, '已人工登记退款；系统未调用退款渠道，授权需单独处理');
      }
      case 'invoice': {
        this.order(input.id);
        if (input.state === 'issued' && !input.reference) throw new ServiceError(400, 'INVOICE_REFERENCE_REQUIRED', '已开票必须填写发票编号');
        if (input.state === 'issued' && this.db.prepare("SELECT id FROM console_invoices WHERE state='issued' AND reference=?").get(input.reference)) throw new ServiceError(409, 'INVOICE_EXISTS', '发票编号已登记');
        this.db.prepare('INSERT INTO console_invoices VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(), input.id, input.state, input.buyer, input.taxId, input.reference, input.reason, actor, at);
        return success(input.id, '开票处理记录已保存；系统未调用开票服务');
      }
      case 'reconcile': throw new ServiceError(500, 'INVALID_DISPATCH', '查单必须通过异步通道执行');
    }
  }
  exportOrders(query: PageQuery, session: ConsoleSession, requestId: string): string {
    this.financial(session); const rows: ConsoleRow[] = [];
    for (let page = 1; page <= 201; page++) {
      const result = this.list('orders', { ...query, page }, session); rows.push(...result.items);
      if (rows.length > 10000) throw new ServiceError(400, 'EXPORT_TOO_LARGE', '请缩小筛选范围，单次最多导出一万条');
      if (!result.hasMore) break;
    }
    const fields = ['id', 'reference', 'channel', 'amountFen', 'paymentStatus', 'state', 'paymentReference', 'receivedAt', 'refundedFen'];
    const escape = (value: ConsoleRow[string] | undefined) => { let text = value === null || value === undefined ? '' : String(value); if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text) || /^\d{16,}$/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; };
    this.auth.audit(session.user.id, 'orders.export', '', `记录数 ${rows.length}`, 'success', requestId);
    return '\uFEFF' + [fields.join(','), ...rows.map(row => fields.map(field => escape(row[field])).join(','))].join('\r\n');
  }
}
