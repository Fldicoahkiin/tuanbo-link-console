import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { LicensingService } from './service';
import { createLicensingServer } from './http';
import { verifyLicense } from '../../desktop/src/main/link/license-service';

const keys = generateKeyPairSync('ed25519');
const publicKeys = { test: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
const machine = `TB1-${'A'.repeat(64)}`;
const order = { reference: 'invoice-1', customer: '测试企业', customerType: 'company', quantity: 3, kind: 'perpetual', amountFen: 10000, useUntil: null, updatesUntil: '2027-09-27T00:00:00Z' };
const services: LicensingService[] = [];
afterEach(() => { for (const service of services.splice(0)) service.close(); });
function setup(database = ':memory:') {
  let time = Date.parse('2026-09-27T00:00:00Z');
  const service = new LicensingService(database, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'test', randomBytes(32), () => time);
  services.push(service);
  return { service, now: () => time, advance: (ms: number) => { time += ms; } };
}
function purchase(service: LicensingService, details: Omit<typeof order, 'useUntil'> & { useUntil: string | null } = order) {
  const created = service.createOrder(details);
  return service.fulfill(created.id, { paymentReference: details.reference, amountFen: details.amountFen });
}
it('企业核款批量发码可幂等恢复，金额不匹配和重复流水不能发货', () => {
  const { service } = setup(); const created = service.createOrder(order);
  expect(service.describeOrder(created.id).licenses).toHaveLength(0);
  expect(() => service.fulfill(created.id, { paymentReference: 'bank-1', amountFen: 1 })).toThrow('金额');
  const paid = service.fulfill(created.id, { paymentReference: 'bank-1', amountFen: order.amountFen });
  expect(paid.licenses).toHaveLength(3);
  expect(new Set(paid.licenses.map(value => value.code)).size).toBe(3);
  expect(service.fulfill(created.id, { paymentReference: 'bank-1', amountFen: order.amountFen })).toEqual(paid);
  expect(service.createOrder(order)).toEqual({ id: created.id, state: 'fulfilled' });
  expect(() => service.createOrder({ ...order, amountFen: 2 })).toThrow('内容不同');
  const second = service.createOrder({ ...order, reference: 'invoice-2' });
  expect(() => service.fulfill(second.id, { paymentReference: 'bank-1', amountFen: order.amountFen })).toThrow('另一订单');
  expect(service.describeOrder(second.id).licenses).toHaveLength(0);
});
it('首次激活绑定单机，同机重试不新增席位，其他机器被拒绝，签名兼容桌面', () => {
  const { service, now } = setup(); const paid = purchase(service); const code = paid.licenses[0]!.code;
  const request = { product: 'tuanbo-link-console', code, machineCode: machine };
  const token = service.activate(request).license;
  const claims = verifyLicense(token, machine, publicKeys, now());
  expect(claims.online).toEqual({ customerType: 'company', leaseUntil: '2026-10-04T00:00:00.000Z' });
  expect(service.activate(request).license).toBe(token);
  expect(service.describeOrder(paid.id).licenses.filter(value => value.machineCode)).toHaveLength(1);
  expect(() => service.activate({ ...request, machineCode: `TB1-${'B'.repeat(64)}` })).toThrow('另一台');
});
it('个人订阅的离线期限不超出付费期限，买断刷新不延长升级资格', () => {
  const { service, now, advance } = setup();
  const paid = purchase(service, { ...order, kind: 'subscription', customerType: 'personal', quantity: 1, useUntil: '2026-09-28T00:00:00Z' });
  const request = { product: 'tuanbo-link-console', code: paid.licenses[0]!.code, machineCode: machine };
  expect(verifyLicense(service.activate(request).license, machine, publicKeys, now()).online?.leaseUntil).toBe('2026-09-28T00:00:00.000Z');
  advance(86400000);
  expect(() => service.activate(request)).toThrow('使用期限');
  const perpetual = purchase(service, { ...order, reference: 'permanent' });
  advance(400 * 86400000);
  const claims = verifyLicense(service.activate({ ...request, code: perpetual.licenses[0]!.code }).license, machine, publicKeys, now());
  expect(claims.updatesUntil).toBe(order.updatesUntil);
  expect(claims.useUntil).toBeNull();
});
it('吊销拒绝刷新；等待旧离线凭证到期后换机，旧码永久失效', () => {
  const { service, advance } = setup(); const paid = purchase(service); const license = paid.licenses[0]!;
  const request = { product: 'tuanbo-link-console', code: license.code, machineCode: machine };
  service.activate(request);
  expect(() => service.migrate(license.id, { reason: '更换电脑' })).toThrow('先撤销');
  service.revoke(license.id, { reason: '换机申请' });
  expect(() => service.activate(request)).toThrow('撤销');
  expect(() => service.migrate(license.id, { reason: '更换电脑' })).toThrow('先撤销');
  advance(7 * 86400000 + 300000);
  const replacement = service.migrate(license.id, { reason: '更换电脑' });
  expect(replacement.code).not.toBe(license.code);
  expect(() => service.activate(request)).toThrow('无效');
  expect(service.activate({ ...request, code: replacement.code, machineCode: `TB1-${'B'.repeat(64)}` }).license).toBeTruthy();
});
it('数据库文件不包含明文激活码', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'tblink-server-')), 'license.db');
  const { service } = setup(path); const paid = purchase(service);
  const bytes = Buffer.concat([await readFile(path), await readFile(`${path}-wal`)]);
  for (const license of paid.licenses) expect(bytes.includes(Buffer.from(license.code))).toBe(false);
});
it('服务端时间回退后的刷新不能缩短换机等待期', () => {
  const { service, advance } = setup(); const paid = purchase(service); const license = paid.licenses[0]!;
  const request = { product: 'tuanbo-link-console', code: license.code, machineCode: machine };
  service.activate(request);
  const firstLease = service.describeOrder(paid.id).licenses[0]!.leaseUntil;
  advance(-86400000);
  service.activate(request);
  expect(service.describeOrder(paid.id).licenses[0]!.leaseUntil).toBe(firstLease);
});
it('HTTP 后台拒绝匿名访问，公开接口不接受后台订单和伪造支付', async () => {
  const { service } = setup(); const token = 'a'.repeat(48); const server = createLicensingServer(service, token);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('无测试监听地址');
    const base = `http://127.0.0.1:${address.port}`;
    const post = (path: string, body: unknown, auth = '') => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    expect((await post('/admin/orders', order)).status).toBe(401);
    expect((await post('/admin/orders', order, `Bearer ${token}`)).status).toBe(200);
    expect((await post('/v1/activate', { ...order, paid: true })).status).toBe(400);
    expect((await post('/v1/payments/callback', { paid: true })).status).toBe(404);
    expect((await post('/admin/orders', 'x'.repeat(17000), `Bearer ${token}`)).status).toBe(413);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
