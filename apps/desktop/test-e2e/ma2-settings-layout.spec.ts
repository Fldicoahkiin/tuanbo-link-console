import { test, expect, _electron as electron } from '@playwright/test';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createEmptyLinkProject } from '@tb/schema';

test('MA2 设置分组及大量搜索结果保持紧凑', async ({}, info) => {
  const file = info.outputPath('settings.tblink');
  await writeFile(file, JSON.stringify(createEmptyLinkProject('设备设置验收')));
  const executablePath = process.env.TBLINK_MA2_PACKAGED_EXE;
  const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [`--user-data-dir=${info.outputPath('profile')}`, ...(executablePath ? [] : [join(process.cwd(), 'out/main/index.cjs')])] });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ ipcMain, dialog, BrowserWindow }, path) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] });
      BrowserWindow.getAllWindows()[0]?.setSize(1540, 960);
      ipcMain.removeHandler('link:ma2-discover');
      ipcMain.handle('link:ma2-discover', () => ({ hosts: Array.from({ length: 215 }, (_, i) => ({ host: `10.39.12.${i + 1}`, port: 30000, identity: i === 2 || i === 88 ? 'ma2' : 'candidate' })), ranges: ['10.39.12.0/24'], warnings: [] }));
    }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('navigation', { name: '设置子子菜单' }).getByRole('button', { name: 'MA2 控台', exact: true }).click();
    await expect(page.getByRole('button', { name: '一键连接设备', exact: true })).toHaveCount(0);
    const method = page.getByLabel('MA2 连接方式', { exact: true });
    await method.selectOption('local');
    await page.screenshot({ path: info.outputPath('ma2-local-top.png') });
    await page.locator('.ma2-advanced-settings > summary').click();
    await page.getByRole('button', { name: '启用编辑后自动同步', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('ma2-operation-groups.png') });
    await method.selectOption('network');
    await page.locator('.ma2-network-settings > .ma2-advanced-settings > summary').click();
    await expect(page.getByLabel('MA2 登录用户', { exact: true })).toHaveValue('administrator');
    await expect(page.getByLabel('MA2 登录密码', { exact: true })).toHaveValue('admin');
    await page.getByRole('button', { name: '搜索局域网控台', exact: true }).click();
    const results = page.getByLabel('MA2 搜索结果', { exact: true });
    await expect(results.locator('tbody tr')).toHaveCount(215);
    await results.getByLabel('显示待确认地址').uncheck();
    await expect(results.locator('tbody tr')).toHaveCount(2);
    await results.getByLabel('显示待确认地址').check();
    await expect(results.locator('tbody tr')).toHaveCount(215);
    expect((await results.locator('.ma2-discovery-list').boundingBox())!.height).toBeLessThanOrEqual(241);
    await results.getByLabel('筛选控台地址').fill('10.39.12.215');
    await expect(results.locator('tbody tr')).toHaveCount(1);
    await results.getByRole('button', { name: '选择控台 10.39.12.215:30000' }).click();
    await expect(page.getByLabel('MA2 控台 IP', { exact: true })).toHaveValue('10.39.12.215');
    await results.getByLabel('筛选控台地址').fill('');
    await results.getByLabel('显示待确认地址').uncheck();
    await results.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('ma2-search-results.png') });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1180, 720));
    expect(await results.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.getByLabel('MA2 登录用户', { exact: true }).fill('operator');
    await page.getByRole('button', { name: '使用默认账号', exact: true }).click();
    await page.getByLabel('MA2 控台 IP', { exact: true }).fill('10.39.12.3');
    await expect(page.getByLabel('MA2 登录密码', { exact: true })).toHaveValue('admin');
    await app.evaluate(({ ipcMain }) => {
      const settings = { host: '10.39.12.3', port: 30000, monitorPort: 30001, username: 'administrator', autoConnect: false };
      const status = { settings, passwordSaved: true, state: 'disconnected', version: null, error: null };
      const adapter = { id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', index: 3, name: '测试网卡', description: 'Test', connected: true, physical: true, wired: true, addresses: [{ address: '10.39.12.4', prefix: 24 }] };
      ipcMain.removeHandler('link:ma2-network-setup-state');
      ipcMain.handle('link:ma2-network-setup-state', () => ({ adapters: [adapter], additions: [] }));
      ipcMain.removeHandler('link:ma2-network-setup-plan');
      ipcMain.handle('link:ma2-network-setup-plan', () => ({ id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', adapter, host: settings.host, address: '10.39.12.4', prefix: 24, needsChange: false, message: '使用测试网卡' }));
      ipcMain.removeHandler('link:ma2-network-save');
      ipcMain.handle('link:ma2-network-save', (_event, payload: { password?: string; settings: { username: string } }) => {
        if (payload.password !== 'admin' || payload.settings.username !== 'administrator') throw new Error('默认凭证未提交');
        return status;
      });
      ipcMain.removeHandler('link:ma2-network-connect');
      ipcMain.handle('link:ma2-network-connect', async () => {
        await new Promise(resolve => setTimeout(resolve, 600));
        return { ...status, error: 'MA2 监视端口连接失败：10.39.12.3:30001（ECONNREFUSED）' };
      });
    });
    await page.getByRole('button', { name: '保存并连接', exact: true }).click();
    await expect(page.getByText('正在连接 10.39.12.3:30000，并验证登录…', { exact: true })).toBeVisible();
    await expect(page.locator('.ma2-network-settings [role="alert"]')).toContainText('30001（ECONNREFUSED）');
    await expect(page.getByRole('button', { name: '保存并连接', exact: true })).toBeEnabled();
  } finally { await app.close(); }
});
