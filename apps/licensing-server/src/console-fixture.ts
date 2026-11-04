/** Isolated browser acceptance fixture. Never imported by production entrypoints. */
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { z } from 'zod';
import { UpdateReleases } from './update-releases';
import { LicensingService } from './service';
import { createLicensingServer } from './http';
import { AlipayCheckout, AlipayNotifications } from './alipay';

export async function startConsoleFixture() {
  // 时钟可推进，用于验收二次验证过期和新一枚验证码。
  const keys = generateKeyPairSync('ed25519'); let time = Date.parse('2026-10-06T08:00:00Z'); const now = () => time;
  const service = new LicensingService(':memory:', keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'fixture', randomBytes(32), now);
  const consoleService = service.console(randomBytes(32));
  // Enrollment uses the real TOTP route; the fixture returns only a one-time invitation.
  const first = consoleService.auth.bootstrap('fixture-owner');
  const info = consoleService.auth.enrollmentInfo(first.token);
  // One staged release, as tblink-update-publish.path would report it.
  const spool = mkdtempSync(join(tmpdir(), 'tblink-console-updates-'));
  for (const name of ['update-requests', 'publisher/results']) mkdirSync(join(spool, name), { recursive: true });
  writeFileSync(join(spool, 'publisher', 'update-status.json'), JSON.stringify({ version: 1, generatedAt: '2026-10-06T08:00:00Z',
    feed: { version: '0.4.29', releaseDate: '2026-09-28T18:15:14.517Z', signed: false }, rollback: { version: null, issue: '没有可以回滚到的上一版' },
    staged: [{ name: '0.5.0-13f7e625898e', issue: null, version: '0.5.0', gitSha: '13f7e625898e96076e1d02ef353ca90a78cebc', manifestSha256: 'b'.repeat(64),
      releaseDate: '2026-10-23T06:34:50.642Z', kid: 'release-2026-10-a', size: 412835955 }] }));
  // 支付宝沙箱身份和本地生成的密钥：付款链接只在本地签名，不连支付宝；到账由 payAlipay 模拟一条验签后的通知。
  const identity = { appId: '2026000000000001', sellerId: '2088000000000001' };
  const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 }); const provider = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const alipay = new AlipayNotifications(identity.appId, identity.sellerId, provider.publicKey.export({ type: 'spki', format: 'pem' }).toString());
  const checkout = new AlipayCheckout(identity.appId, identity.sellerId, merchant.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'sandbox', 'https://api.tuanbo-link.jinhefilm.com', now);
  // 问题反馈：包存在临时目录，磁盘余量按充足处理。
  const feedback = service.feedback(mkdtempSync(join(tmpdir(), 'tblink-console-feedback-')), { freeBytes: () => Promise.resolve(100 * 1024 ** 3) });
  const server = createLicensingServer(service, randomBytes(32).toString('hex'), alipay, checkout, undefined, false, undefined, false,
    { service: consoleService, origin: 'https://admin.tuanbo-link.jinhefilm.com', updates: new UpdateReleases(join(spool, 'update-requests'), join(spool, 'publisher')), feedback }, feedback);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('测试服务未监听');
  return { port: address.port, invitation: first.token, secret: info.secret, now, advance: (ms: number) => { time += ms; },
    invite: (role: 'operations' | 'finance' | 'viewer') => consoleService.auth.createUser(`fixture-${role}`, role),
    enrollment: (token: string) => consoleService.auth.enrollmentInfo(token),
    // 经公开接口提交一条带诊断包的反馈，与桌面端相同的两步：先文字，再上传包。
    submitFeedback: async (description: string) => {
      const body = gzipSync(JSON.stringify({ fixture: true, description }));
      const base = `http://127.0.0.1:${address.port}`;
      const sent = await fetch(`${base}/v1/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        product: 'tuanbo-link-console', version: '0.5.3', category: 'lighting', description, contact: '微信 fixture', occurredAt: new Date(time - 600000).toISOString(),
        machineCode: `TB1-${'A'.repeat(64)}`, license: null, environment: { os: 'Windows 11 24H2', obs: '已连接', ma2: '已连接', playback: '内部主控', license: '未激活' },
        diagnostic: { bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') } }) });
      const receipt = z.object({ id: z.string(), number: z.string(), upload: z.object({ token: z.string() }) }).parse(await sent.json());
      const uploaded = await fetch(`${base}/v1/feedback/${receipt.id}/diagnostic`, { method: 'PUT', headers: { 'Content-Type': 'application/gzip', Authorization: `Bearer ${receipt.upload.token}` }, body: new Uint8Array(body) });
      if (!uploaded.ok) throw new Error(`诊断包上传失败：${uploaded.status}`);
      return { number: receipt.number, bytes: body.length };
    },
    payAlipay: (orderId: string) => service.alipayNotification({ orderId, ...identity, status: 'TRADE_SUCCESS', amountFen: service.describeOrder(orderId).amountFen, refundFen: 0, paymentReference: `alipay:${orderId.replaceAll('-', '')}` }),
    close: () => new Promise<void>((resolve, reject) => server.close(error => { service.close(); if (error) reject(error); else resolve(); })) };
}
