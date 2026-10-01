import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect, _electron as electron } from '@playwright/test';
import { createEmptyLinkProject, createLightingDocument } from '@tb/schema';

test('界面样本：单步分类点击出灯，多步进入原编号子菜单，继续由控台执行', async ({}, info) => {
  const project = createEmptyLinkProject('灯光素材分类界面样本');
  project.schemaVersion = 2;
  const lighting = createLightingDocument();
  lighting.ma2Library = { show: '界面布局样本（非现场读取）', readAt: '2026-09-26T00:00:00.000Z', sequences: Array.from({ length: 36 }, (_, index) => ({ sequence: index + 1, name: index % 2 ? `原名称 dance-${index + 1}` : `单步灯光 ${index + 1}`, cues: Array.from({ length: index % 2 ? 8 : 1 }, (_, step) => ({ index: step, number: `${step + 1}.000`, name: `原步骤 ${step + 1}` })) })) };
  project.rundown = [{ id: 'sample', title: '界面样本节目', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [], lighting }];
  const file = info.outputPath('library.tblink');
  await writeFile(file, JSON.stringify(project));
  const executable = process.env.TBLINK_MA2_PACKAGED_EXE;
  const application = await electron.launch({ ...(executable ? { executablePath: executable } : {}), args: [`--user-data-dir=${info.outputPath('profile')}`, ...executable ? [] : [join(process.cwd(), 'out/main/index.cjs')]] });
  const page = await application.firstWindow();
  try {
    await application.evaluate(({ ipcMain, dialog }, path) => {
      process.env.TBLINK_LIBRARY_CALLS = '[]';
      ipcMain.removeHandler('link:ma2-network-status');
      ipcMain.handle('link:ma2-network-status', () => ({ settings: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test', autoConnect: false }, state: 'connected', version: '3.7.0.5', passwordSaved: false, error: null }));
      ipcMain.removeHandler('link:ma2-play-cue');
      ipcMain.handle('link:ma2-play-cue', (_event, payload: unknown) => { const calls = JSON.parse(process.env.TBLINK_LIBRARY_CALLS ?? '[]') as unknown[]; calls.push(payload); process.env.TBLINK_LIBRARY_CALLS = JSON.stringify(calls); });
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] });
    }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
    await page.getByRole('button', { name: '控台灯光素材库', exact: true }).click();
    const preview = page.getByRole('region', { name: 'MA2 序列预览' });
    const pool = preview.getByRole('navigation', { name: '素材序列' });
    await expect(pool.getByRole('button')).toHaveCount(36);
    await page.screenshot({ path: info.outputPath('classified-pool.png') });
    await preview.getByRole('button', { name: '单步灯光', exact: true }).click();
    await expect(pool.getByRole('button')).toHaveCount(18);
    await pool.getByRole('button').first().click();
    await expect(preview.getByRole('status')).toContainText('已发送调用灯光步 1.000');
    await preview.getByRole('button', { name: '返回素材分类', exact: true }).click();
    await preview.getByRole('button', { name: '多步序列', exact: true }).click();
    await expect(pool.getByRole('button')).toHaveCount(18);
    await pool.getByRole('button').first().click();
    expect(JSON.parse(await application.evaluate(() => process.env.TBLINK_LIBRARY_CALLS ?? '[]')) as unknown[]).toHaveLength(1);
    await expect(preview.getByText('多步序列子菜单', { exact: true })).toBeVisible();
    await expect(preview.locator('.ma2-cue-submenu > button')).toHaveCount(8);
    await preview.getByRole('button', { name: '试听灯光步 3.000', exact: true }).click();
    await expect(preview.getByRole('status')).toContainText('已发送调用灯光步 3.000');
    await preview.getByRole('button', { name: '继续', exact: true }).click();
    await expect(preview.getByRole('status')).toContainText('已发送继续播放');
    const calls = JSON.parse(await application.evaluate(() => process.env.TBLINK_LIBRARY_CALLS ?? '[]')) as { action: unknown }[];
    expect(calls.map(call => call.action)).toEqual([{ target: 'sequence', sequence: 1, action: 'goto', cue: '1.000' }, { target: 'sequence', sequence: 2, action: 'goto', cue: '3.000' }, { target: 'sequence', sequence: 2, action: 'go' }]);
    await page.screenshot({ path: info.outputPath('multi-step-submenu.png') });
  } finally {
    if (!page.isClosed()) await page.evaluate(() => window.tbLink.setDocumentDirty(false));
    if (application.process().exitCode === null) await application.close();
  }
});

