import { createPublicKey, verify } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { activationCodeSchema, licenseActivationResponseSchema, licenseClaimsSchema, licenseMachineCodeSchema, type LicenseClaims, type LicenseStatus } from '@tb/schema';
import { writeFileAtomically } from './atomic-file';
import type { SecureProfileStore } from './secure-profile-store';

type OnlineOptions = {
  serverUrl: string;
  enforcement: LicenseStatus['enforcement'];
  credentials: Pick<SecureProfileStore, 'hasCredential' | 'loadCredential' | 'saveCredential'>;
  fetch?: typeof fetch;
};
const CODE_CREDENTIAL = 'license.activation.code';
const CLOCK_CREDENTIAL = 'license.clock';

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

/** Network failure, timeout or a transient server answer: a valid local lease may still start the app. */
class LicenseServerUnavailable extends Error {}

/** Codes the licensing server returns with 403/409, mapped to the action the operator should take. */
const rejectionMessages: Readonly<Record<string, string>> = {
  INVALID_CODE: '激活码无效，请核对后重新输入；仍有问题请联系发行方',
  REVOKED: '本机授权已被撤销，请联系发行方',
  EXPIRED: '授权使用期限已结束，请在「本机授权」中续费；工程文件保持不变',
  MACHINE_BOUND: '激活码已绑定其他电脑；更换电脑或重装系统需联系发行方办理换机'
};

async function rejectionCode(response: Response): Promise<string | undefined> {
  const text = (await response.text()).slice(0, 2000);
  let body: unknown;
  try { body = JSON.parse(text); } catch (error) { if (error instanceof SyntaxError) return undefined; throw error; }
  const parsed = z.object({ code: z.string().max(64) }).safeParse(body);
  return parsed.success && Object.hasOwn(rejectionMessages, parsed.data.code) ? parsed.data.code : undefined;
}

export class LicenseService {
  private readonly path: string;
  private startupVerification: Promise<void> | undefined;
  private sessionLicenseId: string | undefined;
  private offlineGrace = false;
  private verificationFailure = '本次启动尚未通过联网验证，请输入激活码或手动联网验证';
  constructor(directory: string, private readonly machineCode: string, private readonly keys: Readonly<Record<string, string>>, private readonly now: () => number = Date.now, private readonly online?: OnlineOptions) {
    licenseMachineCodeSchema.parse(machineCode);
    this.path = join(directory, 'licensing', 'license.jwt');
  }
  private result(claims: LicenseClaims | null, state: LicenseStatus['state'], message: string): LicenseStatus {
    return { machineCode: this.machineCode, state, claims, message, enforcement: this.online?.enforcement ?? 'required', onlineAvailable: Boolean(this.online?.serverUrl && Object.keys(this.keys).length) };
  }
  private describe(token: string): LicenseStatus {
    const claims = verifyLicense(token, this.machineCode, this.keys, this.now());
    if (claims.kind === 'trial') return this.result(claims, 'invalid', '本产品仅支持付费授权，不接受试用许可');
    if (claims.useUntil && this.now() >= Date.parse(claims.useUntil)) return this.result(claims, 'expired', '使用期限已结束；工程文件保持不变');
    if (claims.online && this.now() >= Date.parse(claims.online.leaseUntil)) return this.result(claims, 'renewal-required', '离线凭证已到期，请联网验证授权；这不表示买断使用权到期');
    return this.result(claims, 'active', claims.kind === 'perpetual' ? '本机永久授权有效；升级服务期限单独计算' : '本机授权有效');
  }
  async status(): Promise<LicenseStatus> {
    if (!Object.keys(this.keys).length) return this.result(null, 'unconfigured', '授权签发尚未启用，可先导出本机授权申请');
    // Share the one startup request across concurrent IPC calls; failures require an explicit retry.
    if (this.online && !this.startupVerification) {
      this.startupVerification = this.refreshOnline().then(() => undefined, (error: unknown) => {
        this.verificationFailure = error instanceof Error ? error.message : String(error);
        this.offlineGrace = error instanceof LicenseServerUnavailable;
      });
    }
    await this.startupVerification;
    try {
      if ((await stat(this.path)).size > 16384) throw new Error('授权文件超过大小限制');
      const status = this.describe((await readFile(this.path, 'utf8')).trim());
      if (status.claims?.online) await this.checkClock();
      if (this.online && status.state === 'active' && status.claims?.licenseId !== this.sessionLicenseId) {
        // Only an unreachable server falls back to the signed, machine-bound lease; explicit rejections still block.
        if (this.offlineGrace && status.claims?.online) {
          const until = new Date(status.claims.online.leaseUntil).toLocaleString('zh-CN', { hour12: false });
          return this.result(status.claims, 'active', `授权服务器暂时无法连接，已用本机授权离线启动；请在 ${until} 前联网验证`);
        }
        return this.result(status.claims, 'renewal-required', this.verificationFailure);
      }
      return status;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return this.result(null, 'inactive', '此主机尚未激活');
      return this.result(null, 'invalid', `授权读取或校验失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async activate(token: string): Promise<LicenseStatus> {
    if (this.online) throw new Error('当前版本每次启动需联网验证，请使用激活码；不支持导入离线授权绕过验证');
    const normalized = token.trim();
    const result = this.describe(normalized);
    if (result.state !== 'active') throw new Error(`${result.message}；未替换本机现有授权`);
    await writeFileAtomically(this.path, normalized);
    return result;
  }
  private async clockHighWater(): Promise<number> {
    if (!this.online) throw new Error('在线授权缺少安全存储配置');
    const storage = this.online.credentials;
    return await storage.hasCredential(CLOCK_CREDENTIAL) ? z.number().finite().parse(JSON.parse(await storage.loadCredential(CLOCK_CREDENTIAL))) : 0;
  }
  private async checkClock(): Promise<void> {
    if (!this.online) throw new Error('在线授权缺少安全存储配置');
    const last = await this.clockHighWater();
    if (this.now() + 300_000 < last) throw new Error('检测到系统时间回拨，请校正系统日期并联网验证');
    await this.online.credentials.saveCredential(CLOCK_CREDENTIAL, JSON.stringify(Math.max(last, this.now())));
  }
  async activateCode(input: string): Promise<LicenseStatus> {
    this.startupVerification ??= Promise.resolve();
    this.sessionLicenseId = undefined;
    try {
      const status = await this.requestActivation(input);
      this.sessionLicenseId = status.claims?.licenseId;
      return status;
    } catch (error) {
      this.verificationFailure = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
  private async requestActivation(input: string): Promise<LicenseStatus> {
    const code = activationCodeSchema.parse(input);
    const online = this.online;
    if (!online?.serverUrl || !Object.keys(this.keys).length) throw new Error('发行方尚未配置在线授权服务');
    const url = new URL(online.serverUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('授权服务器必须是固定的 HTTPS 域名');
    // Refuse activation before allocating a seat if encrypted storage is unavailable. The rollback check waits for
    // the server: a clock that was once fast must not block the online verification that corrects it.
    await online.credentials.saveCredential(CLOCK_CREDENTIAL, JSON.stringify(await this.clockHighWater()));
    let response: Response;
    try {
      response = await (online.fetch ?? fetch)(new URL('/v1/activate', url), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
        body: JSON.stringify({ product: 'tuanbo-link-console', code, machineCode: this.machineCode }), signal: AbortSignal.timeout(10000)
      });
    } catch { throw new LicenseServerUnavailable('无法连接授权服务器，请检查网络后手动重试；现有授权保持不变'); }
    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel();
        throw new LicenseServerUnavailable(response.status === 429 ? '激活请求过于频繁，请稍后手动重试' : `授权服务器暂时不可用（${response.status}），现有授权保持不变`);
      }
      const code = await rejectionCode(response);
      const messages: Record<number, string> = { 403: '激活码无效、已到期或已撤销，请联系发行方', 409: '激活码已绑定其他机器，请联系发行方办理换机' };
      throw new Error(code ? rejectionMessages[code] : messages[response.status] ?? `授权服务器请求失败（${response.status}），现有授权保持不变`);
    }
    if (!response.body) throw new Error('授权服务器返回为空');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.length;
        if (size > 20000) throw new Error('授权服务器返回超过大小限制');
        chunks.push(part.value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    const result = licenseActivationResponseSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const status = this.describe(result.license);
    if (!status.claims?.online || status.state !== 'active') throw new Error('服务器未返回有效的在线授权');
    await online.credentials.saveCredential(CODE_CREDENTIAL, code);
    await online.credentials.saveCredential(CLOCK_CREDENTIAL, JSON.stringify(Date.parse(status.claims.issuedAt)));
    await writeFileAtomically(this.path, result.license);
    return status;
  }
  async refreshOnline(): Promise<LicenseStatus> {
    if (!this.online || !await this.online.credentials.hasCredential(CODE_CREDENTIAL)) throw new Error('本机尚未保存激活码，请先输入激活码');
    try {
      return await this.activateCode(await this.online.credentials.loadCredential(CODE_CREDENTIAL));
    } catch (error) {
      // The server rejected the stored code itself, so the local lease no longer covers a later start.
      if (!(error instanceof LicenseServerUnavailable)) this.offlineGrace = false;
      throw error;
    }
  }
  async renewalAuthorization(licenseId: string) {
    const status = await this.status();
    if (!this.online || !status.claims?.online || status.claims.kind !== 'subscription' || status.claims.licenseId !== z.string().uuid().parse(licenseId)) throw new Error('只能续费本机已保存的订阅授权，请核对授权设置');
    const code = activationCodeSchema.parse(await this.online.credentials.loadCredential(CODE_CREDENTIAL));
    return { product: 'tuanbo-link-console' as const, code, machineCode: this.machineCode };
  }
}
