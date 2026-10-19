import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect, _electron as electron } from '@playwright/test';
import { createEmptyLinkProject, createLightingDocument, ma2EffectLibrarySchema, parseLinkProject } from '@tb/schema';

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
      ipcMain.removeHandler('link:ma2-catalog'); ipcMain.handle('link:ma2-catalog', () => ({ directory: { show: '构造素材 Show', generation: 'test', version: '3.7.0.5', entries: [] }, readAt: new Date().toISOString(), entries: [] }));
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
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('navigation', { name: '设置子子菜单' }).getByRole('button', { name: 'MA2 控台', exact: true }).click();
    await page.getByRole('button', { name: '读取 Cue', exact: true }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
    await expect(page.getByRole('button', { name: '试听序列 36 灯光步 1.100', exact: true })).toBeVisible();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '节目单', exact: true }).click();
    await expect.poll(async () => (JSON.parse(await readFile(file, 'utf8')) as { ma2MaterialLibrary?: { library: { sequences: unknown[]; sourceUnverified?: boolean } } }).ma2MaterialLibrary?.library.sequences.length).toBe(2);
    expect(await app.evaluate(() => process.env.TBLINK_MATERIAL_READS)).toBe('1');
    await page.evaluate(() => window.tbLink.setDocumentDirty(false)); await app.close();
    app = await launch(); page = await app.firstWindow();
    await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('link:ma2-effect-library'); ipcMain.handle('link:ma2-effect-library', () => { throw new Error('重开不能自动扫描'); }); });
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
    await expect(page.getByLabel('素材序列', { exact: true })).toHaveAttribute('data-total-cues', '2');
    await expect(page.getByRole('button', { name: '试听序列 36 灯光步 1.100', exact: true })).toBeVisible();
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
    const pool = page.getByLabel('素材序列', { exact: true });
    await expect(pool).toHaveAttribute('data-total-cues', '584');
    expect(await pool.locator('.console-cue-cell').count()).toBeLessThan(584);
    const first = pool.getByRole('button').first();
    await first.click({ modifiers: ['Control'] });
    await pool.getByRole('button').nth(1).click({ modifiers: ['Control'] });
    await page.getByRole('button', { name: '全选结果', exact: true }).click();
    await expect(page.getByText('已选 584 项', { exact: true })).toBeVisible();
    await first.click({ button: 'right' });
    const menu = page.getByRole('dialog', { name: 'Cue 右键菜单' });
    await menu.getByRole('button', { name: '效果', exact: true }).click();
    await menu.getByRole('button', { name: '归入 效果 重击', exact: true }).click();
    await menu.getByRole('button', { name: '确定', exact: true }).click();
    await expect.poll(async () => parseLinkProject(JSON.parse(await readFile(path, 'utf8'))).ma2MaterialLibrary?.userLibrary?.entries.length).toBe(584);
    await page.keyboard.press('Control+z');
    await expect.poll(async () => parseLinkProject(JSON.parse(await readFile(path, 'utf8'))).ma2MaterialLibrary?.userLibrary?.entries.length ?? 0).toBe(0);
    await page.keyboard.press('Control+Shift+z');
    await expect.poll(async () => parseLinkProject(JSON.parse(await readFile(path, 'utf8'))).ma2MaterialLibrary?.userLibrary?.entries.length).toBe(584);
    expect(parseLinkProject(JSON.parse(await readFile(path, 'utf8'))).ma2MaterialLibrary?.library).toEqual(library);
    await page.screenshot({ path: info.outputPath('classified-console-materials.png') });
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '节目单', exact: true }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
    await expect(pool).toHaveAttribute('data-total-cues', '584');
    await page.reload();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
    await expect(pool).toHaveAttribute('data-total-cues', '584');
    await pool.getByRole('button').first().focus(); await page.keyboard.press('End');
    await expect(pool.locator('[data-cue-cell="583"] button')).toBeFocused();
    await expect(pool.locator('[data-cue-cell="583"] button')).toBeInViewport();
    expect(await pool.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('material-restored-bottom.png') });
  } finally {
    if (!page.isClosed()) await page.evaluate(() => window.tbLink.setDocumentDirty(false));
    if (application.process().exitCode === null) await application.close();
  }
});
