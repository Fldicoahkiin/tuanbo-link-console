import { test, expect, _electron as electron } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';

test('统一控件连续输入、组合输入、弹窗提交与焦点恢复', async ({}, info) => {
  const project = parseLinkProject({ ...createEmptyLinkProject('输入验收'), playbackSource: 'internal',
    rundown: [{ id: 'input-program', title: '原节目', cues: [] }] });
  const file = info.outputPath('input.tblink');
  await writeFile(file, JSON.stringify(project));
  const executablePath = process.env.TBLINK_E2E_EXECUTABLE;
  const app = await electron.launch({ ...(executablePath ? { executablePath } : {}),
    args: [`--user-data-dir=${info.outputPath('profile')}`, ...(executablePath ? [] : [join(process.cwd(), 'out/main/index.cjs')])] });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    const name = page.getByLabel('节目名称', { exact: true });
    await name.fill('');
    for (const char of 'Jinhe 2026 中文节目') {
      await name.pressSequentially(char);
      await expect(name).toBeFocused();
    }
    await name.dispatchEvent('compositionstart');
    await name.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true });
    await expect(name).toBeFocused();
    await expect(page.locator('.home-card > strong')).toHaveText('原节目');
    await name.dispatchEvent('compositionend');
    await name.press('Enter');
    await expect(page.locator('.home-card > strong')).toHaveText('Jinhe 2026 中文节目');
    const create = page.getByRole('button', { name: '新建播放列表', exact: true });
    await create.click();
    const dialog = page.getByRole('dialog', { name: '新建播放列表', exact: true });
    const listName = dialog.getByLabel('列表名称', { exact: true });
    await listName.pressSequentially('Live 2026');
    await expect(listName).toHaveValue('Live 2026');
    await listName.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(create).toBeFocused();
    await expect(page.getByRole('button', { name: 'Live 2026', exact: false })).toBeVisible();
    await create.click();
    await page.keyboard.press('Shift+Tab');
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
    await page.screenshot({ path: info.outputPath('playlist-modal.png') });
    await page.keyboard.press('Escape');
    await expect(create).toBeFocused();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
    await page.getByText('手动连接', { exact: true }).click();
    const address = page.getByLabel('WebSocket 地址', { exact: true });
    await address.fill('');
    await address.pressSequentially('ws://127.0.0.1:4455', { delay: 20 });
    await expect(address).toHaveValue('ws://127.0.0.1:4455');
    await expect(address).toBeFocused();
    await page.screenshot({ path: info.outputPath('focused-settings-input.png') });
    expect(errors).toEqual([]);
  } finally {
    await (await app.firstWindow()).evaluate(() => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null }));
    await app.close();
  }
});
