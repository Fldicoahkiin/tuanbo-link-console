import { expect, it } from 'vitest';
import type { LicenseStatus } from '@tb/schema';
import { licenseReminders } from './license-reminders';

const now = Date.parse('2026-10-14T00:00:00Z');
const status = (useUntil: string | null, extra: Partial<LicenseStatus> = {}): LicenseStatus => ({
  machineCode: `TB1-${'A'.repeat(64)}`, state: 'active', message: '本机授权有效', enforcement: 'required', onlineAvailable: true,
  claims: { version: 1, product: 'tuanbo-link-console', licenseId: '9d53530a-6712-423e-985e-e69beb9ec1c6', customer: '测试客户', machineCode: `TB1-${'A'.repeat(64)}`,
    kind: useUntil ? 'subscription' : 'perpetual', issuedAt: '2026-10-01T00:00:00Z', useUntil, updatesUntil: '2026-11-01T00:00:00Z' },
  ...extra
});

it('到期前三天内提醒续费，更早或永久授权不提醒', () => {
  expect(licenseReminders(status('2026-10-16T12:00:00Z'), now)).toEqual([expect.stringContaining('续费')]);
  expect(licenseReminders(status('2026-10-20T00:00:00Z'), now)).toEqual([]);
  expect(licenseReminders(status(null), now)).toEqual([]);
});

it('离线启动时提示联网截止时间；未授权状态不显示工作区提醒', () => {
  expect(licenseReminders(status('2026-11-01T00:00:00Z', { offlineUntil: '2026-10-15T00:00:00Z' }), now)).toEqual([expect.stringContaining('离线启动')]);
  expect(licenseReminders(status('2026-10-15T00:00:00Z', { state: 'renewal-required' }), now)).toEqual([]);
});
