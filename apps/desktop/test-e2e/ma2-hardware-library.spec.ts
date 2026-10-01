import { test, expect, _electron as electron } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEmptyLinkProject, createLightingDocument } from '@tb/schema';

test('实体控台经读取控台入口自动连接并显示真实素材', async ({}, info) => {
  test.skip(!process.env.TBLINK_MA2_HARDWARE_HOST, '需要实体控台');
  test.setTimeout(360000);
  const project = createEmptyLinkProject('实体控台素材读取验收');
  project.schemaVersion = 2;
  project.rundown.push({ id: 'hardware', title: '控台素材验收', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting: createLightingDocument() });
  const destination = info.outputPath('hardware.tblink');
  await writeFile(destination, JSON.stringify(project));
  const executable = process.env.TBLINK_MA2_PACKAGED_EXE;
  const application = await electron.launch({ ...(executable ? { executablePath: executable } : {}), args: [`--user-data-dir=${info.outputPath('profile')}`, ...executable ? [] : [join(process.cwd(), 'out/main/index.cjs')]] });
  const page = await application.firstWindow();
  if (process.env.TBLINK_MA2_TEST_HIDDEN) await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.hide(); });
  try {
    await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, destination);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.evaluate(() => localStorage.setItem('tblink.ma2-connection-method.v1', 'network'));
    await page.reload();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
    await page.getByRole('button', { name: '读取控台', exact: true }).click();
    const panel = page.getByRole('region', { name: '读取控台效果库' });
    await expect(panel.getByRole('progressbar', { name: '控台读取进度' })).toBeVisible();
    await expect(panel.locator('tbody tr').first()).toBeVisible({ timeout: 120000 });
    await expect(panel.locator('.ma2-material-footer')).toContainText('584 项', { timeout: 120000 });
    await expect(panel.locator('.ma2-material-footer')).toContainText('2hao');
    await expect(panel.getByRole('alert')).toHaveCount(0);
    await expect(panel).toContainText('mg1 spao 1');
    const tableHeight = await panel.locator('.effect-import-rows').evaluate(element => element.clientHeight);
    expect(tableHeight).toBeGreaterThan(150);
    if (!process.env.TBLINK_MA2_TEST_HIDDEN) await page.screenshot({ path: info.outputPath('console-materials.png') });
    await panel.getByLabel('按序列分组').selectOption('1');
    await expect(panel.locator('tbody tr')).toHaveCount(1);
    await panel.getByLabel('搜索控台 Cue').fill('不存在的素材名称');
    await expect(panel).toContainText('没有匹配的素材');
    await panel.getByLabel('搜索控台 Cue').fill('');
    await panel.getByRole('button', { name: '关闭素材窗口' }).click();
    await page.getByRole('button', { name: '读取控台', exact: true }).click();
    await expect(panel).toContainText('上次读取');
    await panel.getByLabel('按序列分组').selectOption('');
    await panel.getByLabel('全选筛选结果').check();
    await expect(panel).toContainText('已选择 584 项');
    await panel.getByRole('button', { name: '加入素材库', exact: false }).click();
    await expect(page.locator('.lighting-effect-card')).toHaveCount(584);
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
    await page.getByRole('navigation', { name: '设置子子菜单' }).getByRole('button', { name: 'MA2 控台', exact: true }).click();
    await expect(page.getByLabel('MA2 控台 IP')).not.toBeVisible();
    await expect(page.getByRole('button', { name: '自动连接控台' })).toBeVisible();
    if (!process.env.TBLINK_MA2_TEST_HIDDEN) await page.screenshot({ path: info.outputPath('console-settings.png') });
    const status = await page.evaluate(() => window.tbLink.getMa2NetworkStatus());
    expect(status.settings?.host).toBe(process.env.TBLINK_MA2_HARDWARE_HOST);
    if (process.env.TBLINK_MA2_CONCURRENT_ACCEPTANCE) {
      const concurrent = page.evaluate(async () => {
        const status = await window.tbLink.getMa2NetworkStatus();
        if (!status.settings) throw new Error('未连接控台');
        const { host, port, monitorPort, username } = status.settings;
        const endpoint = { dataDirectory: '', network: { host, port, monitorPort, username } };
        const [catalog, library] = await Promise.all([
          window.tbLink.readMa2Catalog(endpoint),
          window.tbLink.readMa2EffectLibrary(endpoint),
          window.tbLink.checkMa2Capabilities(),
          window.tbLink.exchangeMa2({ ...endpoint, target: 1, operation: 'PING', expected: '', desired: '' })
        ]);
        return { catalog, library };
      });
      const [result] = await Promise.all([concurrent, (async () => {
        const nav = page.getByRole('navigation', { name: '主要工作区' });
        await nav.getByRole('button', { name: '灯光工作台', exact: true }).click();
        await nav.getByRole('button', { name: '设置', exact: true }).click();
        await expect(page.getByText('已连接，但插件未就绪', { exact: false })).toHaveCount(0);
      })()]);
      await writeFile(info.outputPath('concurrent-scan.json'), JSON.stringify(result, null, 2));
      expect(result.library.sequences.length).toBeGreaterThan(0);
      expect(result.catalog.entries.filter(entry => entry.error)).toEqual([]);
      await expect(page.getByText('MA2 正在交换数据', { exact: false })).toHaveCount(0);
    }

  } finally {
    if (!page.isClosed()) await page.evaluate(() => window.tbLink.setDocumentDirty(false));
    if (application.process().exitCode === null) await application.close();
  }
});
