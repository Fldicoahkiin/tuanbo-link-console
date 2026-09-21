import { test, expect, _electron as electron } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEmptyLinkProject, licenseRequestSchema } from '@tb/schema';

test('单主机授权入口可导出真实机器码，错误授权明确提示', async ({}, info) => {
  const project = info.outputPath('license.tblink');
  const request = info.outputPath('request.json');
  const invalid = info.outputPath('invalid.tbllicense');
  await writeFile(project, JSON.stringify(createEmptyLinkProject('授权验收')));
  await writeFile(invalid, 'invalid-license');
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')] });
  try {
    await app.evaluate(({ dialog, BrowserWindow }, path) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] });
      BrowserWindow.getAllWindows()[0]?.setSize(1440, 900);
    }, project);
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '外观与更新', exact: true }).click();
    await page.getByRole('button', { name: '本机授权', exact: true }).click();
    const panel = page.getByRole('region', { name: '本机授权', exact: true });
    await expect(panel.getByLabel('本机机器码')).toHaveValue(/^TB1-[A-F0-9]{64}$/);
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath }); }, request);
    await panel.getByRole('button', { name: '导出授权申请' }).click();
    await expect(panel.getByText('授权申请已导出，请交给发行方签发本机授权。')).toBeVisible();
    expect(licenseRequestSchema.parse(JSON.parse(await readFile(request, 'utf8'))).machineCode).toBe(await panel.getByLabel('本机机器码').inputValue());
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, invalid);
    await panel.getByRole('button', { name: '导入授权文件' }).click();
    await expect(panel.getByRole('alert')).toBeVisible();
    await panel.getByRole('button', { name: '刷新状态' }).click();
    await expect(panel.getByRole('alert')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('license-settings.png') });
  } finally { await app.close(); }
});
