import { z } from 'zod';

/** OBS's native ws endpoint defaults to 4455, not the WebSocket URL default 80.
 * Explicit ports and secure reverse-proxy URLs keep their original meaning.
 */
export const obsWebSocketUrlSchema = z.string().trim().transform((input, context) => {
  const address = /^\d+$/.test(input) ? `ws://127.0.0.1:${input}` : input.includes('://') ? input : `ws://${input}`;
  let url: URL;
  try { url = new URL(address); }
  catch {
    context.addIssue({ code: 'custom', message: 'OBS 地址无效，请填写主机和端口，例如 127.0.0.1:4455' });
    return z.NEVER;
  }
  if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) {
    context.addIssue({ code: 'custom', message: 'OBS 地址请使用 ws:// 或 wss://；密码须填写在下方密码框' });
    return z.NEVER;
  }
  const authority = address.slice(address.indexOf('://') + 3).split(/[/?#]/)[0] ?? '';
  const explicitPort = /:(\d+)$/.exec(authority)?.[1];
  if (explicitPort && Number(explicitPort) < 1) {
    context.addIssue({ code: 'custom', message: 'OBS 端口须为 1 至 65535' });
    return z.NEVER;
  }
  if (url.protocol === 'ws:' && !explicitPort) url.port = '4455';
  // URL removes explicit :80 / :443; retain them so reopening does not reinterpret :80.
  const host = explicitPort && !url.port ? `${url.hostname}:${explicitPort}` : url.host;
  return `${url.protocol}//${host}${url.pathname === '/' && !url.search ? '' : url.pathname}${url.search}`;
});

export const localObsConnectionResultSchema = z.object({
  version: z.literal(1), address: obsWebSocketUrlSchema, password: z.string().max(4096),
  snapshot: z.object({ status: z.enum(['disconnected', 'connecting', 'connected', 'reconnecting', 'error']),
    obsVersion: z.string().nullable(), webSocketVersion: z.string().nullable(), error: z.string().nullable() }).strict()
}).strict();
export type LocalObsConnectionResult = z.infer<typeof localObsConnectionResultSchema>;
