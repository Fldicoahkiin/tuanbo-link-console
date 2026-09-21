import { test, expect, _electron as electron } from '@playwright/test';
import { join } from 'node:path';

test('两个联动台实例保留不同的原生音频窗口标题，页面标题更新不能覆盖', async ({}, info) => {
  const first = await electron.launch({ args: [`--user-data-dir=${info.outputPath('first')}`, join(process.cwd(), 'out/main/index.cjs')] });
  try {
    const second = await electron.launch({ args: [`--user-data-dir=${info.outputPath('second')}`, join(process.cwd(), 'out/main/index.cjs')] });
    try {
      const page = await first.firstWindow();
      await second.firstWindow();
      const title = await first.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getTitle());
      const other = await second.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getTitle());
      expect(title).toMatch(/^团播联动台 \/ Tuanbo Link Console · \d+$/);
      expect(title).not.toBe(other);
      await page.evaluate(() => { document.title = '另一个页面标题'; });
      await expect.poll(() => first.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getTitle())).toBe('另一个页面标题');
      expect(await first.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getTitle())).toBe(title);
    } finally { await second.close(); }
  } finally { await first.close(); }
});
