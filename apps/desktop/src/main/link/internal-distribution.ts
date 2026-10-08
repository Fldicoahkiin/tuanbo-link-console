import { z } from 'zod';
import { licenseStatusSchema, type LicenseStatus } from '@tb/schema';
import { verifyLicense } from './license-service';

declare const __TBLINK_INTERNAL_DISTRIBUTION__: unknown;
const distributionSchema = z.discriminatedUnion('channel', [
  z.object({ channel: z.literal('internal'), publicKeys: z.record(z.string(), z.string()), token: z.string() }).strict(),
  z.object({ channel: z.literal('portable-test'), version: z.literal(1) }).strict()
]);
export const internalDistribution = typeof __TBLINK_INTERNAL_DISTRIBUTION__ === 'undefined' || __TBLINK_INTERNAL_DISTRIBUTION__ === null ? null : distributionSchema.parse(__TBLINK_INTERNAL_DISTRIBUTION__);

/** Build-time channel only. Runtime environment flags cannot enable a packaged grant. */
export function internalDistributionStatus(input: unknown, machineCode: string, now = Date.now()): LicenseStatus {
  try {
    const distribution = distributionSchema.parse(input);
    if (distribution.channel === 'portable-test') {
      return licenseStatusSchema.parse({
        machineCode, state: 'active', enforcement: 'required', onlineAvailable: false,
        message: '免激活功能测试版，可在测试主机直接使用；不代表完整稳定性验收通过',
        claims: {
          version: 1, product: 'tuanbo-link-console',
          licenseId: '00000000-0000-4000-8000-000000000002',
          customer: '跨主机功能测试', machineCode, kind: 'perpetual',
          issuedAt: '2026-10-06T00:00:00.000Z', useUntil: null,
          updatesUntil: '2099-12-31T23:59:59.000Z'
        }
      });
    }
    const claims = verifyLicense(distribution.token, machineCode, distribution.publicKeys, now);
    if (claims.kind !== 'subscription' || !claims.useUntil || Date.parse(claims.useUntil) - Date.parse(claims.issuedAt) > 31 * 86400000) throw new Error('内测许可必须绑定主机且有效期不超过 31 天');
    const expired = now >= Date.parse(claims.useUntil);
    return licenseStatusSchema.parse({ machineCode, claims, state: expired ? 'expired' : 'active', enforcement: 'required', onlineAvailable: false, message: expired ? '本机内测许可已到期；工程文件保留' : `本机签名内测许可有效至 ${claims.useUntil}；内测渠道，不代表现场验收完成` });
  } catch (error) {
    return licenseStatusSchema.parse({ machineCode, claims: null, state: 'invalid', enforcement: 'required', onlineAvailable: false, message: `内测许可校验失败：${error instanceof Error ? error.message : String(error)}` });
  }
}
