import { test, expect, _electron as electron, type Page, type ElectronApplication } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LinkUpdateStatus } from '@tb/core/link';
import type { Ma2NetworkStatus, Ma2NetworkSave } from '@tb/schema';
import { createEmptyLinkProject } from '@tb/schema';
import { SETTINGS_GROUPS, SETTINGS_SECTIONS } from '../src/renderer/src/link/components/settings-navigation';
import { createDefaultIntegrationProfile } from '../src/renderer/src/link/view-models/local-integration-profile';


async function installSettingsDevices(app: ElectronApplication): Promise<void> {
  const initial = createDefaultIntegrationProfile();
  initial.obs.autoConnectOnLaunch = false;
  await app.evaluate(({ ipcMain }, profile) => {
    let saved = profile;
    const handlers: Record<string, () => unknown> = {
      'link:license-require-output': () => undefined,
      'link:load-profile': () => saved,
      'link:security-availability': () => true,
      'link:update-status': () => ({ phase: 'upToDate', currentVersion: '0.4.46', availableVersion: null, releaseDate: null, progressPercent: null, transferredBytes: null, totalBytes: null, feedConfigured: true, installBlockedReason: null, message: '当前已是最新版本' }),
      'link:native-player-devices': () => ({ protocol: 4, audio: [], midiOutputs: [] }),
      'link:loop-midi': () => ({ state: 'missing', executablePath: null, pid: null, startTime: null }),
      'link:obs-snapshot': () => ({ status: 'disconnected', obsVersion: null, webSocketVersion: null, error: null }),
      'link:ma2-network-status': () => ({ state: 'disconnected', settings: null, passwordSaved: false, profiles: [], version: null, error: null }),
      'link:ma2-network-disconnect': () => ({ state: 'disconnected', settings: null, passwordSaved: false, profiles: [], version: null, error: null })
    };
    for (const [channel, handler] of Object.entries(handlers)) { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler); }
    ipcMain.removeHandler('link:save-profile');
    ipcMain.handle('link:save-profile', (_event, payload: { profile: typeof profile }) => { saved = payload.profile; });
  }, initial);
}

async function select(page: Page, id: typeof SETTINGS_SECTIONS[number]['id']): Promise<void> {
  const section = SETTINGS_SECTIONS.find(entry => entry.id === id)!;
  const group = SETTINGS_GROUPS.find(entry => entry.id === section.group)!;
  await page.getByRole('navigation', { name: '设置子菜单', exact: true }).getByRole('button', { name: group.name, exact: true }).click();
  await page.getByRole('navigation', { name: '设置子子菜单', exact: true }).getByRole('button', { name: section.name, exact: true }).click();
  await expect(page.locator('.device-console:visible h1')).toHaveText(section.name);
}

async function audit(page: Page): Promise<unknown> {
  return page.locator('.device-console:visible').evaluate(root => {
    const right = root.getBoundingClientRect().right;
    const elements = [...root.querySelectorAll<HTMLElement>('input,select,button,textarea,summary,h1,h2,h3,p,label')].filter(element => element.checkVisibility());
    const overflow = elements.filter(element => element.getBoundingClientRect().right > right + 1 || element.getBoundingClientRect().left < root.getBoundingClientRect().left - 1).map(element => element.getAttribute('aria-label') ?? element.textContent?.slice(0, 50));
    const small = elements.filter(element => !element.matches('input[type=checkbox],input[type=radio]') && parseFloat(getComputedStyle(element).fontSize) < 13).map(element => element.outerHTML.slice(0, 130));
    return { overflow, small, pageOverflow: root.scrollWidth > root.clientWidth + 1, viewport: [innerWidth, innerHeight] };
  });
}

test('设置全部页面双主题三尺寸、展开状态与缩放视觉矩阵', async ({}, info) => {
  test.setTimeout(240_000);
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')] });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    // UI-only authorization substitute in this disposable test process; no license files or product gates change.
    await installSettingsDevices(app);
    await page.reload();
    await page.getByRole('button', { name: '新建工程', exact: true }).waitFor();
    const file = info.outputPath('settings.tblink');
    const content = JSON.stringify({ ...createEmptyLinkProject('设置界面验收'), playbackSource: 'internal' });
    await writeFile(file, content);
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
    await select(page, 'source');
    await expect(page.getByRole('radio', { name: /本软件播放/ })).toBeChecked();
    const results: unknown[] = [];
    for (const theme of ['dark', 'light']) {
      await page.evaluate(value => { localStorage.setItem('tblink.appearance.v1', value); window.dispatchEvent(new Event('tblink-appearance-change')); }, theme);
      for (const [width, height] of [[1180, 720], [1540, 960], [1920, 1080]]) {
        await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setSize(size[0]!, size[1]!), [width!, height!]);
        for (const section of SETTINGS_SECTIONS) {
          await select(page, section.id);
          const result = await audit(page);
          results.push({ theme, width, section: section.id, result });
          await page.screenshot({ path: info.outputPath(`${theme}-${width}-${section.id}.png`) });
          expect.soft(result, `${theme}/${width}/${section.id}`).toMatchObject({ overflow: [], small: [], pageOverflow: false });
        }
      }
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1180, 720));
    for (const zoom of [1.25, 1.5, 2]) {
      await app.evaluate(({ BrowserWindow }, factor) => BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(factor), zoom);
      for (const id of ['obs', 'audio', 'ma2', 'license', 'shortcuts', 'logs', 'feedback'] as const) {
        await select(page, id);
        expect(await audit(page), `zoom ${zoom}/${id}`).toMatchObject({ overflow: [], small: [], pageOverflow: false });
        await page.screenshot({ path: info.outputPath(`zoom-${zoom}-${id}.png`) });
      }
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1540, 960));
    for (const id of ['obs', 'ma2', 'maintenance', 'license', 'songs'] as const) {
      await select(page, id);
      await page.locator('.device-console:visible details').evaluateAll(details => details.forEach(element => { if (element instanceof HTMLDetailsElement) element.open = true; }));
      expect(await audit(page), `expanded ${id}`).toMatchObject({ overflow: [], small: [], pageOverflow: false });
      await page.screenshot({ path: info.outputPath(`expanded-${id}.png`) });
      await page.locator('.content-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
      await page.screenshot({ path: info.outputPath(`expanded-${id}-bottom.png`) });
    }
    await writeFile(info.outputPath('matrix.json'), JSON.stringify(results, null, 2));
    expect(errors).toEqual([]);
  } catch (error) {
    await page.screenshot({ path: info.outputPath('failure.png') });
    await writeFile(info.outputPath('failure.txt'), await page.locator('body').innerText());
    throw error;
  } finally { await page.evaluate(() => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null })); await app.close(); }
});

test('设置草稿隔离、密码显隐、退出确认、分类记忆与快捷键撤销', async ({}, info) => {
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')] });
  const page = await app.firstWindow();
  try {
    // UI-only authorization substitute in this disposable test process; no license files or product gates change.
    await installSettingsDevices(app);
    await page.reload();
    await page.getByRole('button', { name: '新建工程', exact: true }).waitFor();
    const profile = createDefaultIntegrationProfile(); profile.obs.autoConnectOnLaunch = false;
    await page.evaluate(value => window.tbLink.saveIntegrationProfile({ profile: value }), profile);
    await page.reload();
    const main = page.getByRole('navigation', { name: '主要工作区' });
    await main.getByRole('button', { name: '设置', exact: true }).click();
    await select(page, 'obs');
    await page.getByText('手动连接', { exact: true }).click();
    await page.getByLabel('WebSocket 地址', { exact: true }).fill('127.0.0.1:4499');
    await page.getByLabel('OBS 密码', { exact: true }).fill('test-only-draft');
    await expect(page.getByLabel('OBS 密码', { exact: true })).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: '显示密码', exact: true }).click();
    await expect(page.getByLabel('OBS 密码', { exact: true })).toHaveAttribute('type', 'text');
    await page.getByRole('switch', { name: '启动时自动连接 OBS', exact: true }).check();
    await expect.poll(async () => (await page.evaluate(() => window.tbLink.loadIntegrationProfile()))?.obs.autoConnectOnLaunch).toBe(true);
    expect((await page.evaluate(() => window.tbLink.loadIntegrationProfile()))?.obs.webSocketUrl).toBe(profile.obs.webSocketUrl);
    await select(page, 'logs'); await select(page, 'obs');
    await expect(page.getByLabel('OBS 密码', { exact: true })).toHaveValue('test-only-draft');
    await expect(page.getByLabel('WebSocket 地址', { exact: true })).toHaveValue('127.0.0.1:4499');
    await select(page, 'preferences');
    await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
    await expect(page.locator('.device-console:visible h1')).toHaveText('OBS Studio');
    await main.getByRole('button', { name: '节目单', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '离开设置？' })).toBeVisible();
    await page.getByRole('button', { name: '继续编辑', exact: true }).click();
    await expect(page.getByLabel('OBS 密码', { exact: true })).toHaveValue('test-only-draft');
    await main.getByRole('button', { name: '节目单', exact: true }).click();
    await page.getByRole('button', { name: '放弃未保存修改', exact: true }).click();
    await main.getByRole('button', { name: '设置', exact: true }).click();
    await select(page, 'obs'); await page.getByText('手动连接', { exact: true }).click();
    await expect(page.getByLabel('OBS 密码', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('OBS 密码', { exact: true })).toHaveAttribute('type', 'password');
    await select(page, 'shortcuts');
    const count = await page.locator('.shortcut-binding').count();
    await page.locator('.shortcut-binding button').first().click();
    await expect(page.locator('.shortcut-binding')).toHaveCount(count - 1);
    await page.getByRole('button', { name: '撤销删除' }).click();
    await expect(page.locator('.shortcut-binding')).toHaveCount(count);
    await page.getByRole('button', { name: '恢复默认快捷键', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '恢复默认快捷键？' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: '恢复默认快捷键', exact: true })).toBeFocused();
    await page.locator('.shortcut-binding input').first().focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('.shortcut-binding button').first()).toBeFocused();
  } finally { await page.evaluate(() => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null })); await app.close(); }
});


test('OBS 保存成功与连接失败分开显示，失败后可修正并连接', async ({}, info) => {
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')] });
  const page = await app.firstWindow();
  try {
    await installSettingsDevices(app);
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('link:obs-connect');
      ipcMain.handle('link:obs-connect', () => { throw new Error('测试：连接超时，请检查 OBS 地址'); });
    });
    await page.reload();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
    await select(page, 'obs');
    await page.getByText('手动连接', { exact: true }).click();
    await page.getByLabel('WebSocket 地址', { exact: true }).fill('http://127.0.0.1:4455');
    await page.getByRole('button', { name: '保存并连接 OBS', exact: true }).click();
    await expect(page.getByLabel('WebSocket 地址', { exact: true })).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByLabel('WebSocket 地址', { exact: true })).toBeFocused();
    await page.getByLabel('WebSocket 地址', { exact: true }).fill('4499');
    await page.getByRole('button', { name: '保存并连接 OBS', exact: true }).click();
    await expect(page.getByText('连接配置已保存到本机。', { exact: true })).toBeVisible();
    await expect(page.locator('.device-console:visible .tone-error')).toContainText('连接超时');
    expect((await page.evaluate(() => window.tbLink.loadIntegrationProfile()))?.obs.webSocketUrl).toBe('ws://127.0.0.1:4499');
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      ipcMain.removeHandler('link:obs-connect');
      ipcMain.handle('link:obs-connect', () => ({ status: 'connected', obsVersion: '32', webSocketVersion: '5', error: null }));
      ipcMain.removeHandler('link:obs-inventory');
      ipcMain.handle('link:obs-inventory', () => ({ scenes: [], inputs: [], filters: {}, inputKinds: {}, inputAudioStates: {}, sceneItems: {}, transitions: [], videoSettings: { baseWidth: 1920, baseHeight: 1080 }, sourceSizes: {}, sceneItemTransforms: {} }));
      ipcMain.removeHandler('link:obs-disconnect');
      ipcMain.handle('link:obs-disconnect', () => { BrowserWindow.getAllWindows()[0]!.webContents.send('link:obs-status', { status: 'disconnected', obsVersion: null, webSocketVersion: null, error: null }); });
    });
    await page.getByRole('button', { name: '保存并连接 OBS', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'OBS 已连接', exact: true })).toBeVisible();
    await expect(page.locator('.device-console:visible .tone-error')).toHaveCount(0);
    await page.getByRole('button', { name: '断开 OBS', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'OBS 尚未连接', exact: true })).toBeVisible();
  } finally { await page.evaluate(() => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null })); await app.close(); }
});

test('更新阶段直接呈现在设置页，下载信息与动作一致', async ({}, info) => {
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')] });
  const page = await app.firstWindow();
  try {
    await installSettingsDevices(app); await page.reload();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
    await select(page, 'updates');
    for (const phase of ['disabled', 'notConfigured', 'idle', 'checking', 'upToDate', 'available', 'downloading', 'downloaded', 'error'] as const) {
      const status: LinkUpdateStatus = { phase, currentVersion: '0.4.46', availableVersion: '0.4.47', releaseDate: null, progressPercent: 45, transferredBytes: 4500000, totalBytes: 10000000, feedConfigured: phase !== 'notConfigured', installBlockedReason: null, message: `验收更新状态：${phase}` };
      await app.evaluate(({ BrowserWindow }, value) => { BrowserWindow.getAllWindows()[0]!.webContents.send('link:update-status', value); }, status);
      await expect(page.getByText(status.message, { exact: true })).toBeVisible();
      if (phase === 'downloading') await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '45');
      if (phase === 'downloaded') await expect(page.getByRole('button', { name: '重启并安装' })).toBeVisible();
      if (phase === 'available') await expect(page.getByRole('button', { name: '下载更新' })).toBeVisible();
      await page.screenshot({ path: info.outputPath(`update-${phase}.png`) });
    }
  } finally { await page.evaluate(() => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null })); await app.close(); }
});

test('MA2 三种连接方式、凭证隔离、手动保存与搜索取消', async ({}, info) => {
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')] });
  const page = await app.firstWindow();
  try {
    await installSettingsDevices(app);
    await app.evaluate(({ ipcMain }) => {
      let status: Ma2NetworkStatus = { state: 'disconnected', settings: null, passwordSaved: false, profiles: [], version: null, error: null };
      let completeSearch: (() => void) | undefined;
      ipcMain.removeHandler('link:ma2-network-status');
      ipcMain.handle('link:ma2-network-status', () => status);
      ipcMain.removeHandler('link:ma2-network-save');
      ipcMain.handle('link:ma2-network-save', (_event, request: Ma2NetworkSave) => {
        status = { ...status, settings: request.settings, profiles: [request.settings], passwordSaved: Boolean(request.password) };
        return status;
      });
      ipcMain.removeHandler('link:ma2-discover');
      ipcMain.handle('link:ma2-discover', () => new Promise(resolve => { completeSearch = () => resolve({ hosts: [], ranges: ['192.168.0.0/24'], warnings: [] }); }));
      ipcMain.removeHandler('link:ma2-discovery-cancel');
      ipcMain.handle('link:ma2-discovery-cancel', () => completeSearch?.());
    });
    await page.reload();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
    await select(page, 'ma2');
    await expect(page.getByRole('button', { name: '选择 MIDI 端口' })).toBeVisible();
    await page.getByLabel('MA2 连接方式').selectOption('network');
    await page.locator('.ma2-network-settings > .ma2-advanced-settings > summary').click();
    await page.getByLabel('MA2 控台 IP', { exact: true }).fill('192.168.0.10');
    await page.getByLabel('MA2 登录密码', { exact: true }).fill('test-only-password');
    await page.getByRole('button', { name: '显示密码', exact: true }).click();
    await page.getByLabel('MA2 控台 IP', { exact: true }).fill('192.168.0.11');
    await expect(page.getByLabel('MA2 登录密码', { exact: true })).toHaveValue('admin');
    await expect(page.getByLabel('MA2 登录密码', { exact: true })).toHaveAttribute('type', 'password');
    await page.getByLabel('MA2 登录密码', { exact: true }).fill('second-target-password');
    await select(page, 'audio'); await select(page, 'ma2');
    await expect(page.getByLabel('MA2 登录密码', { exact: true })).toHaveValue('second-target-password');
    await page.getByLabel('MA2 连接方式').selectOption('local');
    await expect(page.getByLabel('MA2 onPC 数据目录')).toBeVisible();
    await page.screenshot({ path: info.outputPath('ma2-local.png') });
    await page.getByLabel('MA2 连接方式').selectOption('network');
    await expect(page.getByLabel('MA2 登录密码', { exact: true })).toHaveValue('second-target-password');
    await page.getByRole('button', { name: '仅保存', exact: true }).click();
    await expect(page.getByText('连接设置已保存。', { exact: true })).toBeVisible();
    expect((await page.evaluate(() => window.tbLink.getMa2NetworkStatus())).settings?.host).toBe('192.168.0.11');
    await page.getByRole('button', { name: '搜索控台' }).click();
    await expect(page.getByLabel('MA2 连接方式')).toBeDisabled();
    await page.getByRole('button', { name: '取消搜索', exact: true }).click();
    await expect(page.getByText('未发现开放的远程端口，请检查网络和控台 Telnet 设置，或手动填写 IP。')).toBeVisible();
    await expect(page.getByLabel('MA2 连接方式')).toBeEnabled();
    expect(await audit(page)).toMatchObject({ overflow: [], small: [], pageOverflow: false });
    await page.screenshot({ path: info.outputPath('ma2-network.png') });
  } finally { await page.evaluate(() => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null })); await app.close(); }
});
