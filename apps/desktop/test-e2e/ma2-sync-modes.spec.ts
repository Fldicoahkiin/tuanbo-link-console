import { test, expect, _electron as electron } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject } from '@tb/schema';
import { closeDiscarding } from './save-questions';
import { importMa2TimecodeCommand } from '@tb/core/link';
import { convertMa2Timecode } from '../src/main/link/ma2-timecode-conversion';

test('灯光工作台里选同步方式：写入方式三选一、控台改动读回或以联动台为准，关掉实时同步后点“同步一次”（2026-11-04）', async ({}, info) => {
  const lighting = createLightingDocument();
  const project = parseLinkProject({ ...createEmptyLinkProject('同步方式'), schemaVersion: 2,
    rundown: [{ id: 'song', title: '歌曲', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting }] });
  const file = info.outputPath('modes.tblink'); await writeFile(file, JSON.stringify(project));
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')] });
  const page = await app.firstWindow();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
    const sync = page.getByRole('region', { name: '灯光同步操作' });
    const modes = sync.getByRole('button', { name: '同步方式', exact: true });
    await expect(modes).toHaveAttribute('title', '同步方式：合并 · 读回控台改动');
    await modes.click();
    const panel = page.getByRole('dialog', { name: '同步方式' });
    const write = panel.getByRole('radiogroup', { name: '写入控台' });
    await expect(write.getByRole('radio', { name: /合并/ })).toBeChecked();
    // Overwriting deletes Cues on the console, so it asks first; 取消 keeps merging.
    await write.getByRole('radio', { name: /覆盖/ }).check();
    await expect(panel.getByText('覆盖会删掉控台上的 Cue')).toBeVisible();
    await panel.getByRole('button', { name: '取消', exact: true }).click();
    await expect(write.getByRole('radio', { name: /合并/ })).toBeChecked();
    await write.getByRole('radio', { name: /覆盖/ }).check();
    await panel.getByRole('button', { name: '改成覆盖', exact: true }).click();
    await expect(write.getByRole('radio', { name: /覆盖/ })).toBeChecked();
    await panel.getByRole('radiogroup', { name: '控台上的改动' }).getByRole('radio', { name: /以联动台为准/ }).check();
    await expect(modes).toHaveAttribute('title', '同步方式：覆盖 · 以联动台为准');
    await page.screenshot({ path: info.outputPath('sync-modes.png') });
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);

    await sync.getByRole('switch', { name: '实时同步', exact: true }).click();
    await expect(sync.getByRole('button', { name: '同步一次', exact: true })).toBeVisible();
    await expect(sync.getByRole('button', { name: '刷新同步', exact: true })).toHaveCount(0);
    await sync.getByRole('button', { name: '同步状态详情' }).click();
    await expect(page.getByRole('dialog', { name: '同步状态详情' })).toContainText('实时同步已关');
    expect(errors).toEqual([]);
  } finally { await closeDiscarding(app); }
});

test('工作台实际同步状态从正在同步到已同步，后台读回期间保留确认结果', async ({}, info) => {
  const xml = await readFile(join(process.cwd(), 'src/main/link/fixtures/ma2-timecode-fractional-3.3.xml'), 'utf8');
  const sequence = await readFile(join(process.cwd(), 'src/main/link/fixtures/ma2-sequence-fractional-3.3.xml'), 'utf8');
  const preview = convertMa2Timecode(xml, [sequence], 9902);
  const library = { directory: { show: '验证', generation: 'fixture', version: '3.3.4', entries: [] }, readAt: preview.readAt, sequences: [], fixtureUsage: [], errors: [] };
  const project = parseLinkProject({ ...createEmptyLinkProject('侧栏确认'), schemaVersion: 2, ma2MaterialLibrary: { version: 1, source: '192.0.2.1:30000', library }, rundown: [{ id: 'song', title: '歌曲', cues: [] }] });
  const file = info.outputPath('sync.tblink');
  await writeFile(file, JSON.stringify(importMa2TimecodeCommand('song', preview).execute(project)));
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')] });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog, ipcMain }, data) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [data.file] });
      ipcMain.removeHandler('link:ma2-network-status');
      ipcMain.handle('link:ma2-network-status', () => ({ state: 'connected', settings: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test', autoConnect: true }, version: '3.3.4', passwordSaved: false, error: null }));
      ipcMain.removeHandler('link:ma2-effect-library');
      ipcMain.handle('link:ma2-effect-library', () => data.library);
      ipcMain.removeHandler('link:ma2-preview');
      ipcMain.handle('link:ma2-preview', async () => {
        process.env.TBLINK_SIDEBAR_READS = String(Number(process.env.TBLINK_SIDEBAR_READS ?? 0) + 1);
        await new Promise<void>(resolve => ipcMain.once('test:release-sidebar-read', () => resolve()));
        return data.preview;
      });
    }, { file, library, preview });
    await page.evaluate(() => localStorage.setItem('tblink.ma2-connection-method.v1', 'network'));
    await page.reload();
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
    const badge = page.getByRole('button', { name: '同步状态详情', exact: true });
    const reads = () => app.evaluate(() => Number(process.env.TBLINK_SIDEBAR_READS ?? 0));
    await expect.poll(reads).toBe(1);
    await expect(badge).toContainText('正在同步');
    await app.evaluate(({ ipcMain }) => ipcMain.emit('test:release-sidebar-read'));
    await expect(badge).toContainText('已同步');
    await expect.poll(reads).toBe(2);
    await expect(badge).toContainText('已同步');
    await app.evaluate(({ ipcMain }) => ipcMain.emit('test:release-sidebar-read'));
    await badge.click();
    await expect(page.getByRole('dialog', { name: '同步状态详情' })).toContainText('1 首歌都和控台一致');
  } finally { await closeDiscarding(app); }
});
