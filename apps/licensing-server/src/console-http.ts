import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { enrollmentSchema, loginSchema, pageQuerySchema, sessionSchema } from './console-contract';
import type { ConsoleChannels, ConsoleService } from './console-service';
import type { UpdateReleases } from './update-releases';
import type { FeedbackStore } from './feedback';
import { ServiceError } from './service';

export type ConsoleHttp = { service: ConsoleService; origin: string; updates?: UpdateReleases; feedback?: FeedbackStore };
const cookieName = '__Host-tblink-console';
export async function dispatchConsole(options: ConsoleHttp, request: IncomingMessage, response: ServerResponse, requestId: string, address: string, readBody: () => Promise<unknown>, channels: ConsoleChannels): Promise<unknown> {
  const origin = new URL(options.origin);
  if (origin.protocol !== 'https:' || origin.origin !== options.origin || request.headers.host !== origin.host) throw new ServiceError(404, 'NOT_FOUND', '接口不存在');
  if (request.headers['sec-fetch-site'] === 'cross-site') throw new ServiceError(403, 'ORIGIN_REJECTED', '请求来源不受信任');
  if (request.method !== 'GET' && request.method !== 'POST') throw new ServiceError(405, 'METHOD_NOT_ALLOWED', '不支持此请求方法');
  const url = new URL(request.url ?? '/', options.origin); const path = url.pathname; const auth = options.service.auth;
  if (request.method === 'POST' && request.headers.origin !== options.origin) throw new ServiceError(403, 'ORIGIN_REJECTED', '请求来源不受信任');
  if (request.method === 'POST' && ['/console-api/login', '/console-api/enrollment-info', '/console-api/enroll'].includes(path)) {
    auth.limit(`public-auth:${address}`, 30);
    const body = await readBody();
    if (path === '/console-api/login') {
      // 按账号加来源计数：他人刷同一用户名不能锁住本人；每次猜测仍须同时命中密码和验证码。
      const input = loginSchema.parse(body); auth.limit(`account:${input.username.toLowerCase()}:${address}`);
      const result = await auth.login(input.username, input.password, input.code, requestId);
      response.setHeader('Set-Cookie', `${cookieName}=${result.token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=28800`);
      return sessionSchema.parse({ ...result.session, now: options.service.clock() });
    }
    if (path === '/console-api/enrollment-info') return auth.enrollmentInfo(z.object({ token: z.string().min(32).max(128) }).strict().parse(body).token);
    const input = enrollmentSchema.parse(body); return auth.enroll(input.token, input.password, input.code, requestId);
  }
  const token = (request.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) ?? '';
  const session = auth.session(token);
  if (request.method === 'POST' && request.headers['x-csrf-token'] !== session.csrf) throw new ServiceError(403, 'CSRF_REJECTED', '页面已失效，请重新加载');
  if (request.method === 'GET' && path === '/console-api/session') return sessionSchema.parse({ ...session, now: options.service.clock() });
  if (request.method === 'POST' && path === '/console-api/logout') {
    auth.logout(session, requestId); response.setHeader('Set-Cookie', `${cookieName}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`); return { message: '已退出' };
  }
  if (request.method === 'POST' && path === '/console-api/verify') {
    auth.limit(`verify:${session.user.id}`); const input = z.object({ code: z.string().min(6).max(100) }).strict().parse(await readBody());
    auth.verify(session, input.code, requestId); return { message: '二次验证完成，有效期五分钟' };
  }
  if (request.method === 'POST' && path === '/console-api/commands') {
    const body = await readBody();
    return options.service.execute(body, auth.session(token), requestId, channels);
  }
  if (request.method === 'GET' && path === '/console-api/overview') return options.service.overview(session);
  if (request.method === 'GET' && path === '/console-api/updates') return options.service.updates(session, channels);
  const exported = /^\/console-api\/export(?:\/(finance))?$/.exec(path);
  if (request.method === 'GET' && exported) {
    const resource = exported[1] === 'finance' ? 'finance' : 'orders';
    const csv = options.service.exportCsv(resource, pageQuerySchema.parse(Object.fromEntries(url.searchParams)), session, requestId);
    response.setHeader('Content-Type', 'text/csv; charset=utf-8'); response.setHeader('Content-Disposition', `attachment; filename="${resource}.csv"`);
    response.end(csv); return null;
  }
  const operation = /^\/console-api\/operations\/([a-f0-9-]{36})$/.exec(path);
  if (request.method === 'GET' && operation) return options.service.operation(z.string().uuid().parse(operation[1]), session);
  const diagnostic = /^\/console-api\/feedback\/([a-f0-9-]{36})\/diagnostic$/.exec(path);
  if (request.method === 'GET' && diagnostic) {
    const id = z.string().uuid().parse(diagnostic[1]);
    // Permission and the report first; the file only after that, and the download is audited once it is known to exist.
    const report = options.service.feedbackAttachment(id, session);
    const bytes = options.feedback ? await options.feedback.attachmentSize(id) : null;
    if (!options.feedback || bytes === null) throw new ServiceError(404, 'ATTACHMENT_MISSING', '诊断包文件不在服务器上，请让客户用「另存为文件」重新发送');
    options.service.auth.audit(session.user.id, 'feedback.diagnostic-downloaded', id, report.number, 'success', requestId);
    response.setHeader('Content-Type', 'application/gzip'); response.setHeader('Content-Length', String(bytes));
    response.setHeader('Content-Disposition', `attachment; filename="${report.number}.tbdiag.gz"`);
    await pipeline(createReadStream(options.feedback.attachmentPath(id)), response);
    return null;
  }
  const detail = /^\/console-api\/(orders|licenses|tickets|feedback)\/([a-f0-9-]{36})$/.exec(path);
  if (request.method === 'GET' && detail) return options.service.detail(detail[1]!, z.string().uuid().parse(detail[2]), session);
  const list = /^\/console-api\/(orders|licenses|tickets|feedback|finance|audit|users|exceptions)$/.exec(path);
  if (request.method === 'GET' && list) return options.service.list(list[1]!, pageQuerySchema.parse(Object.fromEntries(url.searchParams)), session);
  throw new ServiceError(404, 'NOT_FOUND', '接口不存在');
}
