import { test, expect, _electron as electron } from '@playwright/test';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';

test('已保存控台直接连接，失败保持布局并显示具体端口', async ({}, info) => {
  const executablePath = process.env.TBLINK_MA2_PACKAGED_EXE;
  const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [`--user-data-dir=${info.outputPath('profile')}`, ...(executablePath ? [] : [join(process.cwd(), 'out/main/index.cjs')])] });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ ipcMain }) => {
      const settings = { host: '2.97.214.223', port: 30000, monitorPort: 30001, username: 'operator', autoConnect: false };
      const status = { settings, profiles: [settings], passwordSaved: true, state: 'disconnected', version: null, error: null };
      ipcMain.removeHandler('link:ma2-network-status'); ipcMain.handle('link:ma2-network-status', () => status);
      ipcMain.removeHandler('link:ma2-network-save'); ipcMain.handle('link:ma2-network-save', () => status);
      const adapter = { id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', index: 3, name: '以太网', description: 'Ethernet', physical: true, wired: true, connected: true, addresses: [{ address: '2.97.214.222', prefix: 24 }] };
      ipcMain.removeHandler('link:ma2-network-setup-state'); ipcMain.handle('link:ma2-network-setup-state', () => ({ adapters: [adapter], additions: [] }));
      ipcMain.removeHandler('link:ma2-network-setup-plan'); ipcMain.handle('link:ma2-network-setup-plan', () => ({ id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', adapter, host: settings.host, address: '2.97.214.222', prefix: 24, needsChange: false, message: '已在同网段' }));
      ipcMain.removeHandler('link:ma2-network-setup-apply'); ipcMain.handle('link:ma2-network-setup-apply', () => ({adapters:[adapter],additions:[]}));
      ipcMain.removeHandler('link:ma2-discover'); ipcMain.handle('link:ma2-discover', () => { throw new Error('已保存地址不应依赖搜索'); });
      ipcMain.removeHandler('link:ma2-network-connect'); ipcMain.handle('link:ma2-network-connect', () => ({ ...status, error: 'MA2 连接超时：2.97.214.223:30000 TCP 未连通；2.97.214.223:30001 TCP 未连通。请核对 IP 与网卡路由。' }));
    });
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('navigation', { name: '设置子子菜单' }).getByRole('button', { name: 'MA2 控台', exact: true }).click();
    await page.getByLabel('MA2 连接方式', { exact: true }).selectOption('network');
    await page.getByRole('button', { name: /^(连接控台|读取 Cue)$/ }).click();
    await expect(page.locator('.ma2-network-settings > .ma2-advanced-settings')).not.toHaveAttribute('open');
    await page.getByLabel('MA2 控台 IP', { exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByLabel('MA2 控台 IP', { exact: true })).toBeVisible();
    await expect(page.getByLabel('MA2 控台 IP', { exact: true })).toHaveValue('2.97.214.223');
    await expect(page.locator('.ma2-network-settings [role="alert"]')).toContainText('30001 TCP 未连通');
    await expect(page.getByText('已保存地址不应依赖搜索', { exact: true })).toHaveCount(0);
  } catch (error) {
    const page = await app.firstWindow();
    await writeFile(info.outputPath('failure-state.json'), JSON.stringify(await page.getByLabel('MA2 控台 IP', { exact: true }).evaluate(element => {
      const ancestry = []; let node: Element | null = element;
      while (node) { const style = getComputedStyle(node), rect = node.getBoundingClientRect(); ancestry.push({ tag: node.tagName, classes: node.className, open: node.getAttribute('open'), hidden: node.getAttribute('hidden'), display: style.display, visibility: style.visibility, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }); node = node.parentElement; }
      return { ancestry, alerts: [...document.querySelectorAll('[role=alert]')].map(node => node.textContent) };
    }), null, 2));
    await writeFile(info.outputPath('failure-ui.txt'), await page.locator('body').innerText());
    await page.screenshot({ path: info.outputPath('failure-ui.png') });
    throw error;
  } finally { await app.close(); }
});
