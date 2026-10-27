import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { licenseRequestSchema } from '@tb/schema';
import { closeDiscarding } from './save-questions';

for (const credential of ['missing', 'tampered'] as const) {
  test(`Windows ${credential} credential blocks workspace and main-process calls`, async ({}, info) => {
    test.skip(process.platform !== 'win32', '机器码和原生授权必须在 Windows 验收');
    const profile = info.outputPath('profile');
    if (credential === 'tampered') {
      await mkdir(join(profile, 'licensing'), { recursive: true });
      await writeFile(join(profile, 'licensing/license.jwt'), 'invalid-license');
    }
    const application = await electron.launch({ args: [`--user-data-dir=${profile}`, join(process.cwd(), 'out/main/index.cjs')], env: { ...process.env, TBLINK_LOCAL_TEST_ACCESS: '0' } });
    try {
      const page = await application.firstWindow();
      await expect(page.getByRole('heading', { name: '激活你的工作区', exact: true })).toBeVisible();
      const panel = page.getByRole('region', { name: '本机授权', exact: true });
      await panel.getByText('本机信息与授权文件', { exact: true }).click();
      await expect(panel.getByLabel('本机机器码')).toHaveValue(/^TB1-[A-F0-9]{64}$/);
      expect((await page.evaluate(() => window.tbLink.getLicenseStatus())).state).toBe(credential === 'missing' ? 'inactive' : 'invalid');
      await expect(page.getByRole('button', { name: '新建工程', exact: true })).toHaveCount(0);
      await expect(page.getByRole('navigation', { name: '主要工作区' })).toHaveCount(0);

      // Exercise real preload/main handlers independently of the UI gate.
      const attempts = await page.evaluate(async () => {
        const operations: Record<string, () => Promise<unknown>> = {
          output: () => window.tbLink.requireOutputLicense(),
          create: () => window.tbLink.createProject('未授权测试'),
          open: () => window.tbLink.openProjectDocument('C:\\must-not-open.tblink'),
          runtime: () => window.tbLink.setRuntimeActive(true),
          integrations: () => window.tbLink.detectLocalIntegrations(),
          download: () => window.tbLink.downloadUpdate()
        };
        const results: Record<string, string> = {};
        for (const [name, operation] of Object.entries(operations)) {
          try { await operation(); results[name] = 'UNEXPECTED_SUCCESS'; }
          catch (error) { results[name] = error instanceof Error ? error.message : String(error); }
        }
        return results;
      });
      for (const [name, message] of Object.entries(attempts)) expect(message, name).toContain('需要有效授权');
      // Any machine may look for new versions; downloading and installing stay licensed.
      expect(await page.evaluate(() => window.tbLink.checkForUpdates().then(() => '已检查', (error: Error) => error.message))).not.toContain('需要有效授权');
      await expect(panel.getByRole('button', { name: '导入授权文件' })).toBeDisabled();
      await panel.getByLabel('激活码', { exact: true }).fill('invalid-code');
      await panel.getByRole('button', { name: '激活本机', exact: true }).click();
      await expect(panel.getByRole('alert')).toBeVisible();
      await expect(page.getByRole('navigation', { name: '主要工作区' })).toHaveCount(0);

      const request = info.outputPath('request.json');
      await application.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath });
      }, request);
      await panel.getByRole('button', { name: '导出授权申请' }).click();
      await expect(panel.getByText('本机信息已导出，可以发给售后核对授权。')).toBeVisible();
      expect(licenseRequestSchema.parse(JSON.parse(await readFile(request, 'utf8'))).machineCode).toBe(await panel.getByLabel('本机机器码').inputValue());
    } finally { await closeDiscarding(application); }
  });
}
