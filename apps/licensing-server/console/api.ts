import { z } from 'zod';

/** 服务端明确拒绝的请求（有错误码）。连不上、超时、回应读不懂都不是它：那些情况下写操作有没有生效是不知道的。 */
export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly requestId: string) { super(message); }
}
const expiredListeners = new Set<() => void>();
/** 任何请求发现登录已过期（SESSION_EXPIRED）时通知一次：后台外壳据此回到登录页，各个页面和对话框不用自己处理。返回取消登记的函数。 */
export function onSessionExpired(listener: () => void): () => void { expiredListeners.add(listener); return () => { expiredListeners.delete(listener); }; }
export async function api<T>(path: string, schema: z.ZodType<T>, body?: unknown, csrf?: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/console-api/${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000), headers: body === undefined ? {} : { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch (cause) { throw new Error(cause instanceof DOMException && cause.name === 'TimeoutError' ? '服务器 15 秒内没有回应' : '连不上服务器，请检查网络', { cause }); }
  let value: unknown;
  // 服务没起来时 Nginx 回的是 HTML 的 502、503，不是 JSON。
  try { value = await response.json(); } catch (cause) { throw new Error(`服务器没有正常回应（HTTP ${response.status}），请稍后再试`, { cause }); }
  if (!response.ok) {
    const error = z.object({ code: z.string(), message: z.string(), requestId: z.string().optional() }).parse(value);
    if (error.code === 'SESSION_EXPIRED') for (const listener of expiredListeners) listener();
    throw new ApiError(error.code, error.message, error.requestId ?? '');
  }
  return schema.parse(value);
}
export const messageSchema = z.object({ message: z.string() });
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.message}${error.requestId ? `（请求 ${error.requestId}）` : ''}`;
  return error instanceof Error ? `请求没有完成：${error.message}` : '请求失败，请重试';
}
