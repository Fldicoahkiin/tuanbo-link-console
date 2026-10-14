import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { acceptByReleasedClient, releasedClientStatuses } from './client-0429-contract';
import { createLicensingServer } from './http';
import { listenHttpTestServer } from './http-test-server';
import { LicensingService } from './service';

const keys = generateKeyPairSync('ed25519');
const publicKeys = { test: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
const machine = `TB1-${'A'.repeat(64)}`;
const services: LicensingService[] = [];
afterEach(() => { for (const service of services.splice(0)) service.close(); });

it('激活接口的返回和错误状态仍被已发布的 0.4.29 客户端接受', async () => {
  const now = Date.parse('2026-10-14T00:00:00Z');
  const service = new LicensingService(':memory:', keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'test', randomBytes(32), () => now);
  services.push(service);
  const issue = (reference: string, kind: 'perpetual' | 'subscription', useUntil: string | null) => {
    const order = { reference, customer: '兼容验收', customerType: 'company', quantity: 1, kind, amountFen: 80000, useUntil, updatesUntil: '2026-11-13T00:00:00Z' };
    return service.fulfill(service.createOrder(order).id, { paymentReference: reference, amountFen: order.amountFen }).licenses[0]!;
  };
  const monthly = issue('compat-monthly', 'subscription', '2026-11-13T00:00:00Z');
  const perpetual = issue('compat-perpetual', 'perpetual', null);
  const revoked = issue('compat-revoked', 'subscription', '2026-11-13T00:00:00Z');
  service.revoke(revoked.id, { reason: '兼容验收撤销' });
  const server = createLicensingServer(service, 'a'.repeat(48));
  await listenHttpTestServer(server);
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('无测试监听地址');
    const activate = (code: string, machineCode = machine) => fetch(`http://127.0.0.1:${address.port}/v1/activate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
      body: JSON.stringify({ product: 'tuanbo-link-console', code, machineCode }), signal: AbortSignal.timeout(5000)
    });
    for (const license of [monthly, perpetual]) {
      const response = await activate(license.code);
      expect(response.status).toBe(200);
      expect(acceptByReleasedClient(await response.text(), machine, publicKeys, now).licenseId).toBe(license.id);
    }
    expect((await activate(monthly.code, `TB1-${'B'.repeat(64)}`)).status).toBe(releasedClientStatuses.boundElsewhere);
    expect((await activate(revoked.code)).status).toBe(releasedClientStatuses.rejected);
    expect((await activate(`TBA-${'0'.repeat(32)}`)).status).toBe(releasedClientStatuses.rejected);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
