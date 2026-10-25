import { describe, expect, it } from 'vitest';
import { licenseLogDetails } from './license-log';

describe('licenseLogDetails', () => {
  it('写入授权编号、期限和机器码，不写客户名称', () => {
    const details = licenseLogDetails({
      machineCode: 'TB1-0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF', state: 'active', message: '本机授权有效', enforcement: 'required', onlineAvailable: true,
      claims: { version: 1, product: 'tuanbo-link-console', licenseId: '6f1c3c62-2f7a-4d0e-9a4a-1d2b3c4d5e6f', customer: '某某直播间', machineCode: 'TB1-0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF',
        kind: 'subscription', issuedAt: '2026-10-01T00:00:00.000Z', useUntil: '2027-10-01T00:00:00.000Z', updatesUntil: '2027-10-01T00:00:00.000Z',
        online: { leaseUntil: '2026-10-03T00:00:00.000Z', customerType: 'company' } }
    });
    expect(details).toEqual({ state: 'active', machineCode: 'TB1-0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF', onlineAvailable: true, offlineUntil: null,
      licenseId: '6f1c3c62-2f7a-4d0e-9a4a-1d2b3c4d5e6f', kind: 'subscription', issuedAt: '2026-10-01T00:00:00.000Z', useUntil: '2027-10-01T00:00:00.000Z',
      updatesUntil: '2027-10-01T00:00:00.000Z', leaseUntil: '2026-10-03T00:00:00.000Z' });
    expect(JSON.stringify(details)).not.toContain('某某直播间');
  });
});
