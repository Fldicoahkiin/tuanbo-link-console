import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect, _electron as electron } from '@playwright/test';
import { createEmptyLinkProject, createLightingDocument, ma2EffectLibrarySchema } from '@tb/schema';

const snapshot = join(process.cwd(), '../../artifacts/ma2-hardware-diagnostics/effect-library.json');

test('构造数据：素材读取关闭窗口后继续、保存并重启恢复，不再次扫描', async ({}, info) => {
  const project = createEmptyLinkProject('素材任务生命周期'); project.schemaVersion = 2;
  project.rundown.push({ id: 'song', title: '素材任务', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting: createLightingDocument() });
  const file = info.outputPath('lifecycle.tblink'); await writeFile(file, JSON.stringify(project));
  const executable = process.env.TBLINK_MA2_PACKAGED_EXE;
  const launch = () => electron.launch({ ...(executable ? { executablePath: executable } : {}), args: [`--user-data-dir=${info.outputPath('profile')}`, ...executable ? [] : [join(process.cwd(), 'out/main/index.cjs')]] });
  let app = await launch(); let page = await app.firstWindow();
  try {
    await app.evaluate(({ ipcMain, dialog }, file) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [file] });
      process.env.TBLINK_MATERIAL_READS = '0';
      ipcMain.removeHandler('link:ma2-network-status'); ipcMain.handle('link:ma2-network-status', () => ({ settings: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test', autoConnect: false }, state: 'connected', version: '3.7.0.5', passwordSaved: false, error: null }));
      ipcMain.removeHandler('link:ma2-effect-library'); ipcMain.handle('link:ma2-effect-library', async (event, request: { progressId: string }) => {
        process.env.TBLINK_MATERIAL_READS = String(Number(process.env.TBLINK_MATERIAL_READS) + 1);
        const directory = { show: '构造素材 Show', generation: 'test', version: '3.7.0.5', entries: [{ target: 36, name: '原序列名' }, { target: 37, name: '第二序列' }] };
        const readAt = new Date().toISOString();
        const sequences = directory.entries.map(entry => ({ sequence: entry.target, name: entry.name, cues: [{ index: 1, number: '1.100', name: '原步骤名' }] }));
        event.sender.send('link:ma2-read-progress', { id: request.progressId, phase: 'library', completed: 0, total: 3, detail: '读取目录', checkpoint: { directory, readAt } });
        event.sender.send('link:ma2-read-progress', { id: request.progressId, phase: 'library', completed: 1, total: 3, detail: '已读取第一条', sequences: [sequences[0]] });
        await new Promise(resolve => setTimeout(resolve, 3000));
        return { directory, readAt, sequences, fixtureUsage: [], errors: [], fixtureDetails: 'unavailable' };
      });
    }, file);
    await page.evaluate(() => localStorage.setItem('tblink.ma2-connection-method.v1', 'network'));
    await page.reload();
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
    await page.getByRole('button', { name: '读取控台', exact: true }).click();
    const panel = page.getByRole('region', { name: '读取控台效果库' });
    await panel.getByRole('button', { name: '读取控台素材', exact: true }).click();
    await expect(panel.getByText('原序列名 · 原步骤名', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: '关闭素材窗口' }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '节目单', exact: true }).click();
    await expect.poll(async () => (JSON.parse(await readFile(file, 'utf8')) as { ma2MaterialLibrary?: { library: { sequences: unknown[]; sourceUnverified?: boolean } } }).ma2MaterialLibrary?.library.sequences.length).toBe(2);
    expect(await app.evaluate(() => process.env.TBLINK_MATERIAL_READS)).toBe('1');
    await page.evaluate(() => window.tbLink.setDocumentDirty(false)); await app.close();
    app = await launch(); page = await app.firstWindow();
    await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('link:ma2-effect-library'); ipcMain.handle('link:ma2-effect-library', () => { throw new Error('重开不能自动扫描'); }); });
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
    await page.getByRole('button', { name: '读取控台', exact: true }).click();
    await expect(page.getByRole('region', { name: '读取控台效果库' })).toContainText('2 项');
    await expect(page.getByText('原序列名 · 原步骤名', { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('material-restored.png') });
  } finally {
    if (!page.isClosed()) await page.evaluate(() => window.tbLink.setDocumentDirty(false));
    if (app.process().exitCode === null) await app.close();
  }
});

test('现场 584 个 Cue 在原工作区内可查看、关闭恢复并一次入库', async ({}, info) => {
  test.skip(!existsSync(snapshot), '需要此前实机读取的只读素材快照');
  const library = ma2EffectLibrarySchema.parse(JSON.parse(await readFile(snapshot, 'utf8')));
  expect(library.sequences.flatMap(sequence => sequence.cues)).toHaveLength(584);
  const project = createEmptyLinkProject('素材界面验收');
  project.schemaVersion = 2;
  project.ma2MaterialLibrary = { version: 1, source: '2.97.214.223:30000', library };
  project.rundown.push({ id: 'material', title: '素材界面', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting: createLightingDocument() });
  const path = info.outputPath('material.tblink');
  await writeFile(path, JSON.stringify(project));
  const executable = process.env.TBLINK_MA2_PACKAGED_EXE;
  const application = await electron.launch({ ...(executable ? { executablePath: executable } : {}), args: [`--user-data-dir=${info.outputPath('profile')}`, ...executable ? [] : [join(process.cwd(), 'out/main/index.cjs')]] });
  const page = await application.firstWindow();
  if (process.env.TBLINK_MA2_TEST_HIDDEN) await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.hide(); });
  try {
    await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [file] }); }, path);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await expect(page.getByText('素材界面验收', { exact: true })).toBeVisible();
    await page.evaluate(() => localStorage.setItem('tblink.ma2-connection-method.v1', 'network'));
    await application.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('link:ma2-network-status');
      ipcMain.handle('link:ma2-network-status', () => ({ state: 'disconnected', settings: null, passwordSaved: false, version: null, error: null }));
    });
    await page.reload();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
    await page.screenshot({ path: info.outputPath('workbench-before-materials.png') });
    await writeFile(info.outputPath('workbench-before-materials.html'), await page.content());
    await page.getByRole('button', { name: '素材管理', exact: true }).click();
    await page.getByRole('navigation', { name: '素材管理子菜单' }).getByRole('button', { name: '分类管理', exact: true }).click();
    await expect(page.getByLabel('分类名称 1')).toBeVisible();
    await page.screenshot({ path: info.outputPath('empty-material-categories.png') });
    await page.getByRole('button', { name: '读取控台', exact: true }).click();
    const panel = page.getByRole('region', { name: '读取控台效果库' });
    await expect(panel).toContainText('2hao · 584 项');
    await expect(panel.getByRole('heading')).toHaveCount(0);
    await expect(page.locator('.workbench-panel-heading')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('console-materials.png') });
    const height = await panel.locator('.effect-import-rows').evaluate(element => element.clientHeight);
    expect(height).toBeGreaterThan(180);
    await expect(page.locator('.ma2-material-dialog')).toHaveCount(0);
    await panel.getByRole('button', { name: '关闭素材窗口' }).click();
    await expect(panel).toHaveCount(0);
    await page.getByRole('button', { name: '读取控台', exact: true }).click();
    await expect(panel).toContainText('584 项');
    await panel.getByLabel('全选筛选结果').check();
    await panel.getByRole('button', { name: '加入素材库', exact: false }).click();
    await expect(page.locator('.lighting-effect-card')).toHaveCount(584);
    await page.screenshot({ path: info.outputPath('cue-library.png') });
    const navigation = page.getByRole('navigation', { name: '灯光子菜单' });
    for (const [name, image] of [['素材管理', 'material-manager'], ['导入 / 导出', 'file-actions'], ['MA2 同步', 'ma2-sync']] as const) {
      await navigation.getByRole('button', { name, exact: true }).click();
      if (name === '素材管理') {
        await page.getByRole('navigation', { name: '素材管理子菜单' }).getByRole('button', { name: '全部素材', exact: true }).click();
        await expect(page.getByLabel('搜索管理素材')).toBeVisible();
        await expect(page.locator('.material-preferences').getByRole('navigation', { name: '素材管理子菜单' })).toBeVisible();
        await page.getByRole('button', { name: '网格视图', exact: true }).click();
        await expect(page.locator('.material-cue-tile')).toHaveCount(584);
        await page.screenshot({ path: info.outputPath('material-grid.png') });
        await page.getByRole('button', { name: '列表视图', exact: true }).click();
      }
      if (name === 'MA2 同步') await expect(page.getByLabel('读取 MA2 Timecode 编号')).toBeVisible();
      await expect(page.locator('.workbench-panel-heading')).toHaveCount(0);
      await page.screenshot({ path: info.outputPath(`${image}.png`) });
    }
    await navigation.getByText('播放设置', { exact: true }).click();
    await expect(page.getByLabel('选中 Cue 实时播放')).toBeVisible();
    await page.screenshot({ path: info.outputPath('playback-settings.png') });
  } finally {
    if (!page.isClosed()) await page.evaluate(() => window.tbLink.setDocumentDirty(false));
    if (application.process().exitCode === null) await application.close();
  }
});
