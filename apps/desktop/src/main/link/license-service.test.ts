import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { type LicenseClaims } from '@tb/schema';
import { LicenseService, verifyLicense } from './license-service';

const keys = generateKeyPairSync('ed25519');
const publicKeys = { test: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
const machine = `TB1-${'A'.repeat(64)}`;
const now = Date.parse('2026-09-21T00:00:00Z');
it('发行方工具签发的授权能被客户端验证，拒绝覆盖已有文件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-issuer-'));
  const privateFile = join(directory, 'private.pem');
  const publicFile = join(directory, 'public.json');
  const request = join(directory, 'request.json');
  const output = join(directory, 'license.tbllicense');
  await writeFile(request, JSON.stringify({ version: 1, product: 'tuanbo-link-console', machineCode: machine }));
  const script = join(process.cwd(), 'scripts/license-issuer.mjs');
  execFileSync(process.execPath, [script, 'keygen', '--kid', 'test', '--private', privateFile, '--public', publicFile]);
  const args = [script, 'issue', '--kid', 'test', '--private', privateFile, '--public', publicFile, '--request', request, '--customer', '测试客户', '--kind', 'perpetual', '--updates-until', new Date(Date.now() + 86400000).toISOString(), '--out', output];
  execFileSync(process.execPath, args);
  const trusted = z.record(z.string(), z.string()).parse(JSON.parse(await readFile(publicFile, 'utf8')));
  expect(verifyLicense(await readFile(output, 'utf8'), machine, trusted, Date.now()).kind).toBe('perpetual');
  expect(() => execFileSync(process.execPath, args, { stdio: 'pipe' })).toThrow();
});
function issue(overrides: Partial<LicenseClaims> = {}): string {
  const claims: LicenseClaims = { version: 1, product: 'tuanbo-link-console', licenseId: randomUUID(), customer: '验收公司', machineCode: machine, kind: 'perpetual', issuedAt: new Date(now).toISOString(), useUntil: null, updatesUntil: '2027-09-21T00:00:00Z', ...overrides };
  const body = `${Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: 'test' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
  return `${body}.${sign(null, Buffer.from(body), keys.privateKey).toString('base64url')}`;
}
it('签名许可只接受指定主机，拒绝修改载荷、未知公钥和未来签发时间', () => {
  const token = issue();
  expect(verifyLicense(token, machine, publicKeys, now).customer).toBe('验收公司');
  expect(() => verifyLicense(token, `TB1-${'B'.repeat(64)}`, publicKeys, now)).toThrow('另一台主机');
  expect(() => verifyLicense(token, machine, {}, now)).toThrow('不受信任');
  const parts = token.split('.');
  parts[1] = Buffer.from(JSON.stringify({ customer: '篡改' })).toString('base64url');
  expect(() => verifyLicense(parts.join('.'), machine, publicKeys, now)).toThrow('签名无效');
  expect(() => verifyLicense(issue({ issuedAt: '2026-09-22T00:00:00Z' }), machine, publicKeys, now)).toThrow('本机时间');
});
it('买断升级期结束不影响使用；订阅和试用按截止时间到期', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-license-'));
  let time = now;
  const service = new LicenseService(directory, machine, publicKeys, () => time);
  expect((await service.status()).state).toBe('inactive');
  await service.activate(issue());
  time = Date.parse('2028-01-01T00:00:00Z');
  expect((await service.status()).state).toBe('active');
  time = now;
  for (const kind of ['subscription', 'trial'] as const) {
    const end = now + 86400000;
    await service.activate(issue({ kind, useUntil: new Date(end).toISOString() }));
    time = end;
    expect((await service.status()).state).toBe('expired');
    time = now;
  }
});
it('错误或到期导入不覆盖现有许可，未配置签发时明确显示状态', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-license-'));
  const service = new LicenseService(directory, machine, publicKeys, () => now);
  const valid = issue();
  await service.activate(valid);
  await expect(service.activate(issue({ machineCode: `TB1-${'B'.repeat(64)}` }))).rejects.toThrow('另一台主机');
  await expect(service.activate(issue({ kind: 'trial', issuedAt: '2026-09-01T00:00:00Z', useUntil: '2026-09-20T00:00:00Z' }))).rejects.toThrow('已到期');
  expect(await readFile(join(directory, 'licensing/license.jwt'), 'utf8')).toBe(valid);
  expect((await new LicenseService(directory, machine, {}).status()).state).toBe('unconfigured');
});
