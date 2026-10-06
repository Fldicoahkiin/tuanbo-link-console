import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { LicensingService } from './service';
import { createLicensingServer } from './http';
import { totpCode } from './console-auth';
const closing: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of closing.splice(0).reverse()) await close(); });
const host = 'admin.tuanbo-link.jinhefilm.com'; const origin = `https://${host}`;
async function setup() {
  let time = Date.parse('2026-10-06T00:00:00Z');
  const keys = generateKeyPairSync('ed25519'); const path = join(mkdtempSync(join(tmpdir(), 'console-http-')), 'test.db');
  const service = new LicensingService(path, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'test', randomBytes(32), () => time);
  closing.push(() => service.close()); const consoleService = service.console(randomBytes(32));
  const db = new DatabaseSync(path); closing.push(() => db.close());
  const code = (id: string) => totpCode(consoleService.auth.open(String(db.prepare('SELECT totp FROM console_users WHERE id=?').get(id)?.totp)), Math.floor(time / 30000));
  const users: Record<string, { token: string; csrf: string; id: string }> = {};
  for (const role of ['owner', 'operations', 'finance', 'viewer'] as const) {
    const user = role === 'owner' ? consoleService.auth.bootstrap(role) : consoleService.auth.createUser(role, role);
    await consoleService.auth.enroll(user.token, 'long-test-password', code(user.id), randomUUID()); time += 30000;
    const login = await consoleService.auth.login(role, 'long-test-password', code(user.id), randomUUID()); users[role] = { token: login.token, csrf: login.session.csrf, id: user.id };
  }
  const server = createLicensingServer(service, 'x'.repeat(32), undefined, undefined, undefined, false, undefined, false, { service: consoleService, origin });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); closing.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address');
  const send = (path: string, role?: string, body?: unknown, extra: Record<string, string> = {}) => new Promise<{ status: number; body: unknown; cookie: string[] | undefined }>((resolve, reject) => {
    const user = role ? users[role] : undefined;
    const req = httpRequest({ host: '127.0.0.1', port: address.port, path, method: body === undefined ? 'GET' : 'POST', headers: { host, origin, 'content-type': 'application/json', ...(user ? { cookie: `__Host-tblink-console=${user.token}`, 'x-csrf-token': user.csrf } : {}), ...extra } }, res => {
      const chunks: Buffer[] = []; res.on('data', (chunk: Buffer) => chunks.push(chunk)); res.on('end', () => { try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) as unknown, cookie: res.headers['set-cookie'] }); } catch (error) { reject(error instanceof Error ? error : new Error('响应解析失败')); } });
    }); req.on('error', reject); if (body !== undefined) req.write(JSON.stringify(body)); req.end();
  });
  return { send, service, consoleService, users, code, advance: () => { time += 30000; } };
}
it('HTTPS 管理域名、会话、来源与 CSRF 校验不可绕过', async () => {
  const s = await setup();
  expect((await s.send('/console-api/overview')).status).toBe(401);
  expect((await s.send('/console-api/overview', 'owner', undefined, { host: 'api.tuanbo-link.jinhefilm.com' })).status).toBe(404);
  expect((await s.send('/console-api/logout', 'owner', {}, { origin: 'https://evil.example' })).status).toBe(403);
  expect((await s.send('/console-api/logout', 'owner', {}, { 'x-csrf-token': 'wrong' })).status).toBe(403);
  expect((await s.send('/console-api/overview', 'owner')).status).toBe(200);
});
it('四类角色通过真实 HTTP 强制授权，列表不泄露码', async () => {
  const s = await setup(); const command = { operationId: randomUUID(), input: { action: 'grant', customer: '测试', customerType: 'company', quantity: 1, useUntil: '2026-11-06T00:00:00Z', purpose: 'gift', reason: '赠送' } };
  for (const role of ['operations', 'finance', 'viewer']) expect((await s.send('/console-api/commands', role, command)).status).toBe(403);
  const granted = await s.send('/console-api/commands', 'owner', command); expect(granted.status).toBe(200);
  const id = z.object({ id: z.string() }).parse(granted.body).id;
  for (const role of ['owner', 'operations', 'finance', 'viewer']) {
    const detail = await s.send(`/console-api/orders/${id}`, role); expect(detail.status).toBe(200); expect(JSON.stringify(detail.body)).not.toContain('TBA-');
  }
  expect((await s.send('/console-api/finance', 'operations')).status).toBe(403);
  expect((await s.send('/console-api/audit', 'finance')).status).toBe(403);
  expect((await s.send('/console-api/users', 'viewer')).status).toBe(403);
});
it('登录 Cookie 安全属性、权限变更即时撤销会话', async () => {
  const s = await setup(); s.advance();
  const login = await s.send('/console-api/login', undefined, { username: 'owner', password: 'long-test-password', code: s.code(s.users.owner!.id) });
  expect(login.status).toBe(200); expect(login.cookie?.[0]).toContain('Secure; HttpOnly; SameSite=Strict');
  const updated = await s.send('/console-api/commands', 'owner', { operationId: randomUUID(), input: { action: 'update-user', id: s.users.viewer!.id, role: 'viewer', enabled: false, reason: '离职' } });
  expect(updated.status).toBe(200); expect((await s.send('/console-api/session', 'viewer')).status).toBe(401);
});
