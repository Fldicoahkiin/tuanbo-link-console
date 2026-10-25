import { listenHttpTestServer } from './http-test-server';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { LicensingService } from './service';
import { createLicensingServer } from './http';
import { totpCode, type ConsoleSession } from './console-auth';
import { FEEDBACK_SERVER_LIMITS, type FeedbackServerLimits } from './feedback';
import { feedbackReceiptSchema, type FeedbackSubmission } from '../../../packages/schema/src/feedback';
import { FeedbackService } from '../../desktop/src/main/link/feedback-service';

const keys = generateKeyPairSync('ed25519');
const machine = `TB1-${'A'.repeat(64)}`;
const origin = 'https://api.tuanbo-link.jinhefilm.com';
const closing: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of closing.splice(0).reverse()) await close(); });

async function setup(limits: Partial<FeedbackServerLimits> = {}, free = 100 * 1024 ** 3) {
  let time = Date.parse('2026-10-25T08:00:00Z');
  const folder = mkdtempSync(join(tmpdir(), 'tblink-feedback-'));
  const path = join(folder, 'license.db'); const directory = join(folder, 'feedback');
  const service = new LicensingService(path, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'test', randomBytes(32), () => time);
  closing.push(() => service.close());
  const store = service.feedback(directory, { limits, freeBytes: () => Promise.resolve(free) });
  const consoleService = service.console(randomBytes(32));
  const db = new DatabaseSync(path); closing.push(() => db.close());
  const server = createLicensingServer(service, 'x'.repeat(32), undefined, undefined, undefined, true, undefined, false, { service: consoleService, origin: 'https://admin.tuanbo-link.jinhefilm.com', feedback: store }, store);
  await listenHttpTestServer(server); closing.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address');
  const base = `http://127.0.0.1:${address.port}`;
  const post = (body: unknown, ip = '203.0.113.1') => fetch(`${base}/v1/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tblink-Client-IP': ip }, body: JSON.stringify(body) });
  const put = (id: string, token: string, body: Buffer, headers: Record<string, string> = {}) => fetch(`${base}/v1/feedback/${id}/diagnostic`, {
    method: 'PUT', headers: { 'Content-Type': 'application/gzip', Authorization: `Bearer ${token}`, 'X-Tblink-Client-IP': '203.0.113.1', ...headers }, body: new Uint8Array(body) });
  const receipt = async (response: Response) => { expect(response.status).toBe(200); return feedbackReceiptSchema.parse(await response.json()); };
  const license = () => {
    const order = service.createOrder({ reference: `order-${randomUUID()}`, customer: '测试客户', customerType: 'company', quantity: 1, kind: 'perpetual', amountFen: 100, useUntil: null, updatesUntil: '2027-10-25T00:00:00Z' });
    const code = service.fulfill(order.id, { paymentReference: `pay-${order.id}`, amountFen: 100 }).licenses[0]!.code;
    return service.activate({ product: 'tuanbo-link-console', code, machineCode: machine }).license;
  };
  return { service, store, consoleService, db, base, post, put, receipt, license, directory, advance: (ms: number) => { time += ms; }, now: () => time };
}

function packageOf(bytes: number): Buffer {
  const body = gzipSync(randomBytes(bytes), { level: 0 });
  return body;
}
function report(diagnostic: Buffer | null, overrides: Partial<FeedbackSubmission> = {}): FeedbackSubmission {
  return { product: 'tuanbo-link-console', version: '0.5.3', category: 'lighting', description: '播放第 3 首时灯光没有跟上', contact: '13800000000',
    occurredAt: '2026-10-25T07:50:00.000Z', machineCode: machine, license: null,
    environment: { os: 'Windows 11 24H2', obs: '已连接 31.0.2', ma2: '已连接', playback: '内部主控', license: '已激活' },
    diagnostic: diagnostic ? { bytes: diagnostic.length, sha256: createHash('sha256').update(diagnostic).digest('hex') } : null, ...overrides };
}

it('未激活电脑提交反馈：拿到编号和一次性上传凭据，诊断包核对大小、摘要和 gzip 后才保存', async () => {
  const s = await setup(); const body = packageOf(4096);
  const first = await s.receipt(await s.post(report(body)));
  expect(first.number).toMatch(/^FB-20261025-[A-HJ-NP-Z2-9]{4}$/);
  expect(first.upload?.expiresAt).toBe('2026-10-25T08:30:00.000Z');
  const token = first.upload!.token;
  // 大小、摘要或格式不符都拒收，不留下文件，凭据仍可再用。
  expect((await s.put(first.id, token, Buffer.concat([body, Buffer.from('x')]))).status).toBe(400);
  const tampered = Buffer.from(body); tampered.writeUInt8(tampered.readUInt8(tampered.length - 1) ^ 1, tampered.length - 1);
  expect(await (await s.put(first.id, token, tampered)).json()).toMatchObject({ code: 'UPLOAD_DIGEST' });
  expect((await s.put(first.id, token, body, { 'Content-Type': 'application/octet-stream' })).status).toBe(415);
  expect((await s.put(first.id, `TBF-${'0'.repeat(64)}`, body)).status).toBe(401);
  expect(readdirSync(s.directory)).toEqual([]);
  expect(await (await s.put(first.id, token, body)).json()).toEqual({ received: true, bytes: body.length });
  expect(readdirSync(s.directory)).toEqual([`${first.id}.tbdiag.gz`]);
  // 凭据只能用一次。
  expect((await s.put(first.id, token, body)).status).toBe(401);
  const plain = Buffer.from('not gzip at all');
  const second = await s.receipt(await s.post(report(plain, { description: '另一条：画面卡住' })));
  expect(await (await s.put(second.id, second.upload!.token, plain)).json()).toMatchObject({ code: 'UPLOAD_FORMAT' });
  const row = z.object({ source: z.string(), license_id: z.null(), attachment_limit: z.number(), attachment_bytes: z.number() }).parse(s.db.prepare('SELECT source,license_id,attachment_limit,attachment_bytes FROM feedback WHERE id=?').get(first.id));
  // 来源只存带密钥的摘要，不存地址。
  expect(row.source).toMatch(/^[a-f0-9]{32}$/); expect(row.source).not.toContain('203.0.113.1');
  expect(row).toMatchObject({ attachment_limit: 2 * 1024 * 1024, attachment_bytes: body.length });
});

it('授权有效的电脑可附 8 MB；未激活、签名不对或授权已撤销的只能附 2 MB，超出时文字照收', async () => {
  const s = await setup(); const big = { bytes: 3 * 1024 * 1024, sha256: 'a'.repeat(64) };
  const unlicensed = await s.receipt(await s.post({ ...report(null), diagnostic: big }));
  expect(unlicensed.upload).toBeNull(); expect(unlicensed.attachmentIssue).toContain('未激活电脑的上传上限 2.0 MB');
  const token = s.license();
  const licensed = await s.receipt(await s.post({ ...report(null, { license: token, description: '授权电脑的反馈' }), diagnostic: big }));
  expect(licensed.upload).not.toBeNull(); expect(licensed.attachmentIssue).toBeNull();
  // 别的机器拿这份授权、或签名被改，都按未激活处理。
  expect(s.service.feedbackLicense(token, `TB1-${'B'.repeat(64)}`)).toBeNull();
  const signed = token.slice(0, token.lastIndexOf('.') + 1); const signature = token.slice(signed.length);
  const flipped = `${signature.slice(0, 10)}${signature.charAt(10) === 'A' ? 'B' : 'A'}${signature.slice(11)}`;
  expect(s.service.feedbackLicense(`${signed}${flipped}`, machine)).toBeNull();
  expect(s.service.feedbackLicense(token, machine)).toMatch(/^[a-f0-9-]{36}$/);
  const licenseId = z.object({ license_id: z.string() }).parse(s.db.prepare('SELECT license_id FROM feedback WHERE id=?').get(licensed.id)).license_id;
  s.service.revoke(licenseId, { reason: '测试撤销' });
  expect(s.service.feedbackLicense(token, machine)).toBeNull();
});

it('网络、电脑和全站都有提交上限；丢失回复后的重试拿回原编号，不重复计数', async () => {
  const s = await setup({ perSourceHour: 3, perMachineDay: 4, perDay: 6 });
  const one = await s.receipt(await s.post(report(packageOf(100))));
  const again = await s.receipt(await s.post(report(packageOf(100))));
  expect(again).toMatchObject({ id: one.id, number: one.number }); expect(again.upload?.token).not.toBe(one.upload?.token);
  // 换一个说明才算新反馈。
  for (const text of ['第二条现象说明', '第三条现象说明']) await s.receipt(await s.post(report(null, { description: text })));
  const limited = await s.post(report(null, { description: '第四条现象说明' }));
  expect(limited.status).toBe(429); expect(await limited.json()).toMatchObject({ code: 'FEEDBACK_LIMITED', message: '这个网络一小时内已提交 3 条反馈' });
  await s.receipt(await s.post(report(null, { description: '换个网络提交' }), '198.51.100.7'));
  expect(await (await s.post(report(null, { description: '同一台电脑再提交' }), '198.51.100.8')).json()).toMatchObject({ message: '这台电脑今天已提交 4 条反馈' });
  await s.receipt(await s.post(report(null, { description: '另一台电脑', machineCode: `TB1-${'C'.repeat(64)}` }), '198.51.100.9'));
  await s.receipt(await s.post(report(null, { description: '读不出授权的电脑', machineCode: null }), '198.51.100.10'));
  expect(await (await s.post(report(null, { description: '全站上限测试', machineCode: null }), '198.51.100.11')).json()).toMatchObject({ message: '今天收到的反馈已达上限' });
  // 一小时后这个网络的限制解除，但当天的全站上限仍在。
  s.advance(3_600_001);
  expect(await (await s.post(report(null, { description: '一小时后再提交', machineCode: `TB1-${'D'.repeat(64)}` }))).json()).toMatchObject({ message: '今天收到的反馈已达上限' });
});

it('字段不符给出能看懂的原因；没配置反馈目录时回答尚未开通', async () => {
  const s = await setup();
  expect(await (await s.post(report(null, { description: '短' }))).json()).toMatchObject({ code: 'INVALID_FEEDBACK', message: '请至少写 5 个字说明现象' });
  expect(await (await s.post({ ...report(null), extra: true })).json()).toMatchObject({ code: 'INVALID_FEEDBACK' });
  const service = new LicensingService(':memory:', keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'test', randomBytes(32));
  closing.push(() => service.close());
  const server = createLicensingServer(service, 'x'.repeat(32));
  await listenHttpTestServer(server); closing.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address');
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report(null)) });
  expect(response.status).toBe(404); expect(await response.json()).toMatchObject({ code: 'FEEDBACK_DISABLED' });
});

it('暂存总量或磁盘余量不够时不发上传凭据，文字照收', async () => {
  const s = await setup({ storageBytes: 1000 });
  const held = await s.receipt(await s.post(report(packageOf(200))));
  expect(held.upload).not.toBeNull();
  const full = await s.receipt(await s.post(report(packageOf(900), { description: '第二条：空间不够' })));
  expect(full.upload).toBeNull(); expect(full.attachmentIssue).toContain('服务器暂存空间不足');
  const disk = await setup({}, FEEDBACK_SERVER_LIMITS.freeSpaceBytes + 100);
  expect((await disk.receipt(await disk.post(report(packageOf(200))))).attachmentIssue).toContain('服务器暂存空间不足');
});

it('每小时整理一次：过期上传位释放、半年前的诊断包删除、两年前的反馈删除、中断上传的残片清掉', async () => {
  const s = await setup();
  const old = await s.receipt(await s.post(report(packageOf(100))));
  expect((await s.put(old.id, old.upload!.token, packageOf(100))).status).toBe(400);
  const body = packageOf(100); const kept = await s.receipt(await s.post(report(body, { description: '会过期的诊断包' })));
  expect((await s.put(kept.id, kept.upload!.token, body)).status).toBe(200);
  const leftover = join(s.directory, `${randomUUID()}.part`); writeFileSync(leftover, 'x'); utimesSync(leftover, new Date(s.now() - 7_200_000), new Date(s.now() - 7_200_000));
  s.advance(181 * 86_400_000);
  await s.receipt(await s.post(report(null, { description: '触发一次整理', machineCode: `TB1-${'E'.repeat(64)}` })));
  const state = (id: string) => s.db.prepare('SELECT upload_hash,attachment_issue,attachment_removed FROM feedback WHERE id=?').get(id);
  expect(state(old.id)).toMatchObject({ upload_hash: null, attachment_issue: '诊断包没有在上传期限内传到服务器' });
  expect(state(kept.id)).toMatchObject({ attachment_removed: new Date(s.now()).toISOString() });
  expect(existsSync(join(s.directory, `${kept.id}.tbdiag.gz`))).toBe(false); expect(existsSync(leftover)).toBe(false);
  s.advance(550 * 86_400_000);
  await s.receipt(await s.post(report(null, { description: '再次触发整理', machineCode: `TB1-${'F'.repeat(64)}` })));
  expect(state(old.id)).toBeUndefined(); expect(state(kept.id)).toBeUndefined();
});

it('桌面端问题反馈经真实接口提交并上传诊断包，运营后台按角色查看、下载和结案', async () => {
  const s = await setup(); const logs: unknown[] = [];
  const fetchLocal: typeof fetch = (input, options) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.origin).toBe(origin);
    return fetch(`${s.base}${url.pathname}`, { ...options, headers: { ...Object.fromEntries(new Headers(options?.headers)), 'X-Tblink-Client-IP': '192.0.2.10' } });
  };
  const token = s.license();
  const desktop = new FeedbackService({ serverUrl: `${origin}/`, temporaryDirectory: mkdtempSync(join(tmpdir(), 'tblink-feedback-client-')), fetch: fetchLocal, now: s.now,
    identity: () => Promise.resolve({ machineCode: machine, license: token, licensed: true, licenseSummary: '已激活', version: '0.5.3' }),
    environment: () => ({ os: 'Windows 11', obs: '已连接', ma2: '未连接', playback: '内部主控' }),
    writeDiagnostic: (path, context) => writeFile(path, gzipSync(JSON.stringify({ context, logs: ['…'] }))),
    log: entry => { logs.push(entry); return Promise.resolve(); } });
  const result = await desktop.submit({ category: 'lighting', description: '灯光 Cue 3 没有跟上时间码', contact: '微信 tblink', occurredAt: '2026-10-25T07:58:00.000Z', includeDiagnostics: true, includeMa2: false, context: { page: '测试' } });
  expect(result).toMatchObject({ outcome: 'submitted', attachment: 'uploaded', attachmentIssue: null });
  const id = z.object({ id: z.string() }).parse(s.db.prepare('SELECT id FROM feedback WHERE number=?').get(result.number)).id;

  const roles = await consoleSessions(s);
  const list = s.consoleService.list('feedback', { page: 1, q: '', state: 'active', channel: '', from: '', to: '' }, roles.operations);
  expect(list.items).toEqual([expect.objectContaining({ id, number: result.number, category: 'lighting', state: 'open', attachment: 'received', summary: '灯光 Cue 3 没有跟上时间码' })]);
  const detail = s.consoleService.detail('feedback', id, roles.owner);
  expect(detail.item).toMatchObject({ contact: '微信 tblink', envOs: 'Windows 11', envLicense: '已激活', reporterMachine: machine, attachment: 'received' });
  expect(detail.item.licenseId).toMatch(/^[a-f0-9-]{36}$/);
  for (const role of ['finance', 'viewer'] as const) {
    expect(() => s.consoleService.list('feedback', { page: 1, q: '', state: '', channel: '', from: '', to: '' }, roles[role])).toThrow('只对管理员和运营开放');
    expect(() => s.consoleService.feedbackAttachment(id, roles[role])).toThrow('只对管理员和运营开放');
    expect(s.consoleService.overview(roles[role]).item.openFeedback).toBeUndefined();
  }
  expect(s.consoleService.overview(roles.owner).item.openFeedback).toBe(1);
  expect(s.consoleService.feedbackAttachment(id, roles.operations)).toEqual({ number: result.number });
  const channels = { reconcile: () => Promise.resolve({}), refund: () => Promise.reject(new Error('未接入')), paymentLink: () => ({ url: 'https://example.com', expiresAt: '' }) };
  const close = (conclusion: string) => s.consoleService.execute({ operationId: randomUUID(), input: { action: 'update-feedback', id, state: 'closed', conclusion, reason: '' } }, roles.operations, randomUUID(), channels);
  await expect(close('')).rejects.toThrow('关闭前请写明处理结论');
  await expect(close('MA2 时间码偏移，已改成从 MTC 起始码同步')).resolves.toMatchObject({ message: '反馈已更新' });
  expect(s.consoleService.detail('feedback', id, roles.operations).history).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'update-feedback', result: 'success' })]));
  await expect(s.consoleService.execute({ operationId: randomUUID(), input: { action: 'update-feedback', id, state: 'open', conclusion: '', reason: '' } }, roles.finance, randomUUID(), channels)).rejects.toThrow('当前角色不能执行此操作');
});

it('运营后台下载诊断包：只给管理员和运营，文件原样返回并记审计', async () => {
  const s = await setup(); const body = packageOf(2048);
  const sent = await s.receipt(await s.post(report(body)));
  const roles = await consoleSessions(s); const cookies = roles.cookies;
  const download = (role: keyof typeof cookies, id = sent.id) => new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
    const url = new URL(s.base);
    const req = httpRequest({ host: url.hostname, port: url.port, path: `/console-api/feedback/${id}/diagnostic`, headers: { host: 'admin.tuanbo-link.jinhefilm.com', cookie: `__Host-tblink-console=${cookies[role]}` } }, res => {
      const chunks: Buffer[] = []; res.on('data', (chunk: Buffer) => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    }); req.on('error', reject); req.end();
  });
  // 诊断包还没传上来时没有可下载的文件。
  expect((await download('owner')).status).toBe(404);
  expect((await s.put(sent.id, sent.upload!.token, body)).status).toBe(200);
  for (const role of ['finance', 'viewer'] as const) expect((await download(role)).status).toBe(403);
  const file = await download('operations');
  expect(file.status).toBe(200); expect(file.body.equals(body)).toBe(true);
  expect(file.headers['content-type']).toBe('application/gzip');
  expect(file.headers['content-disposition']).toBe(`attachment; filename="${sent.number}.tbdiag.gz"`);
  expect(s.db.prepare("SELECT reason,result FROM console_audit WHERE action='feedback.diagnostic-downloaded' AND target=?").all(sent.id)).toEqual([{ reason: sent.number, result: 'success' }]);
});

/** One signed-in console session per role, through the real enrollment and TOTP login. */
async function consoleSessions(s: Awaited<ReturnType<typeof setup>>) {
  const code = (id: string) => totpCode(s.consoleService.auth.open(String(s.db.prepare('SELECT totp FROM console_users WHERE id=?').get(id)?.totp)), Math.floor(s.now() / 30000));
  const sessions: Record<string, ConsoleSession> = {}; const cookies: Record<string, string> = {};
  for (const role of ['owner', 'operations', 'finance', 'viewer'] as const) {
    const user = role === 'owner' ? s.consoleService.auth.bootstrap(role) : s.consoleService.auth.createUser(role, role);
    await s.consoleService.auth.enroll(user.token, 'long-test-password', code(user.id), randomUUID()); s.advance(30000);
    const login = await s.consoleService.auth.login(role, 'long-test-password', code(user.id), randomUUID());
    sessions[role] = login.session; cookies[role] = login.token;
  }
  return { owner: sessions.owner!, operations: sessions.operations!, finance: sessions.finance!, viewer: sessions.viewer!,
    cookies: { owner: cookies.owner!, operations: cookies.operations!, finance: cookies.finance!, viewer: cookies.viewer! } };
}
