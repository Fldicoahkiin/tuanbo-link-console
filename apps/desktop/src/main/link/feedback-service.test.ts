import { mkdtemp, readdir, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LinkFeedbackDraft } from '@tb/schema';
import { FeedbackService, feedbackRange, type FeedbackDependencies } from './feedback-service';
import type { LinkLogInput } from './run-logger';

const machineCode = `TB1-${'A'.repeat(64)}`;
const start = Date.parse('2026-10-25T12:00:00.000Z');
const draft: LinkFeedbackDraft = { category: 'lighting', description: '22:10 播放第 3 首，灯光没跟上', contact: '微信 tblink', occurredAt: '2026-10-25T11:58:00.000Z',
  includeDiagnostics: true, includeMa2: false, context: { project: { name: '周六专场' } } };
const receipt = { id: '6f1c3c62-2f7a-4d0e-9a4a-1d2b3c4d5e6f', number: 'FB-20261025-7K3Q', upload: { token: `TBF-${'B'.repeat(64)}`, expiresAt: '2026-10-25T12:30:00.000Z' }, attachmentIssue: null };
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rmdir(directory); });

type Call = { url: string; init: RequestInit | undefined };
const urlOf = (input: string | URL | Request): string => typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
function sentJson(call: Call | undefined): Record<string, unknown> {
  const body = call?.init?.body;
  if (typeof body !== 'string') throw new Error('请求正文不是 JSON 文本');
  return JSON.parse(body) as Record<string, unknown>;
}
async function setup(respond: (call: Call) => Response, packageBytes = 1024, licensed = true, readable = true) {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-feedback-')); directories.push(directory);
  const calls: Call[] = []; const logs: LinkLogInput[] = [];
  let now = start;
  const dependencies: FeedbackDependencies = {
    serverUrl: 'https://api.tuanbo-link.jinhefilm.com',
    identity: () => Promise.resolve(readable ? { machineCode, license: licensed ? 'a.b.c' : null, licensed, licenseSummary: licensed ? '已激活' : '未激活：请输入激活码', version: '0.5.3' }
      : { machineCode: null, license: null, licensed: false, licenseSummary: '读取本机授权失败：无法读取本机标识', version: '0.5.3' }),
    environment: () => ({ os: 'Windows 10.0.26100 · x64', obs: 'connected 31.1.2', ma2: 'connected 3.9.60', playback: '未在播放' }),
    writeDiagnostic: vi.fn((path: string) => writeFile(path, Buffer.alloc(packageBytes, 1))),
    temporaryDirectory: directory,
    log: entry => { logs.push(entry); return Promise.resolve(); },
    fetch: (input, init) => { const call = { url: urlOf(input), init }; calls.push(call); return Promise.resolve(respond(call)); },
    now: () => now
  };
  return { service: new FeedbackService(dependencies), calls, logs, dependencies, directory, advance: (ms: number) => { now += ms; } };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

describe('FeedbackService', () => {
  it('先提交说明，再用服务器给的凭据上传诊断包；临时文件随后删除', async () => {
    const { service, calls, logs, directory } = await setup(call => call.url.endsWith('/diagnostic') ? json({ received: true, bytes: 1024 }) : json(receipt));
    await expect(service.submit(draft)).resolves.toEqual({ outcome: 'submitted', number: 'FB-20261025-7K3Q', attachment: 'uploaded', attachmentIssue: null });
    expect(calls.map(call => [call.init?.method, new URL(call.url).pathname])).toEqual([['POST', '/v1/feedback'], ['PUT', `/v1/feedback/${receipt.id}/diagnostic`]]);
    expect(sentJson(calls[0])).toMatchObject({ product: 'tuanbo-link-console', version: '0.5.3', category: 'lighting', machineCode, license: 'a.b.c', diagnostic: { bytes: 1024 },
      environment: { obs: 'connected 31.1.2', license: '已激活' } });
    expect(new Headers(calls[1]!.init?.headers).get('Authorization')).toBe(`Bearer ${receipt.upload.token}`);
    expect(calls.every(call => call.init?.redirect === 'error' && call.init.signal instanceof AbortSignal)).toBe(true);
    expect(await readdir(directory)).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: 'info', device: '问题反馈' });
    expect(logs[0]!.message).toContain('编号 FB-20261025-7K3Q');
  });

  it('不附诊断包时只提交说明', async () => {
    const { service, calls, dependencies } = await setup(() => json({ ...receipt, upload: null }));
    await expect(service.submit({ ...draft, includeDiagnostics: false })).resolves.toMatchObject({ attachment: 'none', attachmentIssue: null });
    expect(calls).toHaveLength(1);
    expect(dependencies.writeDiagnostic).not.toHaveBeenCalled();
    expect(sentJson(calls[0])).toMatchObject({ diagnostic: null });
  });

  it('诊断包超过上限时只提交说明，并说明怎么另行发送；未激活电脑的上限更小', async () => {
    const { service, calls } = await setup(() => json({ ...receipt, upload: null }), 3 * 1024 * 1024, false);
    const result = await service.submit(draft);
    expect(result).toMatchObject({ attachment: 'refused' });
    expect(result.attachmentIssue).toContain('超过上传上限 2.0 MB');
    expect(sentJson(calls[0])).toMatchObject({ diagnostic: null, license: null });
  });

  it('读不出本机授权时照样提交，不带机器码并写明原因', async () => {
    const { service, calls, logs } = await setup(() => json({ ...receipt, upload: null }), 1024, false, false);
    await expect(service.submit({ ...draft, includeDiagnostics: false })).resolves.toMatchObject({ outcome: 'submitted' });
    expect(sentJson(calls[0])).toMatchObject({ machineCode: null, license: null, environment: { license: '读取本机授权失败：无法读取本机标识' } });
    expect(logs[0]).toMatchObject({ details: { machineCode: null, license: '读取本机授权失败：无法读取本机标识' } });
  });

  it('服务器不给上传凭据时转述原因；上传失败时说明文字已提交', async () => {
    const refused = await setup(() => json({ ...receipt, upload: null, attachmentIssue: '服务器诊断包空间已满' }));
    await expect(refused.service.submit(draft)).resolves.toMatchObject({ attachment: 'refused', attachmentIssue: '服务器诊断包空间已满' });
    const failed = await setup(call => call.url.endsWith('/diagnostic') ? json({ code: 'UPLOAD_MISMATCH', message: '诊断包大小或摘要与登记不一致' }, 400) : json(receipt));
    const result = await failed.service.submit(draft);
    expect(result.attachment).toBe('failed');
    expect(result.attachmentIssue).toContain('诊断包大小或摘要与登记不一致');
    expect(result.attachmentIssue).toContain('FB-20261025-7K3Q');
    expect(failed.logs.at(-1)).toMatchObject({ level: 'warning' });
  });

  it('同一条只提交一次，间隔一分钟，一小时最多五条', async () => {
    const { service, advance } = await setup(() => json({ ...receipt, upload: null }));
    const plain = { ...draft, includeDiagnostics: false };
    await service.submit(plain);
    await expect(service.submit(plain)).rejects.toThrow('已经提交过（编号 FB-20261025-7K3Q）');
    await expect(service.submit({ ...plain, description: '另一个现象：画面卡住' })).rejects.toThrow('秒后再提交');
    for (let index = 1; index < 5; index++) { advance(61_000); await service.submit({ ...plain, description: `第 ${index} 个现象，画面卡住` }); }
    advance(61_000);
    await expect(service.submit({ ...plain, description: '第六个现象，画面卡住' })).rejects.toThrow('一小时内最多提交 5 条');
    advance(3_600_000);
    await expect(service.submit({ ...plain, description: '第六个现象，画面卡住' })).resolves.toMatchObject({ outcome: 'submitted' });
  });

  it('服务未开通、限流、网络失败都给出可操作的提示并写日志，失败不计入次数', async () => {
    const missing = await setup(() => new Response('', { status: 404 }));
    await expect(missing.service.submit(draft)).rejects.toThrow('反馈服务尚未开通；也可以点「另存为文件」');
    expect(missing.logs.at(-1)).toMatchObject({ level: 'error', result: 'failed' });
    const disabled = await setup(() => json({ code: 'FEEDBACK_DISABLED', message: '反馈服务尚未开通' }, 404));
    await expect(disabled.service.submit(draft)).rejects.toThrow('反馈服务尚未开通；也可以点「另存为文件」');
    const refused = await setup(() => json({ code: 'INVALID_REQUEST', message: '请求字段或期限无效' }, 400));
    await expect(refused.service.submit(draft)).rejects.toThrow('请求字段或期限无效；也可以点「另存为文件」');
    const limited = await setup(() => json({ code: 'RATE_LIMITED', message: '提交过于频繁' }, 429));
    await expect(limited.service.submit(draft)).rejects.toThrow('提交过于频繁，请稍后再试');
    const offline = await setup(() => { throw new TypeError('fetch failed'); });
    await expect(offline.service.submit(draft)).rejects.toThrow('无法连接反馈服务器，请检查网络后重试');
    expect(offline.logs.at(-1)).toMatchObject({ details: { technicalError: 'fetch failed' } });
    await expect(offline.service.submit(draft)).rejects.toThrow('提交太快了');
    offline.advance(10_000);
    await expect(offline.service.submit(draft)).rejects.toThrow('无法连接反馈服务器');
    expect(await readdir(offline.directory)).toEqual([]);
  });

  it('诊断包覆盖问题发生的时间', () => {
    expect(feedbackRange('2026-10-25T00:00:00.000Z', start)).toBe(1);
    expect(feedbackRange('2026-10-20T00:00:00.000Z', start)).toBe(7);
    expect(feedbackRange('2026-10-01T00:00:00.000Z', start)).toBe(30);
  });
});
