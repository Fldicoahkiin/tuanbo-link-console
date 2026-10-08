import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPackagedDesktop } from '../tools/obs/beauty/verify-packaged-desktop.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireDesktop = createRequire(join(root, 'apps/desktop/package.json'));
const { chromium, expect } = requireDesktop('@playwright/test');
const executable = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
await mkdir(output, { recursive: true });
const results = [];
for (const credential of ['missing', 'tampered', 'restart']) {
  const directory = join(output, credential === 'restart' ? 'missing' : credential);
  await mkdir(directory, { recursive: true });
  const fakeLicense = join(directory, 'desktop-profile/licensing/license.jwt');
  if (credential === 'tampered') {
    await mkdir(dirname(fakeLicense), { recursive: true });
    await writeFile(fakeLicense, 'invalid-test-credential');
  }
  const application = await launchPackagedDesktop({ executable, directory, chromium });
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('navigation', { name: '主要工作区' })).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole('heading', { name: '激活团播联动台', exact: true })).toHaveCount(0);
    const result = await page.evaluate(async () => {
      const api = globalThis.window.tbLink;
      const license = await api.getLicenseStatus();
      await api.requireOutputLicense();
      const project = await api.createProject('免激活安装包验收');
      const devices = await api.getNativePlaybackDevices();
      const update = await api.checkForUpdates();
      const logs = await api.queryLogs();
      return { state: license.state, message: license.message, kind: license.claims?.kind,
        machineBoundToCurrentHost: license.claims?.machineCode === license.machineCode,
        projectCreated: Boolean(project), devices, updateFeedConfigured: update.feedConfigured,
        logsReadable: Array.isArray(logs) };
    });
    assert.equal(result.state, 'active');
    assert.equal(result.kind, 'perpetual');
    assert.equal(result.machineBoundToCurrentHost, true);
    assert.equal(result.projectCreated, true);
    assert.equal(result.updateFeedConfigured, false);
    assert.equal(result.logsReadable, true);
    if (credential === 'tampered') assert.equal(await readFile(fakeLicense, 'utf8'), 'invalid-test-credential');
    await page.screenshot({ path: join(directory, `${credential}-workspace.png`) });
    results.push({ credential, ...result });
  } finally { await application.close(); }
}
await writeFile(join(output, 'acceptance.json'), JSON.stringify({ executable, checkedAt: new Date().toISOString(), results }, null, 2));
console.log('安装版空白配置、损坏授权、重新启动均直接进入工作区；主进程输出授权、工程创建、原生设备枚举和日志读取通过。');
