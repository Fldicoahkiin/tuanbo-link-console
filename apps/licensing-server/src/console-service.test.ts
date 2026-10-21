import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { LicensingService } from './service';
import { totpCode, type ConsoleSession } from './console-auth';
import { pageQuerySchema, permissions, type ConsoleAction } from './console-contract';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const keys = generateKeyPairSync('ed25519');
const closing: (() => void)[] = [];
afterEach(() => closing.splice(0).reverse().forEach(close => close()));
async function setup() {
  let time = Date.parse('2026-10-06T00:00:00Z');
  const path = join(mkdtempSync(join(tmpdir(), 'tblink-console-')), 'test.db');
  const service = new LicensingService(path, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'test', randomBytes(32), () => time);
  closing.push(() => service.close());
  const consoleService = service.console(randomBytes(32));
  const db = new DatabaseSync(path); closing.push(() => db.close());
  const first = consoleService.auth.bootstrap('owner');
  const code = (id: string) => totpCode(consoleService.auth.open(String(db.prepare('SELECT totp FROM console_users WHERE id=?').get(id)?.totp)), Math.floor(time / 30000));
  const recovery = await consoleService.auth.enroll(first.token, 'a-secure-test-password', code(first.id), 'enroll');
  time += 30000;
  const login = await consoleService.auth.login('owner', 'a-secure-test-password', code(first.id), 'login');
  const paymentLink = (id: string) => { const payment = service.prepareAlipayPayment(id, '2026000000000001', '2088000000000001'); return { url: `https://openapi.alipay.com/gateway.do?order=${payment.id}`, expiresAt: payment.expiresAt }; };
  const execute = (input: ConsoleAction, session = login.session, operationId = randomUUID()) => consoleService.execute({ operationId, input }, session, randomUUID(), { reconcile: () => Promise.resolve({}), refund: () => Promise.reject(new Error('测试未接入支付宝')), paymentLink });
  return { service, consoleService, db, first, login, recovery, code, execute, advance: (n: number) => { time += n; }, now: () => time };
}
const grant = { action: 'grant' as const, customer: '内测客户', customerType: 'company' as const, quantity: 2, useUntil: '2026-11-06T00:00:00Z', purpose: 'test' as const, reason: '现场兼容验收' };
it('一次性开通、TOTP 防重放、恢复码及会话时限', async () => {
  const s = await setup();
  expect(() => s.consoleService.auth.enrollmentInfo(s.first.token)).toThrow('无效');
  await expect(s.consoleService.auth.login('owner', 'a-secure-test-password', s.code(s.first.id), 'repeat')).rejects.toThrow('无效');
  const recovered = await s.consoleService.auth.login('owner', 'a-secure-test-password', s.recovery.recoveryCodes[0]!, 'recover');
  expect(recovered.session.user.role).toBe('owner');
  await expect(s.consoleService.auth.login('owner', 'a-secure-test-password', s.recovery.recoveryCodes[0]!, 'repeat')).rejects.toThrow('无效');
  s.advance(1800001); expect(() => s.consoleService.auth.session(recovered.token)).toThrow('登录');
});
it('知道密码也不能跨来源穷举验证码，锁定期间同样返回无效登录', async () => {
  const s = await setup(); s.advance(30000);
  const wrong = String((Number(s.code(s.first.id)) + 500000) % 1000000).padStart(6, '0');
  for (let index = 0; index < 10; index++) await expect(s.consoleService.auth.login('owner', 'a-secure-test-password', wrong, 'guess')).rejects.toThrow('无效');
  await expect(s.consoleService.auth.login('owner', 'a-secure-test-password', s.code(s.first.id), 'locked')).rejects.toThrow('无效');
  s.advance(900001);
  expect((await s.consoleService.auth.login('owner', 'a-secure-test-password', s.code(s.first.id), 'after')).session.user.role).toBe('owner');
});
it('特殊授权一码一机，不写入收款，重复提交不重复发码', async () => {
  const s = await setup(); const operationId = randomUUID(); const result = await s.execute(grant, s.login.session, operationId);
  await s.execute(grant, s.login.session, operationId);
  expect(s.db.prepare('SELECT COUNT(*) AS n FROM licenses').get()?.n).toBe(2);
  expect(s.db.prepare('SELECT COUNT(*) AS n FROM payment_receipts').get()?.n).toBe(0);
  const licenses = s.consoleService.detail('orders', result.id!, s.login.session).related;
  const revealed = await s.execute({ action: 'reveal', id: String(licenses[0]!.id), reason: '交付' });
  const machine = `TB1-${'A'.repeat(64)}`;
  expect(s.service.activate({ product: 'tuanbo-link-console', code: revealed.secret, machineCode: machine }).license).toBeTruthy();
  expect(() => s.service.activate({ product: 'tuanbo-link-console', code: revealed.secret, machineCode: `TB1-${'B'.repeat(64)}` })).toThrow('另一台');
  await expect(s.execute({ ...grant, quantity: 3 }, s.login.session, operationId)).rejects.toThrow('不同请求');
  await expect(s.execute({ action: 'refund', id: result.id!, amountFen: 1, reference: 'fake', handledAt: new Date(s.now()).toISOString(), reason: '不应允许' })).rejects.toThrow('收款');
  expect(JSON.stringify(s.consoleService.list('licenses', pageQuerySchema.parse({}), s.login.session))).not.toContain(revealed.secret);
  expect(JSON.stringify(s.db.prepare('SELECT * FROM console_audit').all())).not.toContain(revealed.secret);
});
it('服务端角色、近期验证与最后管理员保护', async () => {
  const s = await setup();
  for (const role of ['operations', 'finance', 'viewer'] as const) {
    const session: ConsoleSession = { ...s.login.session, user: { ...s.login.session.user, role } };
    await expect(s.execute(grant, session)).rejects.toThrow('角色');
  }
  await expect(s.execute({ action: 'update-user', id: s.first.id, role: 'viewer', enabled: true, reason: '测试' })).rejects.toThrow('最后');
  await expect(s.execute({ action: 'reset-user', id: s.first.id, reason: '测试' })).rejects.toThrow('另一名');
  s.advance(300001); await expect(s.execute(grant)).rejects.toThrow('二次验证');
});
it('核款、退款上限及财务导出隔离', async () => {
  const s = await setup(); const result = await s.execute({ action: 'create-order', reference: '=1+1', customer: '客户', customerType: 'company', quantity: 1, amountFen: 80000, useUntil: '2026-11-06T00:00:00Z', reason: '线下成交' });
  await s.execute({ action: 'fulfill', id: result.id!, amountFen: 80000, paymentReference: 'bank-1', paymentMethod: '对公转账', reason: '已核实' });
  await s.execute({ action: 'refund', id: result.id!, amountFen: 70000, reference: 'refund-1', handledAt: new Date(s.now()).toISOString(), reason: '线下退款已办理' });
  await expect(s.execute({ action: 'refund', id: result.id!, amountFen: 10001, reference: 'refund-2', handledAt: new Date(s.now()).toISOString(), reason: '超额' })).rejects.toThrow('超过');
  const csv = s.consoleService.exportCsv('orders', pageQuerySchema.parse({}), s.login.session, 'export');
  expect(csv).toContain("'=1+1"); expect(csv).not.toContain('TBA-'); expect(csv).not.toContain('客户');
  expect(s.consoleService.overview(s.login.session).item.manualFen).toBe(80000);
  expect(s.consoleService.overview(s.login.session).item.refundFen).toBe(70000);
  expect(s.consoleService.overview(s.login.session).item.netFen).toBe(10000);
});
it('换机沿用旧租约等待并吊销旧码', async () => {
  const s = await setup(); const result = await s.execute(grant);
  const license = s.consoleService.detail('orders', result.id!, s.login.session).related[0]!;
  const id = String(license.id); const code = s.service.consoleReveal(id);
  s.service.activate({ product: 'tuanbo-link-console', code, machineCode: `TB1-${'A'.repeat(64)}` });
  await s.execute({ action: 'revoke', id, reason: '换机' });
  await expect(s.execute({ action: 'migrate', id, reason: '提前换机' })).rejects.toThrow('等待');
  s.advance(48 * 3600000 + 300001);
  const fresh = { ...s.login.session, verifiedAt: s.now() };
  const next = await s.execute({ action: 'migrate', id, reason: '旧租约已结束' }, fresh);
  expect(next.secret).not.toBe(code);
  expect(() => s.service.activate({ product: 'tuanbo-link-console', code, machineCode: `TB1-${'A'.repeat(64)}` })).toThrow('无效');
});
it('工单关联、关闭结论与发票登记', async () => {
  const s = await setup(); const order = await s.execute(grant);
  const ticket = await s.execute({ action: 'create-ticket', id: order.id!, licenseId: null, category: 'other', note: '问题记录', reason: '联系客户' });
  await expect(s.execute({ action: 'update-ticket', id: ticket.id!, state: 'closed', conclusion: '', reason: '完成' })).rejects.toThrow('结论');
  await s.execute({ action: 'update-ticket', id: ticket.id!, state: 'closed', conclusion: '无需变更授权', reason: '完成' });
  await s.execute({ action: 'invoice', id: order.id!, state: 'requested', buyer: '客户抬头', taxId: '', reference: '', reason: '人工咨询记录' });
  expect(s.consoleService.list('finance', pageQuerySchema.parse({}), s.login.session).items).toHaveLength(1);
});
it('TOTP 使用标准 SHA1 向量，日期范围拒绝无效日历值', () => {
  expect(totpCode(Buffer.from('12345678901234567890').toString('hex'), 1)).toBe('287082');
  expect(() => pageQuerySchema.parse({ from: '2026-02-30' })).toThrow();
  expect(() => pageQuerySchema.parse({ from: '2026-10-07', to: '2026-10-06' })).toThrow();
});
it('核款事实在交付失败后保留，原操作可查询，不能重复收费', async () => {
  const s = await setup(); const order = await s.execute({ action: 'create-order', reference: 'expired-delivery', customer: '客户', customerType: 'company', quantity: 1, amountFen: 80000, useUntil: '2026-10-07T00:00:00Z', reason: '成交' });
  s.advance(2 * 86400000); const fresh = { ...s.login.session, verifiedAt: s.now() }; const operationId = randomUUID();
  await expect(s.execute({ action: 'fulfill', id: order.id!, amountFen: 80000, paymentReference: 'real-confirmed-payment', paymentMethod: '转账', reason: '真实到账' }, fresh, operationId)).rejects.toThrow('期限已过');
  expect(s.db.prepare('SELECT COUNT(*) AS n FROM payment_receipts').get()?.n).toBe(1);
  expect(s.consoleService.operation(operationId, fresh).message).toContain('未完成');
  expect(s.consoleService.list('exceptions', pageQuerySchema.parse({}), fresh).items).toHaveLength(1);
});
it('迁移前旧订单和领取凭据保持兼容，重复初始化不改写历史', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'console-migrate-')), 'old.db');
  const dataKey = randomBytes(32); const consoleKey = randomBytes(32); const now = () => Date.parse('2026-10-06T00:00:00Z');
  const service = new LicensingService(path, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'test', dataKey, now); closing.push(() => service.close());
  const order = service.createOrder({ reference: 'legacy-order', customer: '旧客户', customerType: 'company', quantity: 1, kind: 'subscription', amountFen: 80000, useUntil: '2026-11-06T00:00:00Z', updatesUntil: '2026-11-06T00:00:00Z' });
  const paid = service.fulfill(order.id, { amountFen: 80000, paymentReference: 'legacy-bank' });
  const delivery = service.issueDeliveryAccess(order.id, { reason: '历史交付' });
  const before = service.describeOrder(order.id); service.console(consoleKey); service.console(consoleKey);
  expect(service.describeOrder(order.id)).toEqual(before);
  expect(service.readDelivery(order.id, delivery.token).licenses[0]?.code).toBe(paid.licenses[0]?.code);
  expect(service.activate({ product: 'tuanbo-link-console', code: paid.licenses[0]!.code, machineCode: `TB1-${'C'.repeat(64)}` }).license).toBeTruthy();
});

it('单码期限调整隔离同订单授权、幂等、权限和到期验证', async () => {
  const s = await setup(); const result = await s.execute(grant);
  const licenses = s.consoleService.detail('orders', result.id!, s.login.session).related;
  const id = String(licenses[0]!.id); const other = String(licenses[1]!.id);
  const input = { action: 'set-expiry' as const, id, useUntil: '2026-10-08T00:00:00Z', reason: '调整测试期限' };
  for (const role of ['operations', 'finance', 'viewer'] as const) {
    await expect(s.execute(input, { ...s.login.session, user: { ...s.login.session.user, role } })).rejects.toThrow('角色');
  }
  const operation = randomUUID(); await s.execute(input, s.login.session, operation); await s.execute(input, s.login.session, operation);
  expect(s.service.consoleLicense(id).useUntil).toBe(input.useUntil);
  expect(s.service.consoleLicense(other).useUntil).toBe(grant.useUntil);
  expect(s.consoleService.overview(s.login.session).item.expiring).toBe(1);
  expect(s.db.prepare("SELECT COUNT(*) AS n FROM console_audit WHERE action='license.expiry-adjusted'").get()?.n).toBe(1);
  const code = s.service.consoleReveal(id);
  expect(s.service.activate({ product: 'tuanbo-link-console', code, machineCode: `TB1-${'D'.repeat(64)}` }).license).toBeTruthy();
  await expect(s.execute({ ...input, useUntil: '2026-01-01T00:00:00Z' })).rejects.toThrow('晚于');
  s.advance(3 * 86400000);
  expect(() => s.service.activate({ product: 'tuanbo-link-console', code, machineCode: `TB1-${'D'.repeat(64)}` })).toThrow('期限');
  await expect(s.execute(input)).rejects.toThrow('二次验证');
  await s.execute({ ...input, useUntil: '2026-12-01T00:00:00Z' }, { ...s.login.session, verifiedAt: s.now() });
  expect(s.service.activate({ product: 'tuanbo-link-console', code, machineCode: `TB1-${'D'.repeat(64)}` }).license).toBeTruthy();
  await s.execute({ action: 'revoke', id, reason: '结束' }, { ...s.login.session, verifiedAt: s.now() });
  await expect(s.execute(input, { ...s.login.session, verifiedAt: s.now() })).rejects.toThrow('撤销');
});

it('工作台按已交付客户去重并按北京时间汇总实际收款', async () => {
  const s = await setup(); await s.execute(grant); await s.execute(grant);
  const order = await s.execute({ action: 'create-order', reference: 'trend-test', customer: '付费客户', customerType: 'company', quantity: 2, amountFen: 50000, useUntil: grant.useUntil, reason: '测试' });
  expect(s.consoleService.overview(s.login.session).item.customerCount).toBe(1);
  await s.execute({ action: 'fulfill', id: order.id!, amountFen: 50000, paymentReference: 'trend-payment', paymentMethod: '转账', reason: '到账' });
  s.db.prepare('UPDATE payment_receipts SET received_at=? WHERE order_id=?').run('2026-10-05T16:00:00.000Z', order.id!);
  await s.execute({ action: 'refund', id: order.id!, amountFen: 10000, reference: 'trend-refund', handledAt: '2026-10-05T15:59:00.000Z', reason: '人工登记' });
  const dashboard = s.consoleService.overview(s.login.session); const trend = dashboard.related.filter(row => row.category === 'cashflow');
  expect(dashboard.item.customerCount).toBe(2); expect(dashboard.item.boundLicenseCount).toBe(0);
  expect(trend).toHaveLength(30);
  expect(trend.find(row => row.day === '2026-10-06')?.incomeFen).toBe(50000);
  expect(trend.find(row => row.day === '2026-10-05')?.refundFen).toBe(10000);
  expect(trend.reduce((sum, row) => sum + Number(row.incomeFen), 0)).toBe(50000);
});
it('渠道退款通知进入异常队列且不自动撤销授权，人工登记只记账，运营处理后出列', async () => {
  const s = await setup(); const identity = { appId: '2026000000000001', sellerId: '2088000000000001' };
  const order = s.service.createOrder({ reference: 'refund-queue', customer: '退款客户', customerType: 'company', quantity: 1, kind: 'perpetual', amountFen: 80000, useUntil: null, updatesUntil: '2027-10-06T00:00:00Z' });
  s.service.prepareAlipayPayment(order.id, identity.appId, identity.sellerId);
  const notice = { orderId: order.id, ...identity, status: 'TRADE_SUCCESS', amountFen: 80000, refundFen: 0, paymentReference: 'alipay:202610062200000000000001' };
  s.service.alipayNotification(notice);
  const exceptions = () => s.consoleService.list('exceptions', pageQuerySchema.parse({}), s.login.session).items.map(row => row.id);
  expect(exceptions()).toEqual([]);
  s.service.alipayNotification({ ...notice, status: 'TRADE_CLOSED', refundFen: 80000 });
  expect(exceptions()).toEqual([order.id]);
  expect(s.consoleService.overview(s.login.session).item.refundReview).toBe(1);
  const detail = s.consoleService.detail('orders', order.id, s.login.session);
  expect(detail.item).toMatchObject({ state: 'refunded', channelRefundFen: 80000, reviewedRefundFen: 0, refundedFen: 0 });
  expect(detail.related.map(row => row.revoked)).toEqual([false]);
  await s.execute({ action: 'refund', id: order.id, amountFen: 80000, reference: 'manual-refund-1', handledAt: new Date(s.now()).toISOString(), reason: '财务登记' });
  expect(exceptions()).toEqual([order.id]);
  // 渠道通知与人工登记的是同一笔，只扣一次；财务记录只剩登记行。
  expect(s.consoleService.overview(s.login.session).item).toMatchObject({ refundFen: 80000, netFen: 0 });
  expect(s.consoleService.list('finance', pageQuerySchema.parse({}), s.login.session).items.map(row => row.state)).toEqual(['人工登记退款']);
  await s.execute({ action: 'refund-review', id: order.id, decision: 'keep', reason: '客户申请退款，核对后保留授权至期满' });
  expect(exceptions()).toEqual([]);
  expect(s.consoleService.detail('orders', order.id, s.login.session).related.map(row => row.revoked)).toEqual([false]);
  expect(s.consoleService.overview(s.login.session).item.refundReview).toBe(0);
});
it('创建线下订单与确认线下收款不落在同一个非管理员角色', () => {
  for (const role of ['operations', 'finance', 'viewer'] as const) expect(permissions['create-order'].includes(role) && permissions.fulfill.includes(role)).toBe(false);
});
it('工作台金额与收款趋势只返回给管理员和财务', async () => {
  const s = await setup();
  for (const role of ['owner', 'finance'] as const) {
    const dashboard = s.consoleService.overview({ ...s.login.session, user: { ...s.login.session.user, role } });
    expect(dashboard.item).toMatchObject({ netFen: 0, onlineFen: 0, manualFen: 0, refundFen: 0 }); expect(dashboard.related.filter(row => row.category === 'cashflow')).toHaveLength(30);
  }
  for (const role of ['operations', 'viewer'] as const) {
    const dashboard = s.consoleService.overview({ ...s.login.session, user: { ...s.login.session.user, role } });
    for (const key of ['netFen', 'onlineFen', 'manualFen', 'refundFen']) expect(dashboard.item).not.toHaveProperty(key);
    expect(dashboard.related.some(row => row.category === 'cashflow')).toBe(false); expect(dashboard.item).toHaveProperty('pendingOrders');
  }
});
it('线下订单可生成支付宝付款链接或直接关闭；有链接后只能经渠道查单关闭', async () => {
  const s = await setup(); const order = { action: 'create-order' as const, customer: '客户', customerType: 'company' as const, quantity: 1, amountFen: 80000, useUntil: '2026-11-06T00:00:00Z', reason: '线下成交' };
  const linked = await s.execute({ ...order, reference: 'link-order' }); const unlinked = await s.execute({ ...order, reference: 'close-order' });
  const as = (role: 'finance' | 'viewer') => ({ ...s.login.session, user: { ...s.login.session.user, role } });
  for (const action of ['payment-link', 'close-order', 'reconcile'] as const) await expect(s.execute({ action, id: linked.id!, reason: '越权' }, as('viewer'))).rejects.toThrow('角色');
  // 财务可以生成付款链接、关闭未付订单和主动查单，但不能创建线下订单。
  await expect(s.execute({ ...order, reference: 'finance-order' }, as('finance'))).rejects.toThrow('角色');
  const link = await s.execute({ action: 'payment-link', id: linked.id!, reason: '客户要求扫码付款' }, as('finance'));
  expect(link).toMatchObject({ message: '付款链接已生成', paymentUrl: expect.stringContaining(linked.id!) as unknown, expiresAt: new Date(s.now() + 15 * 60000).toISOString() });
  expect(s.consoleService.detail('orders', linked.id!, s.login.session).item.channel).toBe('alipay');
  expect((await s.execute({ action: 'payment-link', id: linked.id!, reason: '重发同一链接' })).expiresAt).toBe(link.expiresAt);
  expect((await s.execute({ action: 'reconcile', id: linked.id!, reason: '财务查单' }, as('finance'))).message).toBe('查单完成');
  await expect(s.execute({ action: 'close-order', id: linked.id!, reason: '客户放弃' })).rejects.toThrow('未生成付款链接');
  expect((await s.execute({ action: 'close-order', id: unlinked.id!, reason: '客户放弃' }, as('finance'))).message).toBe('订单已关闭');
  expect(s.consoleService.detail('orders', unlinked.id!, s.login.session).item.state).toBe('closed');
  await expect(s.execute({ action: 'close-order', id: unlinked.id!, reason: '重复关闭' })).rejects.toThrow('未生成付款链接');
  await expect(s.execute({ action: 'payment-link', id: unlinked.id!, reason: '关闭后付款' })).rejects.toThrow('已关闭');
});
it('付款期限过去一分钟以上仍未付款的支付宝订单交给恢复任务查单；已收款、未过期和线下单不列入', async () => {
  const s = await setup(); const identity = { appId: '2026000000000001', sellerId: '2088000000000001' };
  const order = (reference: string) => s.service.createOrder({ reference, customer: '客户', customerType: 'company', quantity: 1, kind: 'subscription', amountFen: 80000, useUntil: '2026-11-06T00:00:00Z', updatesUntil: '2026-11-06T00:00:00Z' }).id;
  const lapsed = order('lapsed'); const paid = order('paid'); const fresh = order('fresh'); order('offline');
  s.service.prepareAlipayPayment(lapsed, identity.appId, identity.sellerId); s.service.prepareAlipayPayment(paid, identity.appId, identity.sellerId);
  s.advance(15 * 60000 + 59000); expect(s.service.lapsedPaymentLinks().items).toEqual([]);
  s.advance(1000); s.service.prepareAlipayPayment(fresh, identity.appId, identity.sellerId);
  s.service.fulfill(paid, { amountFen: 80000, paymentReference: 'alipay:2026100622001' }, 'alipay', identity);
  expect(s.service.lapsedPaymentLinks().items).toEqual([lapsed]);
});
it('待办筛选、操作日志对象名称与动作筛选、财务合计与导出', async () => {
  const s = await setup(); const granted = await s.execute(grant);
  const licenses = s.consoleService.detail('orders', granted.id!, s.login.session).related;
  await s.execute({ action: 'set-expiry', id: String(licenses[0]!.id), useUntil: '2026-10-08T00:00:00Z', reason: '即将到期' });
  const query = (value: Record<string, string>) => pageQuerySchema.parse(value);
  expect(s.consoleService.list('licenses', query({ state: 'expiring' }), s.login.session).items.map(row => row.id)).toEqual([licenses[0]!.id]);
  const ticket = await s.execute({ action: 'create-ticket', id: granted.id!, licenseId: null, category: 'other', note: '问题', reason: '记录' });
  const closed = await s.execute({ action: 'create-ticket', id: granted.id!, licenseId: null, category: 'other', note: '已处理', reason: '记录' });
  await s.execute({ action: 'update-ticket', id: closed.id!, state: 'closed', conclusion: '无需变更', reason: '完成' });
  expect(s.consoleService.list('tickets', query({ state: 'active' }), s.login.session).items.map(row => row.id)).toEqual([ticket.id]);
  const reference = String(s.consoleService.detail('orders', granted.id!, s.login.session).item.reference);
  expect(s.consoleService.list('audit', query({ state: 'grant' }), s.login.session).items).toMatchObject([{ action: 'grant', targetType: 'orders', targetLabel: reference }]);
  expect(s.consoleService.list('audit', query({ q: '即将到期' }), s.login.session).items.map(row => row.targetLabel)).toEqual(['内测客户 的授权', '内测客户 的授权']);
  const sale = await s.execute({ action: 'create-order', reference: 'finance-sale', customer: '客户', customerType: 'company', quantity: 1, amountFen: 80000, useUntil: '2026-11-06T00:00:00Z', reason: '成交' });
  await s.execute({ action: 'fulfill', id: sale.id!, amountFen: 80000, paymentReference: 'finance-bank', paymentMethod: '转账', reason: '到账' });
  await s.execute({ action: 'refund', id: sale.id!, amountFen: 30000, reference: 'refund-old', handledAt: '2026-10-01T02:00:00Z', reason: '早先退款' });
  await s.execute({ action: 'refund', id: sale.id!, amountFen: 20000, reference: 'refund-new', handledAt: '2026-10-05T02:00:00Z', reason: '近期退款' });
  await s.execute({ action: 'invoice', id: sale.id!, state: 'requested', buyer: '抬头', taxId: '', reference: '', reason: '申请' });
  expect(s.consoleService.list('finance', query({}), s.login.session).summary).toEqual({ refundFen: 50000, refundCount: 2, invoiceCount: 1 });
  const recent = s.consoleService.list('finance', query({ state: 'refund', from: '2026-10-03' }), s.login.session);
  expect(recent.items.map(row => row.reference)).toEqual(['refund-new']); expect(recent.summary).toEqual({ refundFen: 20000, refundCount: 1, invoiceCount: 0 });
  const csv = s.consoleService.exportCsv('finance', query({ state: 'refund' }), s.login.session, 'export');
  expect(csv.split('\r\n')).toHaveLength(3); expect(csv).toContain('"refund-old"');
  await expect(Promise.resolve().then(() => s.consoleService.exportCsv('finance', query({}), { ...s.login.session, user: { ...s.login.session.user, role: 'operations' } }, 'export'))).rejects.toThrow('财务');
});
