import type { LicenseStatus } from '@tb/schema';

export const licenseStateLabel: Record<LicenseStatus['state'], string> = {
  unconfigured: '尚未启用', inactive: '未激活', active: '已激活', expired: '已到期', invalid: '校验失败', 'renewal-required': '需要联网验证'
};

/**
 * What the run log and a diagnostic package may say about this machine's license: enough to tell why it is
 * locked or which license a feedback came from. The machine code identifies the computer to support; the
 * customer name and the activation code stay out.
 */
export function licenseLogDetails(status: LicenseStatus): Record<string, string | boolean | null> {
  const claims = status.claims;
  return {
    state: status.state,
    machineCode: status.machineCode,
    onlineAvailable: status.onlineAvailable,
    offlineUntil: status.offlineUntil ?? null,
    licenseId: claims?.licenseId ?? null,
    kind: claims?.kind ?? null,
    issuedAt: claims?.issuedAt ?? null,
    useUntil: claims?.useUntil ?? null,
    updatesUntil: claims?.updatesUntil ?? null,
    leaseUntil: claims?.online?.leaseUntil ?? null
  };
}
