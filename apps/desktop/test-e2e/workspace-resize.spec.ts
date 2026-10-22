import { test, expect, _electron as electron } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { closeDiscarding } from './save-questions';

test('编辑器分区自由调整并恢复实际尺寸', async ({}, info) => {
  const file = info.outputPath('resize.tblink');
  await writeFile(file, JSON.stringify(parseLinkProject({ ...createEmptyLinkProject('分区调整'), playbackSource: 'internal', rundown: [{ id: 'one', title: '节目', cues: [] }] })));
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')] });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow, dialog }, path) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1920, 1080);
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] });
    }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    const nav = page.getByRole('navigation', { name: '主要工作区' });
    await nav.getByRole('button', { name: '编辑器', exact: true }).click();
    const drag = async (label: string, dx: number, dy: number): Promise<void> => {
      const box = (await page.getByRole('button', { name: label, exact: true }).boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 12 });
      await page.mouse.up();
    };
    await drag('调整属性面板宽度', -470, 0);
    const width = (await page.locator('.cue-inspector').boundingBox())!.width;
    expect(width).toBeGreaterThan(700);
    await drag('调整时间线高度', 0, -310);
    const preview = (await page.locator('.editor-preview-row').boundingBox())!.height;
    const total = (await page.locator('.timeline-workbench').boundingBox())!.height;
    expect(preview).toBeLessThan(total * .4);
    await page.screenshot({ path: info.outputPath('expanded-timeline.png') });
    await nav.getByRole('button', { name: '节目单', exact: true }).click();
    await nav.getByRole('button', { name: '编辑器', exact: true }).click();
    expect(Math.abs((await page.locator('.cue-inspector').boundingBox())!.width - width)).toBeLessThan(2);
    expect(Math.abs((await page.locator('.editor-preview-row').boundingBox())!.height - preview)).toBeLessThan(2);
    await drag('调整属性面板宽度', 570, 0);
    await drag('调整时间线高度', 0, 420);
    expect((await page.locator('.cue-inspector').boundingBox())!.width).toBeLessThan(300);
    await page.screenshot({ path: info.outputPath('expanded-preview.png') });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1180, 720));
    expect(await page.locator('.timeline-workbench').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.getByRole('button', { name: '调整属性面板宽度', exact: true }).focus();
    await page.keyboard.press('ArrowLeft');
    expect(await page.locator('body').evaluate(element => element.classList.contains('is-resizing-workspace'))).toBe(false);
  } finally { await closeDiscarding(app); }
});
