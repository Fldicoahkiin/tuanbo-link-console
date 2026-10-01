import { test, expect, _electron as electron } from '@playwright/test';
import { join } from 'node:path';

test('顶部四项只显示连接状态，详细切回完整连接列表且不切工作区', async ({}, info) => {
  const executablePath = process.env.TBLINK_PACKAGED_APP_EXE;
  const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [`--user-data-dir=${info.outputPath('profile')}`, ...(executablePath ? [] : [join(process.cwd(), 'out/main/index.cjs')])] });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '新建工程', exact: true }).waitFor();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1180, 720));
    const overview = page.getByRole('group', { name: '连接状态概览' });
    await expect(overview.locator('.connection-overview-item')).toHaveCount(4);
    for (const name of ['音频', '视频', '灯光', '编辑灯光']) await expect(overview.getByText(name, { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('connection-overview.png') });
    await expect(page.locator('.app-shell')).toHaveAttribute('data-workspace', 'project');
    const details = page.getByRole('button', { name: '详细', exact: true });
    await details.click();
    await expect(details).toHaveAttribute('aria-pressed', 'true');
    await expect(overview).toHaveCount(0);
    await expect(page.locator('.topbar-connection-status .toolbar-connections')).toBeVisible();
    await expect(page.getByRole('button', { name: /OBS 控制/ })).toBeVisible();
    await page.screenshot({ path: info.outputPath('connection-details.png') });
    await expect(page.locator('.app-shell')).toHaveAttribute('data-workspace', 'project');
    await details.click();
    await expect(details).toHaveAttribute('aria-pressed', 'false');
    await expect(overview).toBeVisible();
  } finally { await app.close(); }
});
