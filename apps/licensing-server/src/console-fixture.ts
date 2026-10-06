/** Isolated browser acceptance fixture. Never imported by production entrypoints. */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { LicensingService } from './service';
import { createLicensingServer } from './http';

export async function startConsoleFixture() {
  const keys = generateKeyPairSync('ed25519'); const now = () => Date.parse('2026-10-06T08:00:00Z');
  const service = new LicensingService(':memory:', keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'fixture', randomBytes(32), now);
  const consoleService = service.console(randomBytes(32));
  // Enrollment uses the real TOTP route; the fixture returns only a one-time invitation.
  const first = consoleService.auth.bootstrap('fixture-owner');
  const info = consoleService.auth.enrollmentInfo(first.token);
  const server = createLicensingServer(service, randomBytes(32).toString('hex'), undefined, undefined, undefined, false, undefined, false, { service: consoleService, origin: 'https://admin.tuanbo-link.jinhefilm.com' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('测试服务未监听');
  return { port: address.port, invitation: first.token, secret: info.secret, now: now(),
    invite: (role: 'operations' | 'finance' | 'viewer') => consoleService.auth.createUser(`fixture-${role}`, role),
    enrollment: (token: string) => consoleService.auth.enrollmentInfo(token),
    close: () => new Promise<void>((resolve, reject) => server.close(error => { service.close(); if (error) reject(error); else resolve(); })) };
}
