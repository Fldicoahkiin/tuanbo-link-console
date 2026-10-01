import { test, expect, _electron as electron } from '@playwright/test';
import { join } from 'node:path';

for (const cancelled of [false, true]) test(`自动连接配置电脑地址、${cancelled ? '取消授权阻断' : '连接和恢复'}`, async ({}, info) => {
  const executablePath = process.env.TBLINK_MA2_PACKAGED_EXE;
  const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [`--user-data-dir=${info.outputPath('profile')}`, ...(executablePath ? [] : [join(process.cwd(), 'out/main/index.cjs')])] });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ ipcMain }, cancel) => {
      const adapter = { id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', index: 3, name: '以太网', description: 'Ethernet', connected: true, physical: true, wired: true, addresses: [{ address: '192.168.1.10', prefix: 24 }] };
      const plan = { id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', adapter, host: '2.97.214.223', address: '2.97.214.222', prefix: 24, needsChange: true, message: '为以太网增加 2.97.214.222，保留上网配置' };
      const settings = { host: plan.host, port: 30000, monitorPort: 30001, username: 'operator', autoConnect: false };
      const actions: string[] = []; Reflect.set(globalThis, '__networkActions', actions);
      let applied = false; let connected = false;
      const state = () => ({ adapters: [adapter], additions: applied ? [{ id: plan.id, adapterId: adapter.id, adapterName: adapter.name, address: plan.address, prefix: plan.prefix }] : [] });
      const status = () => ({ settings, passwordSaved: true, state: connected ? 'connected' : 'disconnected', version: connected ? '3.9.60.74' : null, error: null });
      const handlers: Record<string, () => unknown> = {
        'link:ma2-network-status': status, 'link:ma2-network-save': status,
        'link:ma2-network-setup-state': state, 'link:ma2-network-setup-plan': () => plan,
        'link:ma2-network-setup-apply': () => { actions.push('apply'); if (cancel) throw new Error('管理员授权已取消'); applied = true; return state(); },
        'link:ma2-network-connect': () => { if (!applied) throw new Error('尚未配置电脑地址'); actions.push('connect'); connected = true; return status(); },
        'link:ma2-network-setup-restore': () => { actions.push('restore'); applied = false; connected = false; return state(); }
      };
      for (const [channel, handler] of Object.entries(handlers)) { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler); }
    }, cancelled);
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('navigation', { name: '设置子子菜单' }).getByRole('button', { name: 'MA2 控台', exact: true }).click();
    await page.getByLabel('MA2 连接方式', { exact: true }).selectOption('network');
    await page.locator('.ma2-network-settings > details > summary').click();
    await page.getByLabel('MA2 控台 IP', { exact: true }).fill('2.0.0.98:30000');
    await page.getByRole('button', { name: '自动连接控台', exact: true }).click();
    await expect(page.locator('.ma2-network-settings [role="alert"]')).toContainText('控台 IP格式不正确');
    expect(await app.evaluate(() => Reflect.get(globalThis, '__networkActions') as string[])).toEqual([]);
    await page.getByLabel('MA2 控台 IP', { exact: true }).fill('２．９７．２１４．２２３');
    await page.locator('.ma2-network-settings > details > summary').click();
    await page.getByRole('button', { name: '自动连接控台', exact: true }).click();
    if (cancelled) {
      await expect(page.locator('.ma2-network-settings [role="alert"]')).toContainText('管理员授权已取消');
      expect(await app.evaluate(() => Reflect.get(globalThis, '__networkActions') as string[])).toEqual(['apply']);
    } else {
      await expect(page.locator('.ma2-network-settings > .ma2-device-status')).toHaveText('已连接');
      expect(await app.evaluate(() => Reflect.get(globalThis, '__networkActions') as string[])).toEqual(['apply', 'connect']);
      await page.locator('.ma2-network-settings > details > summary').click();
      await expect(page.getByLabel('控台网卡', { exact: true })).toBeVisible();
      await page.screenshot({ path: info.outputPath('computer-network.png') });
      await page.getByRole('button', { name: '恢复原配置', exact: true }).click();
      await expect(page.getByRole('button', { name: '恢复原配置', exact: true })).toHaveCount(0);
    }
  } finally { await app.close(); }
});
