import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import { ConsoleAuth, redactConsoleText, type ConsoleSession } from './console-auth';
import { migrateConsole } from './console-database';
import { commandSchema, detailSchema, pageSchema, permissions, resultSchema, rowSchema, sensitiveActions, type ConsoleAction, type ConsoleResult, type ConsoleRow, type PageQuery, type UpdateOutcome, type UpdateRequest, type UpdateStatus } from './console-contract';
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
  (SELECT COALESCE(SUM(amount_fen),0) FROM console_refunds WHERE order_id=o.id) AS refundedFen,
  MAX(COALESCE((SELECT MAX(refund_fen) FROM payment_events WHERE order_id=o.id),0),COALESCE((SELECT SUM(amount_fen) FROM alipay_refunds WHERE order_id=o.id AND state='succeeded'),0),
    COALESCE((SELECT MAX(refunded_total_fen) FROM alipay_refunds WHERE order_id=o.id AND state='succeeded'),0)) AS channelRefundFen,
  (SELECT COALESCE(MAX(refund_fen),0) FROM refund_reviews WHERE order_id=o.id) AS reviewedRefundFen
  FROM orders o LEFT JOIN console_order_meta m ON m.order_id=o.id LEFT JOIN payment_receipts p ON p.order_id=o.id
  LEFT JOIN alipay_payment_links a ON a.order_id=o.id LEFT JOIN wechat_payment_links w ON w.order_id=o.id`;
// 渠道已退而台账未登记的差额（支付宝商户后台直接退款只有渠道通知），按最近一次渠道退款时间记。
const unledgeredRefunds = `SELECT x.id AS orderId,x.channelRefundFen-x.refundedFen AS amountFen,x.paymentReference AS reference,
  COALESCE((SELECT MAX(received_at) FROM payment_events WHERE order_id=x.id AND refund_fen>0),(SELECT MAX(confirmed_at) FROM alipay_refunds WHERE order_id=x.id AND state='succeeded')) AS created
  FROM (${orderProjection}) x WHERE x.channelRefundFen>x.refundedFen`;
// 授权当前截止：单码调整优先，其次最近续费，最后原订单。
const licenseUseUntil = "COALESCE((SELECT use_until FROM license_term_overrides WHERE license_id=l.id),(SELECT MAX(use_until) FROM license_renewals WHERE license_id=l.id),json_extract(o.body,'$.useUntil'))";
// 授权生命周期状态的唯一定义，列表筛选、页签计数、详情和工作台共用。互斥优先级：已撤销 > 已过期 > 七日内到期 > 生效中（已绑定）> 未激活。
// 两个参数依次为当前时间和七日后，见 statusWindow()。
const licenseRows = `SELECT l.id,l.rowid AS position,l.machine AS machine,json_extract(o.body,'$.customer') AS customer,o.reference AS orderReference,COALESCE(m.source,'sale') AS source,
  CASE WHEN l.revoked=1 THEN 'revoked' WHEN ${licenseUseUntil}<=? THEN 'expired' WHEN ${licenseUseUntil}<=? THEN 'expiring' WHEN l.machine IS NOT NULL THEN 'active' ELSE 'unbound' END AS status
  FROM licenses l JOIN orders o ON o.id=l.order_id LEFT JOIN console_order_meta m ON m.order_id=o.id`;
const licenseStatuses = ['active', 'unbound', 'expiring', 'expired', 'revoked'] as const;
const beijingMinute = (iso: string) => new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
const beijingDayStart = (day: string) => new Date(`${day}T00:00:00+08:00`).toISOString();
const beijingDayEnd = (day: string) => new Date(Date.parse(`${day}T00:00:00+08:00`) + 86400000).toISOString();
/** 由 HTTP 层注入的渠道调用；控制台只编排，不直接持有支付宝凭据。 */
export type ConsoleChannels = {
  reconcile: (id: string) => Promise<unknown>;
  refund: (request: ReturnType<LicensingService['prepareAlipayRefund']>) => Promise<{ confirmed: boolean; refundedTotalFen: number }>;
  paymentLink: (id: string) => { url: string; expiresAt: string };
  /** The update spool (update-releases.ts); absent when the server does not run tblink-update-publish.path. */
  updates?: { status: () => Promise<UpdateStatus>; request: (request: UpdateRequest) => Promise<UpdateOutcome | null> };
};
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
  clock(): number { return this.now(); }
  private statusWindow(): [string, string] { return [new Date(this.now()).toISOString(), new Date(this.now() + 7 * 86400000).toISOString()]; }
  /** 授权 DTO：生命周期状态替代绑定、撤销两个布尔值。 */
  private licenseRow(row: ConsoleRow): ConsoleRow {
    const license = this.service.consoleLicense(z.string().parse(row.id));
    return { id: license.id, customer: license.customer, status: row.status ?? null, source: row.source ?? null, orderReference: row.orderReference ?? null, orderId: license.orderId, kind: license.kind,
      useUntil: license.useUntil, updatesUntil: license.updatesUntil, machineCode: license.machineCode, leaseUntil: license.leaseUntil, migrationAfter: license.migrationAfter, lastIssuedAt: license.lastIssuedAt };
  }
  private licenses(where: string, params: SQLInputValue[]): ConsoleRow[] {
    return this.db.prepare(`SELECT id,source,orderReference,status FROM (${licenseRows}) WHERE ${where} ORDER BY position DESC`).all(...this.statusWindow(), ...params).map(row => this.licenseRow(rowSchema.parse(row)));
  }
  private financialRole(session: ConsoleSession): boolean { return session.user.role === 'owner' || session.user.role === 'finance'; }
  private financial(session: ConsoleSession): void { if (!this.financialRole(session)) throw new ServiceError(403, 'FORBIDDEN', '需要财务或管理员权限'); }
  list(resource: string, query: PageQuery, session: ConsoleSession) {
    const term = `%${query.q.replace(/[\\%_]/g, '\\$&')}%`;
    if (resource === 'orders' || resource === 'exceptions') {
      // 异常队列：已收款未交付，或渠道累计退款尚未由运营决定授权去留。
      const extra = resource === 'exceptions' ? " AND (paymentStatus='confirmed' AND state IN ('pending','paid') OR channelRefundFen>reviewedRefundFen)" : '';
      return this.page(`SELECT * FROM (${orderProjection}) WHERE (id LIKE ? ESCAPE '\\' OR reference LIKE ? ESCAPE '\\' OR customer LIKE ? ESCAPE '\\') AND (?='' OR state=?) AND (?='' OR channel=?) AND (?='' OR created>=?) AND (?='' OR created<?)${extra} ORDER BY created DESC,id`,
        [term, term, term, query.state, query.state, query.channel, query.channel, query.from, query.from ? beijingDayStart(query.from) : '', query.to, query.to ? beijingDayEnd(query.to) : ''], query);
    }
    if (resource === 'licenses') {
      const search = "(id LIKE ? ESCAPE '\\' OR customer LIKE ? ESCAPE '\\' OR machine LIKE ? ESCAPE '\\')";
      // 页签计数带搜索词、不带状态筛选。
      const counts = this.db.prepare(`SELECT status,COUNT(*) AS n FROM (${licenseRows}) WHERE ${search} GROUP BY status`).all(...this.statusWindow(), term, term, term);
      const summary: ConsoleRow = Object.fromEntries(licenseStatuses.map(status => [status, Number(counts.find(row => row.status === status)?.n ?? 0)]));
      summary.all = licenseStatuses.reduce((total, status) => total + Number(summary[status]), 0);
      const selected = this.page(`SELECT id,source,orderReference,status FROM (${licenseRows}) WHERE ${search} AND (?='' OR status=?) ORDER BY position DESC`, [...this.statusWindow(), term, term, term, query.state, query.state], query);
      return pageSchema.parse({ ...selected, items: selected.items.map(row => this.licenseRow(row)), summary });
    }
    if (resource === 'tickets') return this.page(`SELECT t.*,o.reference AS orderReference FROM console_tickets t JOIN orders o ON o.id=t.order_id WHERE (t.id LIKE ? ESCAPE '\\' OR o.reference LIKE ? ESCAPE '\\' OR t.note LIKE ? ESCAPE '\\') AND (?='' OR t.state=? OR ?='active' AND t.state!='closed') ORDER BY t.created DESC,t.id`, [term, term, term, query.state, query.state, query.state], query);
    if (resource === 'finance') {
      this.financial(session);
      const finance = `SELECT * FROM (SELECT id,order_id AS orderId,'refund' AS category,amount_fen AS amountFen,reference,handled_at AS created,CASE WHEN reference LIKE 'alipay-refund:%' THEN '支付宝原路退款' ELSE '人工登记退款' END AS state,reason,actor,NULL AS buyer,NULL AS taxId FROM console_refunds UNION ALL SELECT 'channel:'||orderId,orderId,'refund',amountFen,reference,created,'支付宝渠道退款（未登记）',NULL,NULL,NULL,NULL FROM (${unledgeredRefunds}) UNION ALL SELECT id,order_id,'invoice',NULL,reference,created,state,reason,actor,buyer,tax_id FROM console_invoices) WHERE (orderId LIKE ? ESCAPE '\\' OR reference LIKE ? ESCAPE '\\') AND (?='' OR category=?) AND (?='' OR created>=?) AND (?='' OR created<?)`;
      const params = [term, term, query.state, query.state, query.from, query.from ? beijingDayStart(query.from) : '', query.to, query.to ? beijingDayEnd(query.to) : ''];
      // 合计覆盖全部筛选结果，不只是当前页。
      const summary = this.db.prepare(`SELECT COALESCE(SUM(CASE WHEN category='refund' THEN amountFen END),0) AS refundFen,COALESCE(SUM(category='refund'),0) AS refundCount,COALESCE(SUM(category='invoice'),0) AS invoiceCount FROM (${finance})`).get(...params);
      return pageSchema.parse({ ...this.page(`${finance} ORDER BY created DESC,id`, params, query), summary });
    }
    if (resource === 'audit') {
      if (session.user.role !== 'owner') throw new ServiceError(403, 'FORBIDDEN', '只有管理员可以查看全局日志');
      // 对象显示为订单编号、授权所属客户、工单所属订单或用户名；订单、授权、工单可跳转详情。
      return this.page(`SELECT * FROM (SELECT a.*,COALESCE(u.username,a.actor) AS operator,
        CASE WHEN o.id IS NOT NULL THEN 'orders' WHEN l.id IS NOT NULL THEN 'licenses' WHEN t.id IS NOT NULL THEN 'tickets' END AS targetType,
        COALESCE(o.reference,json_extract(lo.body,'$.customer')||' 的授权',tor.reference||' 的工单',tu.username,NULLIF(a.target,'')) AS targetLabel
        FROM console_audit a LEFT JOIN console_users u ON u.id=a.actor LEFT JOIN orders o ON o.id=a.target LEFT JOIN licenses l ON l.id=a.target LEFT JOIN orders lo ON lo.id=l.order_id
        LEFT JOIN console_tickets t ON t.id=a.target LEFT JOIN orders tor ON tor.id=t.order_id LEFT JOIN console_users tu ON tu.id=a.target)
        WHERE (target LIKE ? ESCAPE '\\' OR targetLabel LIKE ? ESCAPE '\\' OR operator LIKE ? ESCAPE '\\' OR reason LIKE ? ESCAPE '\\') AND (?='' OR action=?) ORDER BY at DESC,id`, [term, term, term, term, query.state, query.state], query);
    }
    if (resource === 'users') {
      if (session.user.role !== 'owner') throw new ServiceError(403, 'FORBIDDEN', '只有管理员可以管理人员');
      return pageSchema.parse({ items: this.auth.users().map(user => ({ ...user, status: !user.enrolled ? 'not-enrolled' : user.enabled ? 'enabled' : 'disabled' })), page: 1, hasMore: false });
    }
    throw new ServiceError(404, 'NOT_FOUND', '页面不存在');
  }
  detail(resource: string, id: string, session: ConsoleSession) {
    let item: ConsoleRow; let related: ConsoleRow[] = []; let orderId: string;
    if (resource === 'orders') {
      item = this.order(id); orderId = id;
      const offer = this.db.prepare("SELECT json_extract(offer_body,'$.name') AS offerName,json_extract(offer_body,'$.revision') AS offerRevision,json_extract(offer_body,'$.unitAmountFen') AS unitAmountFen FROM purchase_requests WHERE order_id=?").get(id);
      if (offer) item = { ...item, ...rowSchema.parse(offer) };
      related = this.licenses('id IN (SELECT id FROM licenses WHERE order_id=? OR id IN (SELECT license_id FROM license_renewals WHERE order_id=?))', [id, id]);
    } else if (resource === 'licenses') {
      const found = this.licenses('id=?', [id])[0];
      if (!found) throw new ServiceError(404, 'LICENSE_NOT_FOUND', '授权不存在');
      item = found; orderId = z.string().parse(item.orderId);
      related = this.db.prepare('SELECT order_id AS id,use_until AS useUntil,updates_until AS updatesUntil FROM license_renewals WHERE license_id=? ORDER BY rowid DESC').all(id).map(row => rowSchema.parse(row));
    } else if (resource === 'tickets') {
      const row = this.db.prepare('SELECT t.id,t.order_id,t.license_id,t.category,t.note,t.state,t.conclusion,t.created,t.updated,COALESCE(u.username,t.actor) AS operator FROM console_tickets t LEFT JOIN console_users u ON u.id=t.actor WHERE t.id=?').get(id);
      if (!row) throw new ServiceError(404, 'NOT_FOUND', '工单不存在');
      item = rowSchema.parse(row); orderId = z.string().parse(item.order_id); related = [this.order(orderId)];
    } else throw new ServiceError(404, 'NOT_FOUND', '详情不存在');
    const allowedHistory = session.user.role === 'owner' || session.user.role === 'operations' && Boolean(this.db.prepare("SELECT id FROM console_audit WHERE actor=? AND result='success' AND target IN (?,?) LIMIT 1").get(session.user.id, id, orderId));
    const history = allowedHistory ? this.db.prepare('SELECT a.at,a.action,a.reason,a.result,COALESCE(u.username,a.actor) AS operator FROM console_audit a LEFT JOIN console_users u ON u.id=a.actor WHERE target IN (?,?) ORDER BY a.at DESC LIMIT 100').all(id, orderId).map(row => rowSchema.parse(row)) : [];
    return detailSchema.parse({ item, related, history, ...(resource === 'licenses' ? { timeline: this.timeline(item, orderId, allowedHistory) } : {}) });
  }
  /** 授权生命周期：业务审计是事件来源（含客户端激活和退款自动撤销），后台审计只用来补操作人。 */
  private timeline(license: ConsoleRow, orderId: string, showOperator: boolean): ConsoleRow[] {
    const id = z.string().parse(license.id);
    const events = this.db.prepare(`SELECT at,action,detail FROM audit WHERE target=? AND action IN ('license.activated','license.migrated','license.expiry-adjusted','license.renewed','license.revoked')
      OR target=? AND (action='license.special-grant' OR action='order.state-changed' AND detail LIKE '%->fulfilled:%') ORDER BY at,rowid`).all(id, orderId).map(row => z.object({ at: z.string(), action: z.string(), detail: z.string() }).parse(row));
    // 后台操作与业务审计在同一事务前后写入，按同一对象、前后 5 秒内的最近一条匹配操作人。
    const operator = (at: string, actions: readonly string[]): string | null => {
      if (!showOperator || !actions.length) return null;
      const row = this.db.prepare(`SELECT COALESCE(u.username,c.actor) AS name FROM console_audit c LEFT JOIN console_users u ON u.id=c.actor WHERE c.result='success' AND c.target IN (?,?) AND c.action IN (${actions.map(() => '?').join(',')})
        AND ABS(julianday(c.at)-julianday(?))*86400<=5 ORDER BY ABS(julianday(c.at)-julianday(?)) LIMIT 1`).get(id, orderId, ...actions, at, at);
      return row ? z.string().parse(row.name) : null;
    };
    const sources: Record<string, string> = { sale: '销售', test: '内测', gift: '赠送' };
    const machine = typeof license.machineCode === 'string' ? license.machineCode.replace(/^TB1-/, '').slice(0, 8) : null;
    const lastActivation = events.map(event => event.action).lastIndexOf('license.activated');
    let activations = 0;
    const nodes: ConsoleRow[] = events.map((event, index) => {
      switch (event.action) {
        case 'license.special-grant': case 'order.state-changed': return { at: event.at, event: `签发（${sources[String(license.source)] ?? '销售'}）`, detail: null, operator: operator(event.at, ['fulfill', 'grant', 'retry-delivery']) ?? (showOperator ? '系统自动发码' : null) };
        case 'license.activated': activations++; return { at: event.at, event: activations === 1 ? '首次激活' : '重新激活', detail: index === lastActivation && machine ? `机器码 ${machine}…` : null, operator: showOperator ? '客户端' : null };
        case 'license.migrated': return { at: event.at, event: '换机', detail: '旧码失效，换发新码', operator: operator(event.at, ['migrate']) };
        case 'license.expiry-adjusted': { const change = z.object({ before: z.string().nullable(), after: z.string() }).parse(JSON.parse(event.detail)); return { at: event.at, event: '调整到期', detail: `${change.before ? beijingMinute(change.before) : '永久'} → ${beijingMinute(change.after)}`, operator: operator(event.at, ['set-expiry']) }; }
        case 'license.renewed': return { at: event.at, event: '续费', detail: null, operator: showOperator ? '客户续费' : null };
        default: return { at: event.at, event: '撤销', detail: event.detail, operator: operator(event.at, ['revoke', 'refund-review', 'alipay-refund']) };
      }
    });
    if (license.status === 'expired' && typeof license.useUntil === 'string') nodes.push({ at: license.useUntil, event: '已过期', detail: null, operator: null });
    return nodes;
  }
  overview(session: ConsoleSession) {
    const counts = this.db.prepare(`SELECT SUM(CASE WHEN paymentStatus='pending' AND state='pending' THEN 1 ELSE 0 END) AS pendingOrders,SUM(CASE WHEN paymentStatus='confirmed' AND state IN ('pending','paid') THEN 1 ELSE 0 END) AS deliveryPending,SUM(CASE WHEN channelRefundFen>reviewedRefundFen THEN 1 ELSE 0 END) AS refundReview FROM (${orderProjection})`).get();
    const tickets = this.db.prepare("SELECT COUNT(*) AS openTickets FROM console_tickets WHERE state!='closed'").get();
    const expiring = this.db.prepare(`SELECT COUNT(*) AS expiring FROM (${licenseRows}) WHERE status='expiring'`).get(...this.statusWindow());
    const health = this.db.prepare('SELECT name,state,checked_at AS checkedAt,detail FROM console_health ORDER BY name').all().map(row => rowSchema.parse(row));
    const customers = this.db.prepare("SELECT COUNT(*) AS customerCount FROM (SELECT DISTINCT json_extract(body,'$.customer') COLLATE NOCASE,json_extract(body,'$.customerType') FROM orders WHERE state='fulfilled')").get();
    const bindings = this.db.prepare('SELECT COUNT(*) AS boundLicenseCount FROM licenses WHERE machine IS NOT NULL AND revoked=0').get();
    // 金额与收款趋势只返回给管理员和财务；其他角色只看订单状态类数字。
    const money = this.financialRole(session) ? this.cashflow() : { item: {}, trend: [] };
    return detailSchema.parse({ item: { ...counts, ...money.item, ...tickets, ...expiring, ...customers, ...bindings, service: '正常', backup: health.find(row => row.name === 'backup-last-success')?.checkedAt ?? '暂无回执', recovery: health.find(row => row.name === 'delivery-recovery')?.checkedAt ?? '暂无回执' }, related: [...health, ...money.trend], history: [] });
  }
  private cashflow() {
    const receipts = this.db.prepare("SELECT COALESCE(SUM(CASE WHEN source='manual' THEN amount_fen ELSE 0 END),0) AS manualFen,COALESCE(SUM(CASE WHEN source!='manual' THEN amount_fen ELSE 0 END),0) AS onlineFen FROM payment_receipts").get();
    // 每单退款取台账与渠道累计的较大值：渠道已退未登记的照样扣除，人工登记同一笔不重复扣。
    const refunds = this.db.prepare(`SELECT COALESCE(SUM(MAX(refundedFen,channelRefundFen)),0) AS refundFen FROM (${orderProjection})`).get();
    const today = new Date(this.now() + 8 * 3600000).toISOString().slice(0, 10);
    const days = Array.from({ length: 30 }, (_, index) => new Date(Date.parse(`${today}T00:00:00Z`) - (29 - index) * 86400000).toISOString().slice(0, 10));
    const start = new Date(Date.parse(`${days[0]}T00:00:00+08:00`)).toISOString();
    const end = new Date(Date.parse(`${today}T00:00:00+08:00`) + 86400000).toISOString();
    const income = this.db.prepare("SELECT date(received_at,'+8 hours') AS day,SUM(amount_fen) AS amount FROM payment_receipts WHERE received_at>=? AND received_at<? GROUP BY day").all(start, end);
    const refunded = this.db.prepare(`SELECT date(at,'+8 hours') AS day,SUM(amount) AS amount FROM (SELECT handled_at AS at,amount_fen AS amount FROM console_refunds UNION ALL SELECT created,amountFen FROM (${unledgeredRefunds})) WHERE at>=? AND at<? GROUP BY day`).all(start, end);
    const trend = days.map(day => ({ category: 'cashflow', day, incomeFen: Number(income.find(row => row.day === day)?.amount ?? 0), refundFen: Number(refunded.find(row => row.day === day)?.amount ?? 0) }));
    const netFen = Number(receipts?.onlineFen) + Number(receipts?.manualFen) - Number(refunds?.refundFen);
    return { item: { ...receipts, ...refunds, netFen }, trend };
  }
  private authorize(input: ConsoleAction, session: ConsoleSession): void {
    if (!permissions[input.action].includes(session.user.role)) throw new ServiceError(403, 'FORBIDDEN', '当前角色不能执行此操作');
    if (sensitiveActions.has(input.action) && this.now() - session.verifiedAt >= 300000) throw new ServiceError(403, 'STEP_UP_REQUIRED', '需要二次验证');
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
  async execute(value: unknown, session: ConsoleSession, requestId: string, channels: ConsoleChannels): Promise<ConsoleResult> {
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
      if (input.action === 'reconcile' || input.action === 'fulfill' || input.action === 'retry-delivery' || input.action === 'alipay-refund') {
        this.service.consoleTransaction(begin);
        try {
          // Keep payment receipt durable even if the subsequent delivery transaction fails.
          let result: ConsoleResult;
          if (input.action === 'reconcile') { await channels.reconcile(input.id); result = { id: input.id, message: '查单完成' }; }
          else if (input.action === 'alipay-refund') {
            // 退款请求先落库，渠道结果未确认时保持待确认，运营用新操作编号按原金额重提即复用同一 out_request_no。
            const request = this.service.prepareAlipayRefund(input.id, input.amountFen, input.reason, session.user.id);
            const outcome = await channels.refund(request);
            if (!outcome.confirmed) throw new ServiceError(502, 'REFUND_UNCONFIRMED', '支付宝尚未确认本笔退款，订单与授权未变。请稍后返回表单按相同金额重新提交，支付宝按同一退款请求号去重，不会重复退款');
            return this.service.consoleTransaction(() => finish(this.recordAlipayRefund(request, outcome.refundedTotalFen, session.user.id)));
          }
          else result = this.perform(safeInput, session, operationId);
          return this.service.consoleTransaction(() => finish(result));
        } catch (error) {
          this.db.prepare("UPDATE console_operations SET state='failed',result=? WHERE id=?").run(this.auth.seal(JSON.stringify({ id: input.id, message: error instanceof ServiceError ? error.message : '请求结果未确认，请检查订单付款和交付状态' })), operationId);
          throw error;
        }
      }
      if (input.action === 'publish-update' || input.action === 'rollback-update' || input.action === 'discard-update') {
        if (!channels.updates) throw new ServiceError(503, 'UPDATES_UNAVAILABLE', '本服务器未启用更新发布');
        this.service.consoleTransaction(begin);
        const request: UpdateRequest = input.action === 'publish-update' ? { id: operationId, action: 'publish', staged: input.id, manifestSha256: input.manifestSha256, actor: `${session.user.username} (${session.user.id})`, reason: safeInput.reason }
          : input.action === 'rollback-update' ? { id: operationId, action: 'rollback', version: input.id, actor: `${session.user.username} (${session.user.id})`, reason: safeInput.reason }
            : { id: operationId, action: 'discard', staged: input.id, actor: `${session.user.username} (${session.user.id})`, reason: safeInput.reason };
        const outcome = await channels.updates.request(request);
        // The publisher re-validates everything; its refusal is the result, not a console failure.
        if (outcome && !outcome.ok) {
          this.db.prepare("UPDATE console_operations SET state='failed',result=? WHERE id=?").run(this.auth.seal(JSON.stringify({ id: input.id, message: outcome.message })), operationId);
          throw new ServiceError(409, 'UPDATE_REJECTED', `服务器拒绝：${outcome.message}`);
        }
        return this.service.consoleTransaction(() => finish({ id: input.id, message: outcome?.message ?? '请求已提交，服务器尚未返回结果；请稍后刷新「软件更新」页查看当前发布版本' }));
      }
      if (input.action === 'payment-link') return this.service.consoleTransaction(() => { begin(); const link = channels.paymentLink(input.id); return finish({ id: input.id, message: '付款链接已生成', paymentUrl: link.url, expiresAt: link.expiresAt }); });
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
        return success(order.id, '线下订单已创建，待核款');
      }
      case 'fulfill': this.service.fulfill(input.id, { amountFen: input.amountFen, paymentReference: input.paymentReference }); this.auth.audit(actor, 'manual-payment-method', input.id, input.paymentMethod, 'success', operationId); return success(input.id, '核款与发码已完成');
      // 服务层与本机管理接口仍要求非空原因；后台备注留空时传固定标签。
      case 'retry-delivery': this.service.retryDelivery(input.id, { reason: input.reason || '后台补交付' }); return success(input.id, '补交付已完成');
      case 'close-order': this.service.closeUnlinkedOrder(input.id); return success(input.id, '订单已关闭');
      case 'delivery-access': { const result = this.service.issueDeliveryAccess(input.id, { reason: input.reason || '后台重发领取凭据' }); return { id: input.id, message: '新的领取凭据已签发，旧凭据失效', secret: result.token, expiresAt: result.expiresAt }; }
      case 'revoke-delivery-access': this.service.revokeDeliveryAccess(input.id, { reason: input.reason }); return success(input.id, '领取凭据已撤销');
      case 'reveal': return { id: input.id, message: '完整激活码', secret: this.service.consoleReveal(input.id) };
      case 'set-expiry': { const before = this.service.consoleLicense(input.id).useUntil; this.service.setLicenseExpiry(input.id, input.useUntil, input.reason); this.auth.audit(actor, 'license.expiry-adjusted', input.id, `原截止：${before ?? '永久'}；新截止：${input.useUntil}；${input.reason}`, 'success', operationId); return success(input.id, '到期时间已更新，下次联网验证生效'); }
      case 'revoke': this.service.revoke(input.id, { reason: input.reason }); return success(input.id, '授权已撤销');
      case 'migrate': { const result = this.service.migrate(input.id, { reason: input.reason }); return { id: input.id, message: '换机完成，旧码已失效', secret: result.code }; }
      case 'grant': {
        const result = this.service.createGrant({ customer: input.customer, customerType: input.customerType, quantity: input.quantity, useUntil: input.useUntil }, `GRANT-${operationId}`);
        this.db.prepare('INSERT INTO console_order_meta VALUES(?,?,?,?,?)').run(result.id, at, input.purpose, input.reason, actor);
        return success(result.id, '特殊授权已签发');
      }
      case 'create-user': { const result = this.auth.createUser(input.username, input.role); return { id: result.id, message: '开通凭据 24 小时内有效', secret: result.token }; }
      case 'update-user': this.auth.updateUser(input.id, input.role, input.enabled); return success(input.id, '已更新，该人员需重新登录');
      case 'reset-user': { const result = this.auth.resetUser(input.id); return { id: input.id, message: '认证已重置，请交付新的开通凭据', secret: result.token }; }
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
        return success(input.id, '退款已登记');
      }
      case 'invoice': {
        this.order(input.id);
        if (input.state === 'issued' && !input.reference) throw new ServiceError(400, 'INVOICE_REFERENCE_REQUIRED', '已开票必须填写发票编号');
        if (input.state === 'issued' && this.db.prepare("SELECT id FROM console_invoices WHERE state='issued' AND reference=?").get(input.reference)) throw new ServiceError(409, 'INVOICE_EXISTS', '发票编号已登记');
        this.db.prepare('INSERT INTO console_invoices VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(), input.id, input.state, input.buyer, input.taxId, input.reference, input.reason, actor, at);
        return success(input.id, '开票记录已保存');
      }
      case 'refund-review': {
        const { revoked } = this.service.reviewRefund(input.id, input.decision, input.reason, actor);
        return success(input.id, input.decision === 'revoke' ? `已撤销本订单 ${revoked.length} 份授权，渠道退款处理完成` : '已保留授权，渠道退款处理完成');
      }
      case 'reconcile': case 'alipay-refund': case 'payment-link': throw new ServiceError(500, 'INVALID_DISPATCH', '渠道操作必须通过渠道通道执行');
      case 'publish-update': case 'rollback-update': case 'discard-update': throw new ServiceError(500, 'INVALID_DISPATCH', '更新发布必须通过发布请求执行');
    }
  }
  private recordAlipayRefund(request: ReturnType<LicensingService['prepareAlipayRefund']>, refundedTotalFen: number, actor: string): ConsoleResult {
    const confirmed = this.service.confirmAlipayRefund(request.refundId, refundedTotalFen, actor);
    if (!confirmed) return { id: request.orderId, message: '该笔支付宝退款此前已确认，未重复处理' };
    this.db.prepare('INSERT INTO console_refunds VALUES(?,?,?,?,?,?,?)').run(randomUUID(), request.orderId, request.amountFen, `alipay-refund:${request.refundId}`, new Date(this.now()).toISOString(), request.reason, actor);
    if (confirmed.full && !confirmed.renewal) return { id: request.orderId, message: `支付宝已全额退款，订单已标记退款并撤销 ${confirmed.revoked.length} 份授权` };
    return { id: request.orderId, message: confirmed.renewal ? '支付宝已退款。续费订单不自动撤销原授权，已进入异常队列，请调整原授权到期时间后处理' : '支付宝已部分退款，授权未变，已进入异常队列待处理' };
  }
  /** Owner only: the feed, the version a rollback returns to and the staged releases from the release builder. */
  async updates(session: ConsoleSession, channels: ConsoleChannels) {
    if (session.user.role !== 'owner') throw new ServiceError(403, 'FORBIDDEN', '需要管理员权限');
    if (!channels.updates) throw new ServiceError(503, 'UPDATES_UNAVAILABLE', '本服务器未启用更新发布');
    const status = await channels.updates.status();
    return detailSchema.parse({
      item: { feedVersion: status.feed?.version ?? null, feedReleaseDate: status.feed?.releaseDate ?? null, feedSigned: status.feed?.signed ?? null,
        rollbackVersion: status.rollback.version, rollbackIssue: status.rollback.issue, generatedAt: status.generatedAt },
      related: status.staged.map(entry => ({ id: entry.name, version: entry.version ?? null, releaseDate: entry.releaseDate ?? null, gitSha: entry.gitSha ?? null,
        kid: entry.kid ?? null, size: entry.size ?? null, manifestSha256: entry.manifestSha256 ?? null, issue: entry.issue })),
      history: []
    });
  }
  exportCsv(resource: 'orders' | 'finance', query: PageQuery, session: ConsoleSession, requestId: string): string {
    this.financial(session); const rows: ConsoleRow[] = [];
    for (let page = 1; page <= 201; page++) {
      const result = this.list(resource, { ...query, page }, session); rows.push(...result.items);
      if (rows.length > 10000) throw new ServiceError(400, 'EXPORT_TOO_LARGE', '请缩小筛选范围，单次最多导出一万条');
      if (!result.hasMore) break;
    }
    const fields = resource === 'orders' ? ['id', 'reference', 'channel', 'amountFen', 'paymentStatus', 'state', 'paymentReference', 'receivedAt', 'refundedFen', 'channelRefundFen']
      : ['orderId', 'category', 'amountFen', 'reference', 'state', 'created', 'reason', 'buyer', 'taxId'];
    const escape = (value: ConsoleRow[string] | undefined) => { let text = value === null || value === undefined ? '' : String(value); if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text) || /^\d{16,}$/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; };
    this.auth.audit(session.user.id, `${resource}.export`, '', `记录数 ${rows.length}`, 'success', requestId);
    return '\uFEFF' + [fields.join(','), ...rows.map(row => fields.map(field => escape(row[field])).join(','))].join('\r\n');
  }
}
