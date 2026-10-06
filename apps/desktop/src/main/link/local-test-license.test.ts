import { expect, it } from 'vitest';
import { licenseStatusSchema } from '@tb/schema';
import { LicenseAccess } from './license-access';
import { localTestAccessEnabled, localTestLicenseStatus } from './local-test-license';

it('本机测试通道仅在明确开启的未打包开发运行中生效', () => {
  expect(localTestAccessEnabled(false, '1')).toBe(true);
  expect(localTestAccessEnabled(false, undefined)).toBe(false);
  expect(localTestAccessEnabled(true, '1')).toBe(false);
});

it('本机测试状态允许工作区与播放授权，并保留机器绑定', async () => {
  const machineCode = `TB1-${'A'.repeat(64)}`;
  const status = licenseStatusSchema.parse(localTestLicenseStatus(machineCode));
  expect(status.claims?.machineCode).toBe(machineCode);
  expect(status.message).toContain('不是正式激活授权');
  const access = new LicenseAccess(() => Promise.resolve(status));
  await expect(access.authorize('link:open-project', undefined)).resolves.toBeUndefined();
  await expect(access.setActive(true)).resolves.toBeUndefined();
});
