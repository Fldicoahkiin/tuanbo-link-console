import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { enrollmentSchema, loginSchema, pageQuerySchema, sessionSchema } from './console-contract';
import type { ConsoleChannels, ConsoleService } from './console-service';
import { ServiceError } from './service';

export type ConsoleHttp = { service: ConsoleService; origin: string };
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
      const input = loginSchema.parse(body); auth.limit(`account:${input.username.toLowerCase()}`);
      const result = await auth.login(input.username, input.password, input.code, requestId);
      response.setHeader('Set-Cookie', `${cookieName}=${result.token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=28800`);
      return sessionSchema.parse(result.session);
    }
    if (path === '/console-api/enrollment-info') return auth.enrollmentInfo(z.object({ token: z.string().min(32).max(128) }).strict().parse(body).token);
    const input = enrollmentSchema.parse(body); return auth.enroll(input.token, input.password, input.code, requestId);
  }
  const token = (request.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) ?? '';
  const session = auth.session(token);
  if (request.method === 'POST' && request.headers['x-csrf-token'] !== session.csrf) throw new ServiceError(403, 'CSRF_REJECTED', '页面已失效，请重新加载');
  if (request.method === 'GET' && path === '/console-api/session') return sessionSchema.parse(session);
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
  if (request.method === 'GET' && path === '/console-api/overview') return options.service.overview();
  if (request.method === 'GET' && path === '/console-api/export') {
    const csv = options.service.exportOrders(pageQuerySchema.parse(Object.fromEntries(url.searchParams)), session, requestId);
    response.setHeader('Content-Type', 'text/csv; charset=utf-8'); response.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
    response.end(csv); return null;
  }
  const operation = /^\/console-api\/operations\/([a-f0-9-]{36})$/.exec(path);
  if (request.method === 'GET' && operation) return options.service.operation(z.string().uuid().parse(operation[1]), session);
  const detail = /^\/console-api\/(orders|licenses|tickets)\/([a-f0-9-]{36})$/.exec(path);
  if (request.method === 'GET' && detail) return options.service.detail(detail[1]!, z.string().uuid().parse(detail[2]), session);
  const list = /^\/console-api\/(orders|licenses|tickets|finance|audit|users|exceptions)$/.exec(path);
  if (request.method === 'GET' && list) return options.service.list(list[1]!, pageQuerySchema.parse(Object.fromEntries(url.searchParams)), session);
  throw new ServiceError(404, 'NOT_FOUND', '接口不存在');
}
