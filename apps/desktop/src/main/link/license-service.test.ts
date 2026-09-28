import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
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
it('买断升级期结束不影响使用；订阅按截止时间到期', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-license-'));
  let time = now;
  const service = new LicenseService(directory, machine, publicKeys, () => time);
  expect((await service.status()).state).toBe('inactive');
  await service.activate(issue());
  time = Date.parse('2028-01-01T00:00:00Z');
  expect((await service.status()).state).toBe('active');
  time = now;
  for (const kind of ['subscription'] as const) {
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
  await expect(service.activate(issue({ kind: 'subscription', issuedAt: '2026-09-01T00:00:00Z', useUntil: '2026-09-20T00:00:00Z' }))).rejects.toThrow('使用期限已结束');
  expect(await readFile(join(directory, 'licensing/license.jwt'), 'utf8')).toBe(valid);
  expect((await new LicenseService(directory, machine, {}).status()).state).toBe('unconfigured');
});

it('在线激活验签后保存激活码，离线租约到期要求联网，网络失败保留许可', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-online-'));
  let time = now;
  const credentials = new Map<string, string>();
  const token = issue({ online: { leaseUntil: new Date(now + 86400000).toISOString(), customerType: 'personal' } });
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ license: token })));
  const service = new LicenseService(directory, machine, publicKeys, () => time, {
    serverUrl: 'https://license.example.com', enforcement: 'required', fetch: request,
    credentials: {
      hasCredential: key => Promise.resolve(credentials.has(key)),
      loadCredential: key => Promise.resolve(credentials.get(key) ?? ''),
      saveCredential: (key, value) => { credentials.set(key, value); return Promise.resolve(); }
    }
  });
  expect((await service.activateCode(`TBA-${'A'.repeat(32)}`)).state).toBe('active');
  expect(request).toHaveBeenCalledOnce();
  expect(credentials.get('license.activation.code')).toBe(`TBA-${'A'.repeat(32)}`);
  request.mockRejectedValueOnce(new Error('offline'));
  await expect(service.refreshOnline()).rejects.toThrow('无法连接');
  expect(await readFile(join(directory, 'licensing/license.jwt'), 'utf8')).toBe(token);
  time += 86400000;
  expect((await service.status()).state).toBe('renewal-required');
  time = now;
  expect((await service.status()).message).toContain('回拨');
});

it('拒绝明文传输、不可用安全存储、超大响应以及未签名响应，现有许可不被替换', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-online-invalid-'));
  const token = issue(); await new LicenseService(directory, machine, publicKeys, () => now).activate(token);
  const request = vi.fn<typeof fetch>();
  const credentials = { hasCredential: () => Promise.resolve(false), loadCredential: () => Promise.resolve(''), saveCredential: () => Promise.resolve() };
  const options = { serverUrl: 'https://license.example.com', enforcement: 'required' as const, fetch: request, credentials };
  const code = `TBA-${'A'.repeat(32)}`;
  await expect(new LicenseService(directory, machine, publicKeys, () => now, { ...options, serverUrl: 'http://license.example.com' }).activateCode(code)).rejects.toThrow('HTTPS');
  const inaccessible = { ...options, credentials: { ...credentials, saveCredential: () => Promise.reject(new Error('安全存储不可用')) } };
  await expect(new LicenseService(directory, machine, publicKeys, () => now, inaccessible).activateCode(code)).rejects.toThrow('安全存储');
  expect(request).not.toHaveBeenCalled();
  const service = new LicenseService(directory, machine, publicKeys, () => now, options);
  request.mockResolvedValueOnce(new Response('x'.repeat(21000)));
  await expect(service.activateCode(code)).rejects.toThrow('大小限制');
  request.mockResolvedValueOnce(new Response(JSON.stringify({ license: 'unsigned' })));
  await expect(service.activateCode(code)).rejects.toThrow('格式无效');
  expect(await readFile(join(directory, 'licensing/license.jwt'), 'utf8')).toBe(token);
});

it('不接受有效签名的试用许可，不替换已有付费许可', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-no-trial-'));
  const service = new LicenseService(directory, machine, publicKeys, () => now);
  const paid = issue(); await service.activate(paid);
  await expect(service.activate(issue({ kind: 'trial', useUntil: '2026-09-30T00:00:00Z' }))).rejects.toThrow('不接受试用');
  expect(await readFile(join(directory, 'licensing/license.jwt'), 'utf8')).toBe(paid);
});

it('每次进程启动联网验证一次，并发状态读取共用请求；拒绝旧缓存放行', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-startup-'));
  const stored = new Map<string, string>();
  const credentials = {
    hasCredential: (key: string) => Promise.resolve(stored.has(key)),
    loadCredential: (key: string) => Promise.resolve(stored.get(key) ?? ''),
    saveCredential: (key: string, value: string) => { stored.set(key, value); return Promise.resolve(); }
  };
  const token = issue({ online: { leaseUntil: new Date(now + 7 * 86400000).toISOString(), customerType: 'personal' } });
  const request = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ license: token }))));
  const make = () => new LicenseService(directory, machine, publicKeys, () => now, { serverUrl: 'https://license.example.com', enforcement: 'required', credentials, fetch: request });
  await make().activateCode(`TBA-${'A'.repeat(32)}`);
  request.mockClear();
  const reopened = make();
  const states = await Promise.all([reopened.status(), reopened.status(), reopened.status()]);
  expect(states.every(status => status.state === 'active')).toBe(true);
  expect(request).toHaveBeenCalledOnce();
  await reopened.status();
  expect(request).toHaveBeenCalledOnce();
  request.mockRejectedValueOnce(new Error('offline'));
  const offline = make();
  expect((await offline.status()).state).toBe('renewal-required');
  expect((await offline.status()).message).toContain('无法连接');
  expect(request).toHaveBeenCalledTimes(2);
  expect(await readFile(join(directory, 'licensing/license.jwt'), 'utf8')).toBe(token);
  expect((await offline.refreshOnline()).state).toBe('active');
  expect((await offline.status()).state).toBe('active');
  expect(request).toHaveBeenCalledTimes(3);
  request.mockResolvedValueOnce(new Response(null, { status: 403 }));
  expect((await make().status()).message).toContain('撤销');
  request.mockResolvedValueOnce(new Response(null, { status: 409 }));
  expect((await make().status()).state).toBe('renewal-required');
  request.mockResolvedValueOnce(new Response(JSON.stringify({ license: 'unsigned' })));
  expect((await make().status()).state).toBe('renewal-required');
  expect(await readFile(join(directory, 'licensing/license.jwt'), 'utf8')).toBe(token);
});

it('在线发行不允许通过导入永久文件绕过启动验证；新机器不发送空激活请求', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-startup-import-'));
  const request = vi.fn<typeof fetch>();
  const legacy = issue();
  const service = new LicenseService(directory, machine, publicKeys, () => now, {
    serverUrl: 'https://license.example.com', enforcement: 'required', fetch: request,
    credentials: { hasCredential: () => Promise.resolve(false), loadCredential: () => Promise.resolve(''), saveCredential: () => Promise.resolve() }
  });
  expect((await service.status()).state).toBe('inactive');
  expect(request).not.toHaveBeenCalled();
  await new LicenseService(directory, machine, publicKeys, () => now).activate(legacy);
  expect((await service.status()).state).toBe('renewal-required');
  await expect(service.activate(legacy)).rejects.toThrow('激活码');
  expect(await readFile(join(directory, 'licensing/license.jwt'), 'utf8')).toBe(legacy);
});

it('已到期的本机订阅可在主进程取得续费证明，拒绝其他授权 ID 和买断授权', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-renewal-proof-'));
  let time = now;
  const values = new Map<string, string>();
  const id = randomUUID();
  const code = `TBA-${'D'.repeat(32)}`;
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ license: issue({ licenseId: id,
    kind: 'subscription', useUntil: new Date(now + 86400000).toISOString(),
    online: { leaseUntil: new Date(now + 86400000).toISOString(), customerType: 'company' } }) })));
  const service = new LicenseService(directory, machine, publicKeys, () => time, {
    serverUrl: 'https://license.example.com', enforcement: 'required', fetch: request,
    credentials: { hasCredential: key => Promise.resolve(values.has(key)), loadCredential: key => Promise.resolve(values.get(key) ?? ''),
      saveCredential: (key, value) => { values.set(key, value); return Promise.resolve(); } }
  });
  await service.activateCode(code);
  time += 2 * 86400000;
  expect((await service.status()).state).toBe('expired');
  expect(await service.renewalAuthorization(id)).toEqual({ product: 'tuanbo-link-console', code, machineCode: machine });
  await expect(service.renewalAuthorization(randomUUID())).rejects.toThrow('只能续费');
  request.mockResolvedValueOnce(new Response(JSON.stringify({ license: issue({ licenseId: id, online: {
    leaseUntil: new Date(time + 86400000).toISOString(), customerType: 'company' } }) })));
  await service.activateCode(code);
  await expect(service.renewalAuthorization(id)).rejects.toThrow('只能续费');
});
