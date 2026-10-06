import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { LicensingService } from './service';
import { totpCode, type ConsoleSession } from './console-auth';
import { pageQuerySchema, type ConsoleAction } from './console-contract';
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
  const execute = (input: ConsoleAction, session = login.session, operationId = randomUUID()) => consoleService.execute({ operationId, input }, session, randomUUID(), () => Promise.resolve({}));
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
it('服务端角色、近期验证与最后负责人保护', async () => {
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
  const csv = s.consoleService.exportOrders(pageQuerySchema.parse({}), s.login.session, 'export');
  expect(csv).toContain("'=1+1"); expect(csv).not.toContain('TBA-'); expect(csv).not.toContain('客户');
  expect(s.consoleService.overview().item.manualFen).toBe(80000);
  expect(s.consoleService.overview().item.refundFen).toBe(70000);
});
it('换机沿用旧租约等待并吊销旧码', async () => {
  const s = await setup(); const result = await s.execute(grant);
  const license = s.consoleService.detail('orders', result.id!, s.login.session).related[0]!;
  const id = String(license.id); const code = s.service.consoleReveal(id);
  s.service.activate({ product: 'tuanbo-link-console', code, machineCode: `TB1-${'A'.repeat(64)}` });
  await s.execute({ action: 'revoke', id, reason: '换机' });
  await expect(s.execute({ action: 'migrate', id, reason: '提前换机' })).rejects.toThrow('等待');
  s.advance(7 * 86400000 + 300001);
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
