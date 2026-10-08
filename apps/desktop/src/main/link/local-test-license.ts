import { licenseStatusSchema, type LicenseStatus } from '@tb/schema';

/** Explicit access for the unpackaged development app on the publisher's PC. */
export function localTestAccessEnabled(packaged: boolean, value: string | undefined, markerExists = false): boolean {
  return !packaged && value !== '0' && (value === '1' || markerExists);
}

export function localTestLicenseStatus(machineCode: string): LicenseStatus {
  return licenseStatusSchema.parse({
    machineCode,
    state: 'active',
    message: '本机开发测试通道已启用；此状态不是正式激活授权',
    enforcement: 'required',
    onlineAvailable: false,
    claims: {
      version: 1,
      product: 'tuanbo-link-console',
      licenseId: '00000000-0000-4000-8000-000000000001',
      customer: '本机开发测试',
      machineCode,
      kind: 'perpetual',
      issuedAt: '2026-01-01T00:00:00.000Z',
      useUntil: null,
      updatesUntil: '2099-12-31T23:59:59.000Z'
    }
  });
}
