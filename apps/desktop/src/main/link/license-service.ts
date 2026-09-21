import { createPublicKey, verify } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { licenseClaimsSchema, licenseMachineCodeSchema, type LicenseClaims, type LicenseStatus } from '@tb/schema';
import { writeFileAtomically } from './atomic-file';

const headerSchema = z.object({ alg: z.literal('EdDSA'), typ: z.literal('JWT'), kid: z.string().min(1).max(80) }).strict();
const tokenSchema = z.string().max(16384).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

/** Compact JWS (EdDSA). Only public keys are distributed with the desktop app. */
export function verifyLicense(token: string, machineCode: string, keys: Readonly<Record<string, string>>, now: number): LicenseClaims {
  const parsed = tokenSchema.safeParse(token);
  if (!parsed.success) throw new Error('授权文件格式无效，请导入发行方提供的 .tbllicense 文件');
  const parts = parsed.data.split('.');
  const header = headerSchema.parse(JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')));
  const pem = Object.hasOwn(keys, header.kid) ? keys[header.kid] : undefined;
  if (!pem) throw new Error('授权签名密钥不受信任，请使用发行方提供的正式授权文件');
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2]!, 'base64url'))) throw new Error('授权签名无效，文件可能已损坏或被修改');
  const claims = licenseClaimsSchema.parse(JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')));
  if (claims.machineCode !== machineCode) throw new Error('这份授权属于另一台主机，请为本机申请授权或办理换机');
  if (Date.parse(claims.issuedAt) > now + 300_000) throw new Error('授权签发时间晚于本机时间，请检查系统日期');
  return claims;
}

export class LicenseService {
  private readonly path: string;
  constructor(directory: string, private readonly machineCode: string, private readonly keys: Readonly<Record<string, string>>, private readonly now: () => number = Date.now) {
    licenseMachineCodeSchema.parse(machineCode);
    this.path = join(directory, 'licensing', 'license.jwt');
  }
  private result(claims: LicenseClaims | null, state: LicenseStatus['state'], message: string): LicenseStatus {
    return { machineCode: this.machineCode, state, claims, message, enforcement: 'preview' };
  }
  private describe(token: string): LicenseStatus {
    const claims = verifyLicense(token, this.machineCode, this.keys, this.now());
    if (claims.useUntil && this.now() >= Date.parse(claims.useUntil)) return this.result(claims, 'expired', '使用期限已结束；工程文件保持不变');
    return this.result(claims, 'active', claims.kind === 'perpetual' ? '本机永久授权有效；升级服务期限单独计算' : '本机授权有效');
  }
  async status(): Promise<LicenseStatus> {
    if (!Object.keys(this.keys).length) return this.result(null, 'unconfigured', '授权签发尚未启用，可先导出本机授权申请');
    try {
      if ((await stat(this.path)).size > 16384) throw new Error('授权文件超过大小限制');
      return this.describe((await readFile(this.path, 'utf8')).trim());
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return this.result(null, 'inactive', '此主机尚未激活');
      return this.result(null, 'invalid', `授权读取或校验失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async activate(token: string): Promise<LicenseStatus> {
    const normalized = token.trim();
    const result = this.describe(normalized);
    if (result.state !== 'active') throw new Error('这份授权已到期，未替换本机现有授权');
    await writeFileAtomically(this.path, normalized);
    return result;
  }
}
