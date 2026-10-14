import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { purchaseCatalogSchema, purchaseDeliverySchema } from '../../../packages/schema/src/purchase';
import { licenseClaimsSchema } from '../../../packages/schema/src/license';
import { LicensingService } from './service';

const issuer = generateKeyPairSync('ed25519');
const start = Date.parse('2026-09-28T00:00:00Z');
const day = 86400000;
const identity = { appId: '2026000000000001', sellerId: '2088000000000001' };
const machineCode = `TB1-${'A'.repeat(64)}`;
const catalog = purchaseCatalogSchema.parse({ version: 1, maxOrderAmountFen: 50000, offers: [{
  id: 'test-month', revision: 'test-1', name: '测试订阅', unitAmountFen: 100,
  kind: 'subscription', useDays: 30, updatesDays: 30, maxQuantity: 10, saleUntil: '2027-12-31T00:00:00Z'
}] });
const input = { offerId: 'test-month', revision: 'test-1', quotedUnitAmountFen: 100, quantity: 1, customer: '测试企业', customerType: 'company' };
const token = () => `TBD-${randomBytes(32).toString('hex').toUpperCase()}`;
const services: LicensingService[] = [];
afterEach(() => { for (const service of services.splice(0)) service.close(); });
function setup() {
  let now = start;
  const service = new LicensingService(':memory:', issuer.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'test', randomBytes(32), () => now);
  services.push(service);
  const first = service.createPurchase(input, token(), catalog, identity);
  const paid = service.fulfill(first.id, { amountFen: 100, paymentReference: 'alipay:first' }, 'alipay', identity);
  const license = paid.licenses[0]!;
  service.activate({ product: 'tuanbo-link-console', code: license.code, machineCode });
  return { service, first, license, request: { ...input, renewalLicenseId: license.id },
    authorization: { product: 'tuanbo-link-console', code: license.code, machineCode }, setNow: (value: number) => { now = value; } };
}

it('付款后延长原订阅，保留原订单快照、激活码和机器绑定；同回调只延长一次', () => {
  const { service, first, license, request, authorization, setNow } = setup();
  setNow(start + 10 * day);
  const credential = token();
  const renewal = service.createPurchase(request, credential, catalog, identity, authorization);
  expect(service.describeOrder(first.id).useUntil).toBe(new Date(start + 30 * day).toISOString());
  const payment = { amountFen: 100, paymentReference: 'alipay:renewal' };
  const paid = service.fulfill(renewal.id, payment, 'alipay', identity);
  expect(paid.useUntil).toBe(new Date(start + 60 * day).toISOString());
  expect(paid.licenses[0]).toMatchObject({ id: license.id, code: license.code, machineCode });
  expect(service.fulfill(renewal.id, payment, 'alipay', identity)).toEqual(paid);
  expect(service.describeOrder(first.id).useUntil).toBe(new Date(start + 30 * day).toISOString());
  const delivery = purchaseDeliverySchema.parse(service.readDelivery(renewal.id, credential));
  expect(delivery.renewalLicenseId).toBe(license.id);
  expect(delivery.licenses).toEqual([{ id: license.id, code: null, revoked: false }]);
  const claims = licenseClaimsSchema.parse(JSON.parse(Buffer.from(service.activate(authorization).license.split('.')[1]!, 'base64url').toString()));
  expect(claims.useUntil).toBe(paid.useUntil);
  expect(claims.updatesUntil).toBe(paid.updatesUntil);
});

it('已过期订阅从核款时开始续期；先建单不恢复产品使用', () => {
  const { service, request, authorization, setNow } = setup();
  setNow(start + 40 * day);
  const renewal = service.createPurchase(request, token(), catalog, identity, authorization);
  expect(() => service.activate(authorization)).toThrow('使用期限已结束');
  setNow(start + 41 * day);
  const paid = service.fulfill(renewal.id, { amountFen: 100, paymentReference: 'alipay:late' }, 'alipay', identity);
  expect(paid.useUntil).toBe(new Date(start + 71 * day).toISOString());
  expect(service.activate(authorization).license).toBeTruthy();
});

it('续费拒绝伪造授权、其他机器、其他客户、批量数量和永久商品', () => {
  const { service, request, authorization } = setup();
  for (const auth of [undefined, { ...authorization, code: `TBA-${'B'.repeat(32)}` }, { ...authorization, machineCode: `TB1-${'C'.repeat(64)}` }]) {
    expect(() => service.createPurchase(request, token(), catalog, identity, auth)).toThrow('续费授权');
  }
  for (const change of [{ customer: '其他客户' }, { customerType: 'personal' }, { quantity: 2 }]) {
    expect(() => service.createPurchase({ ...request, ...change }, token(), catalog, identity, authorization)).toThrow();
  }
  const perpetual = purchaseCatalogSchema.parse({ ...catalog, offers: [{ ...catalog.offers[0], kind: 'perpetual', useDays: null }] });
  expect(() => service.createPurchase(request, token(), perpetual, identity, authorization)).toThrow('订阅');
});

it('续费金额错误或已撤销时不能交付，也不能把同笔流水用于另一续费', () => {
  const { service, request, license, authorization } = setup();
  const renewal = service.createPurchase(request, token(), catalog, identity, authorization);
  expect(() => service.fulfill(renewal.id, { amountFen: 1, paymentReference: 'alipay:wrong' }, 'alipay', identity)).toThrow('金额');
  const paid = service.fulfill(renewal.id, { amountFen: 100, paymentReference: 'alipay:once' }, 'alipay', identity);
  const second = service.createPurchase(request, token(), catalog, identity, authorization);
  expect(() => service.fulfill(second.id, { amountFen: 100, paymentReference: 'alipay:once' }, 'alipay', identity)).toThrow('流水');
  service.revoke(license.id, { reason: '测试撤销' });
  expect(() => service.fulfill(second.id, { amountFen: 100, paymentReference: 'alipay:after-revoke' }, 'alipay', identity)).toThrow('已撤销');
  // 收款事实已记录，交付被拒：订单停在 paid，等待运营核对。
  expect(service.describeOrder(second.id).state).toBe('paid');
  expect(paid.useUntil).toBe(new Date(start + 60 * day).toISOString());
});

it('响应丢失后仅凭原购买凭据恢复；改价不换单，迁移后续费领取不泄漏新激活码', () => {
  const { service, request, license, authorization, setNow } = setup();
  const credential = token();
  const renewal = service.createPurchase(request, credential, catalog, identity, authorization);
  expect(service.createPurchase(request, credential, undefined)).toMatchObject({ id: renewal.id, payable: false, renewalLicenseId: license.id });
  expect(() => service.createPurchase({ ...request, renewalLicenseId: undefined }, credential, catalog, identity)).toThrow('其他商品');
  setNow(start + 8 * day);
  service.revoke(license.id, { reason: '测试迁移前撤销' });
  service.migrate(license.id, { reason: '测试迁移' });
  service.fulfill(renewal.id, { amountFen: 100, paymentReference: 'alipay:migration' }, 'alipay', identity);
  const access = service.issueDeliveryAccess(renewal.id, { reason: '测试恢复领取' });
  expect(service.readDelivery(renewal.id, access.token).licenses[0]?.code).toBeNull();
});
