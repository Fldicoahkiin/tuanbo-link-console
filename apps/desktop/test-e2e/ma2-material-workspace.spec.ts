import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect, _electron as electron } from '@playwright/test';
import { createEmptyLinkProject, createLightingDocument, ma2EffectLibrarySchema } from '@tb/schema';

const snapshot = join(process.cwd(), '../../artifacts/ma2-hardware-diagnostics/effect-library.json');

test('现场 584 个 Cue 在原工作区内可查看、关闭恢复并一次入库', async ({}, info) => {
  test.skip(!existsSync(snapshot), '需要此前实机读取的只读素材快照');
  const library = ma2EffectLibrarySchema.parse(JSON.parse(await readFile(snapshot, 'utf8')));
  expect(library.sequences.flatMap(sequence => sequence.cues)).toHaveLength(584);
  const project = createEmptyLinkProject('素材界面验收');
  project.schemaVersion = 2;
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
    await page.evaluate(value => localStorage.setItem('tblink.ma2.material-cache.v1', JSON.stringify(value)), {
      source: { dataDirectory: '', network: { host: '2.97.214.223', port: 30000, monitorPort: 30001, username: 'administrator' } }, library
    });
    await page.reload();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
    await page.getByRole('button', { name: '读取控台', exact: true }).click();
    const panel = page.getByRole('region', { name: '读取控台效果库' });
    await expect(panel).toContainText('上次读取 · 2hao · 267 条序列 · 584 个 Cue');
    const height = await panel.locator('.effect-import-rows').evaluate(element => element.clientHeight);
    expect(height).toBeGreaterThan(180);
    await expect(page.locator('.ma2-material-dialog')).toHaveCount(0);
    await panel.getByRole('button', { name: '关闭素材窗口' }).click();
    await expect(panel).toHaveCount(0);
    await page.getByRole('button', { name: '读取控台', exact: true }).click();
    await expect(panel).toContainText('584 个 Cue');
    await panel.getByLabel('全选筛选结果').check();
    await panel.getByRole('button', { name: '加入素材库', exact: false }).click();
    await expect(page.locator('.lighting-effect-card')).toHaveCount(584);
    await expect(page.locator('.lighting-effect-card').first()).toContainText('待绑定');
  } finally {
    if (!page.isClosed()) await page.evaluate(() => window.tbLink.setDocumentDirty(false));
    if (application.process().exitCode === null) await application.close();
  }
});
