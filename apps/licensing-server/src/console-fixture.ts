/** Isolated browser acceptance fixture. Never imported by production entrypoints. */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpdateReleases } from './update-releases';
import { LicensingService } from './service';
import { createLicensingServer } from './http';

export async function startConsoleFixture() {
  // 时钟可推进，用于验收二次验证过期和新一枚验证码。
  const keys = generateKeyPairSync('ed25519'); let time = Date.parse('2026-10-06T08:00:00Z'); const now = () => time;
  const service = new LicensingService(':memory:', keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'fixture', randomBytes(32), now);
  const consoleService = service.console(randomBytes(32));
  // Enrollment uses the real TOTP route; the fixture returns only a one-time invitation.
  const first = consoleService.auth.bootstrap('fixture-owner');
  const info = consoleService.auth.enrollmentInfo(first.token);
  // A spool with one staged release, as tblink-update-publish.path would report it.
  const spool = mkdtempSync(join(tmpdir(), 'tblink-console-updates-'));
  for (const name of ['update-requests', 'update-results']) mkdirSync(join(spool, name));
  writeFileSync(join(spool, 'update-status.json'), JSON.stringify({ version: 1, generatedAt: '2026-10-06T08:00:00Z',
    feed: { version: '0.4.29', releaseDate: '2026-09-28T18:15:14.517Z', signed: false }, rollback: { version: null, issue: '没有可以回滚到的上一版' },
    staged: [{ name: '0.5.0-13f7e625898e', issue: null, version: '0.5.0', gitSha: '13f7e625898e96076e1d02ef353ca90a78cebc', manifestSha256: 'b'.repeat(64),
      releaseDate: '2026-10-23T06:34:50.642Z', kid: 'release-2026-10-a', size: 412835955 }] }));
  const server = createLicensingServer(service, randomBytes(32).toString('hex'), undefined, undefined, undefined, false, undefined, false,
    { service: consoleService, origin: 'https://admin.tuanbo-link.jinhefilm.com', updates: new UpdateReleases(spool) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('测试服务未监听');
  return { port: address.port, invitation: first.token, secret: info.secret, now, advance: (ms: number) => { time += ms; },
    invite: (role: 'operations' | 'finance' | 'viewer') => consoleService.auth.createUser(`fixture-${role}`, role),
    enrollment: (token: string) => consoleService.auth.enrollmentInfo(token),
    close: () => new Promise<void>((resolve, reject) => server.close(error => { service.close(); if (error) reject(error); else resolve(); })) };
}
