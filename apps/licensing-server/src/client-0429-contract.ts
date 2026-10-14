import { createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';

/**
 * Frozen copy of what the released 0.4.29 desktop client accepts from POST /v1/activate
 * (packages/schema/src/license.ts and license-service.ts at tag v0.4.29). Installed clients
 * cannot be patched, so this file must never follow later schema changes.
 */
const machineCodeSchema = z.string().regex(/^TB1-[A-F0-9]{64}$/);
const claimsSchema = z.object({
  version: z.literal(1), product: z.literal('tuanbo-link-console'),
  licenseId: z.string().uuid(), customer: z.string().trim().min(1).max(160),
  machineCode: machineCodeSchema,
  kind: z.enum(['perpetual', 'subscription', 'trial']),
  issuedAt: z.string().datetime(), useUntil: z.string().datetime().nullable(),
  updatesUntil: z.string().datetime(),
  online: z.object({ leaseUntil: z.string().datetime(), customerType: z.enum(['personal', 'company']) }).strict().optional()
}).strict().superRefine((value, context) => {
  if ((value.kind === 'perpetual') !== (value.useUntil === null)) context.addIssue({ code: 'custom', message: '买断授权不设使用期限；订阅和试用必须有期限' });
  if (value.useUntil && Date.parse(value.useUntil) <= Date.parse(value.issuedAt)) context.addIssue({ code: 'custom', message: '使用期限必须晚于签发时间' });
  if (!value.online && Date.parse(value.updatesUntil) < Date.parse(value.issuedAt)) context.addIssue({ code: 'custom', message: '升级期限不能早于签发时间' });
  if (value.online && (Date.parse(value.online.leaseUntil) <= Date.parse(value.issuedAt) || value.useUntil && Date.parse(value.online.leaseUntil) > Date.parse(value.useUntil))) context.addIssue({ code: 'custom', message: '离线凭证期限无效' });
});
const responseSchema = z.object({ license: z.string().min(1).max(16384) }).strict();
const headerSchema = z.object({ alg: z.literal('EdDSA'), typ: z.literal('JWT'), kid: z.string().min(1).max(80) }).strict();
const tokenSchema = z.string().max(16384).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

/** Parses an activation response body exactly as the 0.4.29 client does and returns its claims. */
export function acceptByReleasedClient(body: string, machineCode: string, keys: Readonly<Record<string, string>>, now: number): z.infer<typeof claimsSchema> {
  if (Buffer.byteLength(body) > 20000) throw new Error('授权服务器返回超过大小限制');
  const token = tokenSchema.parse(responseSchema.parse(JSON.parse(body)).license);
  const parts = token.split('.');
  const header = headerSchema.parse(JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')));
  const pem = Object.hasOwn(keys, header.kid) ? keys[header.kid] : undefined;
  if (!pem) throw new Error('授权签名密钥不受信任');
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2]!, 'base64url'))) throw new Error('授权签名无效');
  const claims = claimsSchema.parse(JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')));
  if (claims.machineCode !== machineCode) throw new Error('这份授权属于另一台主机');
  if (Date.parse(claims.issuedAt) > now + 300_000) throw new Error('授权签发时间晚于本机时间');
  return claims;
}

/** HTTP statuses the 0.4.29 client turns into specific guidance; anything else is a generic failure. */
export const releasedClientStatuses = { rejected: 403, boundElsewhere: 409, throttled: 429 } as const;
