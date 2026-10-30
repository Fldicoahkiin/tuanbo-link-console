import { test, expect, _electron as electron } from '@playwright/test';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createEmptyLinkProject, createLightingDocument } from '@tb/schema';
import { closeDiscarding } from './save-questions';

test('编辑灯光随网络连接显示已连接，断开后更新且不依赖一键检查', async ({}, info) => {
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')] });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '新建工程', exact: true }).waitFor();
    await app.evaluate(({ ipcMain }) => {
      process.env.TBLINK_TOPBAR_NETWORK_STATE = 'connected';
      ipcMain.removeHandler('link:ma2-network-status');
      ipcMain.handle('link:ma2-network-status', () => ({ settings: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test', autoConnect: false }, state: process.env.TBLINK_TOPBAR_NETWORK_STATE, version: '3.7.0.5', passwordSaved: false, error: null }));
    });
    await page.evaluate(() => localStorage.setItem('tblink.ma2-connection-method.v1', 'network'));
    await page.reload();
    const overview = page.getByRole('group', { name: '连接状态概览' });
    await expect(overview.getByRole('button', { name: '编辑灯光：已连接，前往设置', exact: true })).toHaveAttribute('data-state', 'ready');
    await app.evaluate(() => { process.env.TBLINK_TOPBAR_NETWORK_STATE = 'disconnected'; });
    await expect(overview.getByRole('button', { name: '编辑灯光：未连接，前往设置', exact: true })).toHaveAttribute('data-state', 'idle');
    await app.evaluate(() => { process.env.TBLINK_TOPBAR_NETWORK_STATE = 'connected'; });
    await expect(overview.getByRole('button', { name: '编辑灯光：已连接，前往设置', exact: true })).toHaveAttribute('data-state', 'ready');
    await page.screenshot({ path: info.outputPath('editing-connected.png') });
  } finally { await closeDiscarding(app); }
});

test('顶部保留四项连接状态，详细在下方展开按设备分组的完整列表且不切工作区', async ({}, info) => {
  const executablePath = process.env.TBLINK_PACKAGED_APP_EXE;
  const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [`--user-data-dir=${info.outputPath('profile')}`, ...(executablePath ? [] : [join(process.cwd(), 'out/main/index.cjs')])] });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '新建工程', exact: true }).waitFor();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1180, 720));
    const overview = page.getByRole('group', { name: '连接状态概览' });
    await expect(overview.getByRole('button')).toHaveCount(4);
    // The whole title bar drags the window; each actual control stays clickable.
    await expect(page.locator('.titlebar')).toHaveCSS('-webkit-app-region', 'drag');
    await expect(overview.getByRole('button').first()).toHaveCSS('-webkit-app-region', 'no-drag');
    for (const name of ['音频', '视频', '灯光', '编辑灯光']) await expect(overview.getByText(name, { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('connection-overview.png') });
    await expect(page.locator('.app-shell')).toHaveAttribute('data-workspace', 'project');
    const details = page.getByRole('button', { name: '详细', exact: true });
    await details.click();
    await expect(details).toHaveAttribute('aria-expanded', 'true');
    // The overview stays; the full list opens under the title bar, grouped by device.
    await expect(overview).toBeVisible();
    const panel = page.getByRole('dialog', { name: '全部连接状态' });
    await expect(panel).toBeVisible();
    expect((await panel.boundingBox())!.y).toBeGreaterThanOrEqual((await details.boundingBox())!.y + (await details.boundingBox())!.height);
    await expect(panel.getByRole('heading', { level: 3 })).toHaveText(['音频与 MIDI', '画面（OBS）', '灯光（MA2）', '其他']);
    await expect(panel.getByRole('button', { name: /OBS 控制/ })).toBeVisible();
    await page.screenshot({ path: info.outputPath('connection-details.png') });
    await expect(page.locator('.app-shell')).toHaveAttribute('data-workspace', 'project');
    await details.click();
    await expect(details).toHaveAttribute('aria-expanded', 'false');
    await expect(panel).toHaveCount(0);
    await expect(overview).toBeVisible();
  } finally { await closeDiscarding(app); }
});


test('点击四项状态定位并短暂强调，重复点击重新滚动', async ({}, info) => {
  const project = createEmptyLinkProject('连接定位验收'); project.schemaVersion = 2; project.playbackSource = 'internal';
  const lighting = createLightingDocument(); lighting.outputMode = 'timecode';
  project.rundown.push({ id: 'song', title: '定位歌曲', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting });
  const file = info.outputPath('settings.tblink'); await writeFile(file, JSON.stringify(project));
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')] });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [file] }); }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await expect(page.getByText('连接定位验收', { exact: true })).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1180, 720));
    const overview = page.getByRole('group', { name: '连接状态概览' });
    for (const [name, field] of [['音频', '音乐监听设备'], ['视频', 'OBS 连接设置'], ['灯光', '灯光 MIDI 输出'], ['编辑灯光', 'MA2 连接设置']] as const) {
      await overview.getByRole('button', { name: new RegExp(`^${name}：`) }).click();
      const highlight = page.locator('.settings-location-highlight');
      await expect(highlight).toHaveCount(1);
      await expect(highlight).toBeInViewport();
      await expect(highlight).toBeFocused();
      await expect(page.getByLabel(field, { exact: true })).toBeVisible();
      expect(await highlight.evaluate((element, name) => element.getAttribute('aria-label') === name || Boolean(element.querySelector(`[aria-label="${name}"]`)), field)).toBe(true);
      await page.screenshot({ path: info.outputPath(`定位-${name}.png`) });
      await expect(highlight).toHaveCount(0);
    }
    await page.getByLabel('MA2 连接方式').selectOption('network');
    await overview.getByRole('button', { name: /^灯光：/ }).click();
    // This song explicitly uses timecode; choosing an editing connection must not reroute its output.
    await expect(page.locator('.settings-location-highlight').getByLabel('灯光 MIDI 输出', { exact: true })).toBeVisible();
    await overview.getByRole('button', { name: /^编辑灯光：/ }).click();
    await expect(page.locator('.settings-location-highlight')).toHaveAttribute('aria-label', 'MA2 连接设置');
    await page.getByLabel('MA2 连接方式').selectOption('midi');
    // Manual navigation clears emphasis; repeated status clicks locate the field again.
    await page.getByRole('navigation', { name: '设置子子菜单' }).getByRole('button', { name: '音频与 MIDI', exact: true }).click();
    await expect(page.locator('.settings-location-highlight')).toHaveCount(0);
    await overview.getByRole('button', { name: /^音频：/ }).click();
    await page.locator('.content-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await overview.getByRole('button', { name: /^音频：/ }).click();
    await expect(page.locator('.settings-location-highlight')).toBeInViewport();
    await expect(page.locator('.settings-location-highlight')).toBeFocused();
    await expect(page.locator('.settings-location-highlight')).toHaveCount(0);
  } finally { await closeDiscarding(app); }
});
