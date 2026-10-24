// A packaged app always asks for activation. The development entry (TBLINK_LOCAL_TEST_ACCESS, .local-test-access)
// must not open it, whatever the environment or the files left beside it. Run on Windows against win-unpacked.
import assert from 'node:assert/strict';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPackagedDesktop } from '../tools/obs/beauty/verify-packaged-desktop.mjs';

if (process.argv.length !== 4) throw new Error('用法：node scripts/verify-packaged-activation.mjs <win-unpacked\\团播联动台.exe> <输出目录>');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium, expect } = createRequire(join(root, 'apps/desktop/package.json'))('@playwright/test');
const executable = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
await mkdir(output, { recursive: true });
// Beside the executable and in resources: app.getAppPath() is inside app.asar, so a stray marker can only sit here.
const markers = [join(dirname(executable), '.local-test-access'), join(dirname(executable), 'resources', '.local-test-access')];
for (const marker of markers) await writeFile(marker, '', { flag: 'wx' });
process.env.TBLINK_LOCAL_TEST_ACCESS = '1';
try {
  const application = await launchPackagedDesktop({ executable, directory: output, chromium });
  try {
    const page = await application.firstWindow();
    await expect(page.getByLabel('激活码', { exact: true })).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole('navigation', { name: '主要工作区' })).toHaveCount(0);
    const result = await page.evaluate(async () => {
      const api = globalThis.window.tbLink;
      const license = await api.getLicenseStatus();
      const build = await api.getAppInfo();
      const output = await api.requireOutputLicense().then(() => 'allowed', (error) => String(error instanceof Error ? error.message : error));
      return { state: license.state, licenseId: license.claims?.licenseId ?? null, message: license.message, channel: build.channel, version: build.version, output };
    });
    assert.notEqual(result.state, 'active', '打包版不能免激活');
    assert.equal(result.licenseId, null);
    assert.equal(result.channel, 'release');
    assert.notEqual(result.output, 'allowed', '未激活时不能放行设备输出');
    await page.screenshot({ path: join(output, 'activation-gate.png') });
    await writeFile(join(output, 'acceptance.json'), JSON.stringify({ executable, checkedAt: new Date().toISOString(), markers, environment: { TBLINK_LOCAL_TEST_ACCESS: '1' }, result }, null, 2));
    console.log(`打包版 ${result.version} 在 TBLINK_LOCAL_TEST_ACCESS=1 和 .local-test-access 同时存在时仍停在激活页（授权状态 ${result.state}），设备输出被拒绝。`);
  } finally { await application.close(); }
} finally {
  for (const marker of markers) await unlink(marker);
}
