import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { internalDistribution, internalDistributionStatus } from './internal-distribution';
import { LicenseAccess } from './license-access';

it('构建期免激活测试渠道允许不同主机进入和输出，不受正式授权文件影响', async () => {
  const input = { channel: 'portable-test', version: 1 };
  for (const digit of ['A', 'B']) {
    const machineCode = `TB1-${digit.repeat(64)}`;
    const status = internalDistributionStatus(input, machineCode);
    expect(status.state).toBe('active');
    expect(status.claims?.machineCode).toBe(machineCode);
    expect(status.claims?.useUntil).toBeNull();
    await expect(new LicenseAccess(() => Promise.resolve(status)).requireOutput()).resolves.toBeUndefined();
  }
  expect(internalDistributionStatus({ ...input, version: 2 }, `TB1-${'A'.repeat(64)}`).state).toBe('invalid');
  expect(internalDistribution).toBeNull();
});

it('正式构建默认无内测通道；内测许可拒绝换机、到期与篡改', () => {
  expect(internalDistribution).toBeNull();
  const keys = generateKeyPairSync('ed25519');
  const machineCode = `TB1-${'A'.repeat(64)}`;
  const now = Date.now();
  const claims = { version: 1, product: 'tuanbo-link-console', licenseId: randomUUID(), customer: '本机内测', machineCode, kind: 'subscription', issuedAt: new Date(now).toISOString(), useUntil: new Date(now + 86400000).toISOString(), updatesUntil: new Date(now + 86400000).toISOString() };
  const body = `${Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: 'internal' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
  const input = { channel: 'internal', publicKeys: { internal: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }, token: `${body}.${sign(null, Buffer.from(body), keys.privateKey).toString('base64url')}` };
  expect(internalDistributionStatus(input, machineCode, now).state).toBe('active');
  expect(internalDistributionStatus(input, `TB1-${'B'.repeat(64)}`, now).state).toBe('invalid');
  expect(internalDistributionStatus(input, machineCode, now + 86400001).state).toBe('expired');
  expect(internalDistributionStatus({ ...input, token: `${input.token.slice(0, -10)}AAAAAAAAAA` }, machineCode, now).state).toBe('invalid');
});
