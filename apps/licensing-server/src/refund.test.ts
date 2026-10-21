import { generateKeyPairSync, randomBytes, randomUUID, sign, verify } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { purchaseCatalogSchema } from '../../../packages/schema/src/purchase';
import { AlipayCheckout, AlipayNotifications } from './alipay';
import { totpCode } from './console-auth';
import { pageQuerySchema, type ConsoleAction } from './console-contract';
import { LicensingService } from './service';

const issuer = generateKeyPairSync('ed25519'); const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 }); const provider = generateKeyPairSync('rsa', { modulusLength: 2048 });
const identity = { appId: '2026000000000001', sellerId: '2088000000000001' };
const notifications = new AlipayNotifications(identity.appId, identity.sellerId, provider.publicKey.export({ type: 'spki', format: 'pem' }).toString());
const catalog = purchaseCatalogSchema.parse({ version: 1, maxOrderAmountFen: 1_000_000, offers: [{ id: 'month', revision: 'r1', name: '月付', unitAmountFen: 80000,
  kind: 'subscription', useDays: 30, updatesDays: 30, maxQuantity: 2, saleUntil: '2027-01-01T00:00:00Z' }] });
const closing: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); closing.splice(0).reverse().forEach(close => close()); });
const reply = (method: string, value: unknown) => { const text = JSON.stringify(value); return `{"${method.replaceAll('.', '_')}_response":${text},"sign":"${sign('RSA-SHA256', Buffer.from(text), provider.privateKey).toString('base64')}"}`; };

async function setup() {
  const time = Date.parse('2026-10-06T00:00:00Z');
  const path = join(mkdtempSync(join(tmpdir(), 'tblink-refund-')), 'test.db');
  const service = new LicensingService(path, issuer.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'test', randomBytes(32), () => time);
  closing.push(() => service.close());
  const consoleService = service.console(randomBytes(32));
  const db = new DatabaseSync(path); closing.push(() => db.close());
  const first = consoleService.auth.bootstrap('owner');
  const code = (step: number) => totpCode(consoleService.auth.open(String(db.prepare('SELECT totp FROM console_users WHERE id=?').get(first.id)?.totp)), Math.floor(time / 30000) + step);
  await consoleService.auth.enroll(first.token, 'a-secure-test-password', code(0), 'enroll');
  const { session } = await consoleService.auth.login('owner', 'a-secure-test-password', code(1), 'login');
  // 支付宝侧按方法返回脚本化的已签名响应，记录每次退款请求的业务参数。
  const calls: { method: string; business: Record<string, string> }[] = [];
  const answers: Record<string, (business: Record<string, string>) => string | Error> = {};
  const checkout = new AlipayCheckout(identity.appId, identity.sellerId, merchant.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'production', 'https://api.tuanbo-link.jinhefilm.com', () => time);
  const channelRequest: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input)); const method = url.searchParams.get('method')!;
    if (!(init?.body instanceof URLSearchParams)) throw new Error('应发送表单正文');
    const business = z.record(z.string(), z.string()).parse(JSON.parse(init.body.get('biz_content')!));
    const params = Object.fromEntries(url.searchParams); const signature = params.sign!; delete params.sign; params.biz_content = init.body.get('biz_content')!;
    expect(verify('RSA-SHA256', Buffer.from(Object.keys(params).sort().map(key => `${key}=${params[key]}`).join('&')), merchant.publicKey, Buffer.from(signature, 'base64'))).toBe(true);
    calls.push({ method, business });
    const answer = answers[method]!(business);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(new Response(answer));
  };
  const channels = { reconcile: () => Promise.resolve({}), refund: (request: { orderId: string; refundId: string; amountFen: number; reason: string }) => checkout.refund(request.orderId, request, notifications, channelRequest),
    paymentLink: () => { throw new Error('退款测试不生成付款链接'); } };
  const execute = (input: ConsoleAction, actor = session) => consoleService.execute({ operationId: randomUUID(), input }, actor, randomUUID(), channels);
  const token = () => `TBD-${randomBytes(32).toString('hex').toUpperCase()}`;
  let trades = 0;
  const buy = (quantity: number, renewal?: { licenseId: string; authorization: unknown }) => {
    const order = service.createPurchase({ offerId: 'month', revision: 'r1', quotedUnitAmountFen: 80000, quantity, customer: '退款客户', customerType: 'company',
      ...(renewal ? { renewalLicenseId: renewal.licenseId } : {}) }, token(), catalog, identity, renewal?.authorization);
    service.alipayNotification({ orderId: order.id, ...identity, status: 'TRADE_SUCCESS', amountFen: order.amountFen, refundFen: 0, paymentReference: `alipay:202610062200000000000${++trades}` });
    return { id: order.id, amountFen: order.amountFen, licenses: () => service.describeOrder(order.id).licenses };
  };
  const exceptions = () => consoleService.list('exceptions', pageQuerySchema.parse({}), session).items.map(row => row.id);
  const ledger = (id: string) => db.prepare('SELECT amount_fen, reference FROM console_refunds WHERE order_id=?').all(id);
  return { service, consoleService, session, calls, answers, execute, buy, exceptions, ledger, db };
}

it('全额原路退款：未确认时订单与授权不变；换新操作编号按原金额重提复用同一 out_request_no，经退款查询确认后同一事务标记退款并撤销全部授权', async () => {
  const s = await setup(); const order = s.buy(2);
  s.answers['alipay.trade.refund'] = () => new Error('网络中断');
  await expect(s.execute({ action: 'alipay-refund', id: order.id, amountFen: 160000, reason: '客户申请全额退款' })).rejects.toThrow('网络异常');
  expect(s.service.describeOrder(order.id).state).toBe('fulfilled'); expect(order.licenses().every(license => !license.revoked)).toBe(true);
  await expect(s.execute({ action: 'alipay-refund', id: order.id, amountFen: 100, reason: '金额不同' })).rejects.toThrow('原金额');
  s.answers['alipay.trade.refund'] = business => reply('alipay.trade.refund', { code: '10000', msg: 'Success', out_trade_no: business.out_trade_no, trade_no: '2026100622001', fund_change: 'N', refund_fee: '1600.00' });
  s.answers['alipay.trade.fastpay.refund.query'] = business => reply('alipay.trade.fastpay.refund.query', { code: '10000', msg: 'Success', out_trade_no: business.out_trade_no, out_request_no: business.out_request_no, refund_amount: '1600.00', refund_status: 'REFUND_SUCCESS' });
  const result = await s.execute({ action: 'alipay-refund', id: order.id, amountFen: 160000, reason: '客户申请全额退款' });
  expect(result.message).toContain('撤销 2 份授权');
  const refunds = s.calls.filter(call => call.method === 'alipay.trade.refund');
  expect(refunds).toHaveLength(2); expect(refunds[0]!.business.out_request_no).toBe(refunds[1]!.business.out_request_no);
  expect(refunds[1]!.business).toEqual({ out_trade_no: `TB_${order.id.replaceAll('-', '')}`, out_request_no: refunds[0]!.business.out_request_no, refund_amount: '1600.00', refund_reason: '客户申请全额退款' });
  expect(s.calls.filter(call => call.method === 'alipay.trade.fastpay.refund.query')).toHaveLength(1);
  expect(s.service.describeOrder(order.id).state).toBe('refunded'); expect(order.licenses().every(license => license.revoked)).toBe(true);
  expect(s.ledger(order.id)).toEqual([{ amount_fen: 160000, reference: `alipay-refund:${refunds[0]!.business.out_request_no}` }]);
  expect(s.exceptions()).toEqual([]);
  // 工作台净收款扣除原路退款；趋势同日记一笔收款、一笔退款。
  const dashboard = s.consoleService.overview(s.session);
  expect(dashboard.item).toMatchObject({ onlineFen: 160000, refundFen: 160000, netFen: 0 });
  expect(dashboard.related.find(row => row.category === 'cashflow' && row.day === '2026-10-06')).toMatchObject({ incomeFen: 160000, refundFen: 160000 });
  await expect(s.execute({ action: 'alipay-refund', id: order.id, amountFen: 1, reason: '再次退款' })).rejects.toThrow('已全额退款');
  expect(s.db.prepare("SELECT detail FROM audit WHERE target=? AND action='order.state-changed'").all(order.id).map(row => row.detail)).toContain('fulfilled->refunded:alipay:console-refund');
});

it('部分退款与查询未成功：只记录并进入异常队列，运营保留或撤销授权后出列；新的退款重新入列；超额拒绝', async () => {
  const s = await setup(); const order = s.buy(2);
  s.answers['alipay.trade.refund'] = business => reply('alipay.trade.refund', { code: '10000', out_trade_no: business.out_trade_no, fund_change: 'N', refund_fee: '0.00' });
  s.answers['alipay.trade.fastpay.refund.query'] = business => reply('alipay.trade.fastpay.refund.query', { code: '10000', out_trade_no: business.out_trade_no, out_request_no: business.out_request_no });
  await expect(s.execute({ action: 'alipay-refund', id: order.id, amountFen: 30000, reason: '部分退款' })).rejects.toThrow('尚未确认');
  expect(s.exceptions()).toEqual([]); expect(s.ledger(order.id)).toEqual([]);
  s.answers['alipay.trade.refund'] = business => reply('alipay.trade.refund', { code: '10000', out_trade_no: business.out_trade_no, fund_change: 'Y', refund_fee: '300.00' });
  expect((await s.execute({ action: 'alipay-refund', id: order.id, amountFen: 30000, reason: '部分退款' })).message).toContain('部分退款');
  expect(s.service.describeOrder(order.id).state).toBe('fulfilled'); expect(order.licenses().every(license => !license.revoked)).toBe(true);
  expect(s.exceptions()).toEqual([order.id]);
  await s.execute({ action: 'refund-review', id: order.id, decision: 'keep', reason: '协商保留授权' });
  expect(s.exceptions()).toEqual([]);
  await expect(s.execute({ action: 'refund-review', id: order.id, decision: 'keep', reason: '重复处理' })).rejects.toThrow('没有待处理');
  await expect(s.execute({ action: 'alipay-refund', id: order.id, amountFen: 130001, reason: '超额' })).rejects.toThrow('超过订单金额');
  s.answers['alipay.trade.refund'] = business => reply('alipay.trade.refund', { code: '10000', out_trade_no: business.out_trade_no, fund_change: 'Y', refund_fee: '500.00' });
  await s.execute({ action: 'alipay-refund', id: order.id, amountFen: 20000, reason: '再退一部分' });
  expect(s.exceptions()).toEqual([order.id]);
  expect((await s.execute({ action: 'refund-review', id: order.id, decision: 'revoke', reason: '停用授权' })).message).toContain('2 份授权');
  expect(order.licenses().every(license => license.revoked)).toBe(true); expect(s.exceptions()).toEqual([]);
});

it('支付宝后台直接退款只经验签通知记录并标记，不自动撤销；运营一键撤销；续费单不能撤销原授权；权限与二次验证', async () => {
  const s = await setup(); const order = s.buy(1);
  const receipt = z.object({ payment_reference: z.string() }).parse(s.db.prepare('SELECT payment_reference FROM payment_receipts WHERE order_id=?').get(order.id));
  s.service.alipayNotification({ orderId: order.id, ...identity, status: 'TRADE_CLOSED', amountFen: 80000, refundFen: 80000, paymentReference: receipt.payment_reference });
  expect(s.service.describeOrder(order.id).state).toBe('refunded'); expect(order.licenses()[0]!.revoked).toBe(false);
  // 只有渠道通知、未登记的退款同样从净收款扣除，并在财务记录和趋势中出现。
  const dashboard = s.consoleService.overview(s.session);
  expect(dashboard.item).toMatchObject({ onlineFen: 80000, refundFen: 80000, netFen: 0 });
  expect(dashboard.related.filter(row => row.category === 'cashflow').reduce((sum, row) => sum + Number(row.refundFen), 0)).toBe(80000);
  expect(s.consoleService.list('finance', pageQuerySchema.parse({}), s.session).items).toMatchObject([{ orderId: order.id, amountFen: 80000, state: '支付宝渠道退款（未登记）' }]);
  expect(s.exceptions()).toEqual([order.id]);
  for (const role of ['finance', 'viewer'] as const) await expect(s.execute({ action: 'refund-review', id: order.id, decision: 'revoke', reason: '越权' }, { ...s.session, user: { ...s.session.user, role } })).rejects.toThrow('角色');
  await expect(s.execute({ action: 'alipay-refund', id: order.id, amountFen: 1, reason: '越权' }, { ...s.session, user: { ...s.session.user, role: 'operations' } })).rejects.toThrow('角色');
  await expect(s.execute({ action: 'refund-review', id: order.id, decision: 'revoke', reason: '未验证' }, { ...s.session, verifiedAt: 0 })).rejects.toThrow('二次验证');
  await s.execute({ action: 'refund-review', id: order.id, decision: 'revoke', reason: '后台退款已核实' });
  expect(order.licenses()[0]!.revoked).toBe(true); expect(s.exceptions()).toEqual([]);

  const original = s.buy(1); const license = original.licenses()[0]!;
  const authorization = { product: 'tuanbo-link-console' as const, code: license.code, machineCode: `TB1-${'A'.repeat(64)}` };
  s.service.activate(authorization);
  const renewal = s.buy(1, { licenseId: license.id, authorization });
  s.answers['alipay.trade.refund'] = business => reply('alipay.trade.refund', { code: '10000', out_trade_no: business.out_trade_no, fund_change: 'Y', refund_fee: '800.00' });
  expect((await s.execute({ action: 'alipay-refund', id: renewal.id, amountFen: 80000, reason: '续费退款' })).message).toContain('续费订单不自动撤销');
  expect(s.service.describeOrder(renewal.id).state).toBe('refunded'); expect(original.licenses()[0]!.revoked).toBe(false);
  expect(s.exceptions()).toEqual([renewal.id]);
  await expect(s.execute({ action: 'refund-review', id: renewal.id, decision: 'revoke', reason: '误操作' })).rejects.toThrow('调整到期时间');
  await s.execute({ action: 'refund-review', id: renewal.id, decision: 'keep', reason: '已回退续期' });
  expect(s.exceptions()).toEqual([]); expect(original.licenses()[0]!.revoked).toBe(false);
});

it('退款响应必须验签、属于本订单；查询金额不符时报错并保持待确认', async () => {
  const s = await setup(); const order = s.buy(1);
  s.answers['alipay.trade.refund'] = () => `{"alipay_trade_refund_response":{"code":"10000","fund_change":"Y","refund_fee":"800.00","out_trade_no":"x"},"sign":"${'A'.repeat(344)}"}`;
  await expect(s.execute({ action: 'alipay-refund', id: order.id, amountFen: 80000, reason: '验签' })).rejects.toThrow('验签失败');
  s.answers['alipay.trade.refund'] = () => reply('alipay.trade.refund', { code: '10000', out_trade_no: 'TB_00000000000000000000000000000000', fund_change: 'Y', refund_fee: '800.00' });
  await expect(s.execute({ action: 'alipay-refund', id: order.id, amountFen: 80000, reason: '错单' })).rejects.toThrow('其他订单');
  s.answers['alipay.trade.refund'] = business => reply('alipay.trade.refund', { code: '10000', out_trade_no: business.out_trade_no, fund_change: 'N', refund_fee: '800.00' });
  s.answers['alipay.trade.fastpay.refund.query'] = business => reply('alipay.trade.fastpay.refund.query', { code: '10000', out_trade_no: business.out_trade_no, out_request_no: business.out_request_no, refund_amount: '1.00', refund_status: 'REFUND_SUCCESS' });
  await expect(s.execute({ action: 'alipay-refund', id: order.id, amountFen: 80000, reason: '金额' })).rejects.toThrow('金额与请求不一致');
  expect(s.service.describeOrder(order.id).state).toBe('fulfilled'); expect(s.ledger(order.id)).toEqual([]);
  expect(new Set(s.calls.filter(call => call.method === 'alipay.trade.refund').map(call => call.business.out_request_no)).size).toBe(1);
  await expect(s.execute({ action: 'alipay-refund', id: order.id, amountFen: 80000, reason: 'x'.repeat(257) })).rejects.toThrow();
});
