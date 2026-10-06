import { z } from 'zod';

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly requestId: string) { super(message); }
}
export async function api<T>(path: string, schema: z.ZodType<T>, body?: unknown, csrf?: string): Promise<T> {
  const response = await fetch(`/console-api/${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000), headers: body === undefined ? {} : { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value: unknown = await response.json();
  if (!response.ok) {
    const error = z.object({ code: z.string(), message: z.string(), requestId: z.string().optional() }).parse(value);
    throw new ApiError(error.code, error.message, error.requestId ?? '');
  }
  return schema.parse(value);
}
export const messageSchema = z.object({ message: z.string() });
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.message}${error.requestId ? `（请求 ${error.requestId}）` : ''}`;
  return error instanceof Error ? `请求未完成：${error.message}。写操作请先查询原操作结果。` : '请求失败，请手动重试';
}
