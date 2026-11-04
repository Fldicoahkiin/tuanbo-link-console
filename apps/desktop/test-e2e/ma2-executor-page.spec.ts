import { test, expect } from '@playwright/test';
import type { Ma2ExecutorPage, Ma2ExecutorUpdateRequest } from '@tb/schema';
import { launchExecutorFixture } from './ma2-executor-fixture';

test('三层执行器保留原格位和独立页码，翻页不播放，紧凑工具栏无竖推杆', async ({}, info) => {
  test.setTimeout(90000);
  const { app, page, pool, errors } = await launchExecutorFixture(info);
  try {
    const view = page.getByRole('region', { name: '控台执行器页面', exact: true });
    const upper = view.locator('[data-executor-band="upper"]');
    const fader = view.locator('[data-executor-band="fader"]');
    const lower = view.locator('[data-executor-band="lower"]');
    await expect(upper.getByRole('button', { name: '执行器 4.101 · xws', exact: true })).toBeVisible();
    await expect(fader.getByRole('button', { name: '执行器 100.1 · 面光_Long_Sequence_Name', exact: true })).toBeVisible();
    await expect(lower.getByRole('button', { name: '执行器 100.101 · 摇头', exact: true })).toBeVisible();
    await expect(upper.locator('[data-executor-slot]')).toHaveCount(89);
    await expect(fader.locator('[data-executor-slot]')).toHaveCount(15);
    await expect(lower.locator('[data-executor-slot]')).toHaveCount(15);
    await expect(upper.locator('[data-executor-slot="103"]')).toHaveCSS('grid-column-end', 'span 2');
    await expect(upper.locator('[data-executor-slot="104"]')).toHaveCount(0);
    await expect(upper.locator('[data-executor-slot="105"]')).toHaveAttribute('data-empty', 'true');
    await expect(view.locator('input[type="range"]')).toHaveCount(0);
    await expect(view.getByRole('button', { name: '连接实时推杆', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('上层按钮页码', { exact: true })).toHaveValue('4');
    await expect(page.getByLabel('中层执行器页码', { exact: true })).toHaveValue('100');
    await expect(page.getByLabel('下层按钮页码', { exact: true })).toHaveValue('100');
    await page.screenshot({ path: info.outputPath('executor-three-bands.png') });
    await page.getByLabel('上层按钮范围', { exact: true }).selectOption('191');
    await expect(upper.getByRole('button', { name: '执行器 4.219 · 前区', exact: true })).toBeVisible();
    await page.getByLabel('上层按钮范围', { exact: true }).selectOption('101');
    await page.getByLabel('中层执行器范围', { exact: true }).selectOption('16');
    await expect(fader.getByRole('button', { name: '执行器 100.16 · 轮廓', exact: true })).toBeVisible();
    await page.getByLabel('中层执行器范围', { exact: true }).selectOption('1');
    await upper.getByRole('button', { name: '执行器 4.103 · 定点', exact: true }).click({ button: 'right' });
    await page.getByRole('menu', { name: '执行器右键菜单', exact: true }).getByRole('menuitem', { name: '编辑步骤', exact: true }).click();
    await expect(pool.getByLabel('序列中的单步灯光')).toHaveAttribute('data-total-cues', '4');
    await pool.getByRole('button', { name: 'Cue 控台位置', exact: true }).click();
    const locations = page.getByRole('dialog', { name: 'Cue 控台位置列表', exact: true });
    await expect(locations.getByRole('button', { name: '按钮第 4 页 · 103 格', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(locations).toHaveCount(0);
    await pool.getByRole('button', { name: '返回页面', exact: true }).click();
    await expect(upper.getByRole('button', { name: '执行器 4.103 · 定点', exact: true })).toBeVisible();

    await page.getByLabel('上层按钮页码', { exact: true }).fill('5'); await page.getByLabel('上层按钮页码', { exact: true }).press('Enter');
    await expect(upper.getByRole('button', { name: '执行器 5.101 · 蓝色', exact: true })).toBeVisible();
    await expect(page.getByLabel('中层执行器页码', { exact: true })).toHaveValue('100');
    await expect(page.getByLabel('下层按钮页码', { exact: true })).toHaveValue('100');
    await page.getByLabel('中层执行器页码', { exact: true }).fill('101'); await page.getByLabel('中层执行器页码', { exact: true }).press('Enter');
    await expect(fader.getByRole('button', { name: '执行器 101.1 · 双色', exact: true })).toBeVisible();
    await expect(lower.getByRole('button', { name: '执行器 100.101 · 摇头', exact: true })).toBeVisible();
    await page.getByLabel('下层按钮页码', { exact: true }).fill('1000'); await page.getByLabel('下层按钮页码', { exact: true }).press('Enter');
    await expect(lower.getByRole('button', { name: '执行器 1000.101 · xws', exact: true })).toBeVisible();
    await expect(page.getByLabel('上层按钮页码', { exact: true })).toHaveValue('5');
    await expect(page.getByLabel('中层执行器页码', { exact: true })).toHaveValue('101');
    expect(await app.evaluate(() => process.env.TBLINK_EXECUTOR_ACTIONS)).toBe('[]');
    expect(await app.evaluate(() => process.env.TBLINK_EXECUTOR_INPUTS)).toBe('[]');
    expect(await app.evaluate(() => process.env.TBLINK_EXECUTOR_LIVE_CALLS)).toBe('0');

    for (const [width, height] of [[1180, 780], [1920, 1080]]) {
      await app.evaluate(({ BrowserWindow }, dimensions) => BrowserWindow.getAllWindows()[0]!.setSize(dimensions.width, dimensions.height), { width: width!, height: height! });
      expect(await page.locator('.app-shell').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      const toolbar = pool.locator('.ma2-material-menubar');
      expect((await toolbar.boundingBox())!.height).toBeLessThanOrEqual(36);
      for (const band of [upper, fader, lower]) {
        const bounds = (await band.boundingBox())!;
        expect(bounds.width).toBeGreaterThan(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width!);
        expect(await band.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      }
      const scrollArea = view.locator('.ma2-executor-surface');
      const geometry = await scrollArea.evaluate(element => ({
        height: element.clientHeight, content: element.scrollHeight,
        overflow: getComputedStyle(element).overflowY
      }));
      expect(geometry.content).toBeLessThanOrEqual(geometry.height + 1);
      for (const label of ['上层按钮页码', '中层执行器页码', '下层按钮页码']) {
        await page.getByLabel(label, { exact: true }).scrollIntoViewIfNeeded();
        await expect(page.getByLabel(label, { exact: true })).toBeInViewport();
      }
      await scrollArea.evaluate(element => { element.scrollTop = 0; });
      await page.screenshot({ path: info.outputPath(`executor-three-bands-${width}.png`) });
    }
    await page.getByLabel('上层按钮页码', { exact: true }).fill('4'); await page.getByLabel('上层按钮页码', { exact: true }).press('Enter');
    await page.getByLabel('中层执行器页码', { exact: true }).fill('100'); await page.getByLabel('中层执行器页码', { exact: true }).press('Enter');
    await page.getByLabel('下层按钮页码', { exact: true }).fill('100'); await page.getByLabel('下层按钮页码', { exact: true }).press('Enter');
    await app.evaluate(() => { process.env.TBLINK_EXECUTOR_DENSE = 'true'; });
    await expect(upper.locator('[data-empty="false"]')).toHaveCount(72);
    for (const [width, height] of [[1600, 1000], [1180, 780], [1920, 1080]]) {
      await app.evaluate(({ BrowserWindow }, dimensions) => BrowserWindow.getAllWindows()[0]!.setSize(dimensions.width, dimensions.height), { width: width!, height: height! });
      const surface = view.locator('.ma2-executor-surface');
      await expect.poll(() => surface.evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath(`executor-fixture-filled-${width}.png`) });
    }
    const splitter = page.getByRole('separator', { name: '调整效果库和时间线高度', exact: true });
    await splitter.focus(); await splitter.press('ArrowUp');
    await expect(splitter).toHaveAttribute('aria-valuenow', '65');
    await pool.getByRole('button', { name: '单步', exact: true }).click();
    await pool.getByRole('button', { name: '控台页面', exact: true }).click();
    await expect(splitter).toHaveAttribute('aria-valuenow', '65');
    expect(errors).toEqual([]);
  } finally { await page.evaluate(() => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null })); await app.close(); }
});

test('执行器重命名、拖到空格和删除均按回读结果刷新，底层序列保留', async ({}, info) => {
  test.setTimeout(90000);
  const { app, page, pool, errors } = await launchExecutorFixture(info);
  try {
    const upper = page.locator('[data-executor-band="upper"]');
    const original = upper.getByRole('button', { name: '执行器 4.101 · xws', exact: true });
    await expect(original).toBeVisible();
    const position = await original.boundingBox();
    await original.click({ button: 'right' });
    const menu = page.getByRole('menu', { name: '执行器右键菜单', exact: true });
    await expect(menu.getByRole('menuitem', { name: '编辑步骤', exact: true })).toBeVisible();
    expect(await original.boundingBox()).toEqual(position);
    await menu.getByRole('menuitem', { name: '重命名', exact: true }).click();
    await page.getByLabel('执行器名称', { exact: true }).fill('电脑改名');
    await app.evaluate(() => { process.env.TBLINK_EXECUTOR_HOLD_UPDATE = 'true'; });
    await page.getByRole('button', { name: '保存名称', exact: true }).click();
    await expect.poll(async () => JSON.parse(await app.evaluate(() => process.env.TBLINK_EXECUTOR_UPDATES ?? '[]')) as unknown[]).toHaveLength(1);
    await expect(original).toBeVisible();
    await expect(upper.getByRole('button', { name: '执行器 4.101 · 电脑改名', exact: true })).toHaveCount(0);
    await app.evaluate(() => { delete process.env.TBLINK_EXECUTOR_HOLD_UPDATE; });
    const renamed = upper.getByRole('button', { name: '执行器 4.101 · 电脑改名', exact: true });
    await expect(renamed).toBeVisible();
    const destination = upper.locator('[data-executor-slot="105"]');
    await renamed.dragTo(destination);
    await expect(upper.getByRole('button', { name: '执行器 4.105 · 电脑改名', exact: true })).toBeVisible();
    await expect(upper.locator('[data-executor-slot="101"]')).toHaveAttribute('data-empty', 'true');
    const moved = upper.getByRole('button', { name: '执行器 4.105 · 电脑改名', exact: true });
    await moved.click({ button: 'right' });
    await menu.getByRole('menuitem', { name: '删除执行器', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: '删除执行器', exact: true });
    await expect(confirmation).toContainText('4 页 · 105 格');
    await expect(confirmation).toContainText('电脑改名');
    await confirmation.getByRole('button', { name: '删除执行器', exact: true }).click();
    await expect(upper.locator('[data-executor-slot="105"]')).toHaveAttribute('data-empty', 'true');
    const requests = JSON.parse(await app.evaluate(() => process.env.TBLINK_EXECUTOR_UPDATES ?? '[]')) as Ma2ExecutorUpdateRequest[];
    expect(requests.map(value => value.action)).toEqual([{ kind: 'rename', name: '电脑改名' }, { kind: 'move', page: 4, slot: 105 }, { kind: 'delete' }]);
    expect(requests.map(value => [value.page, value.slot])).toEqual([[4, 101], [4, 101], [4, 105]]);
    expect(await app.evaluate(() => process.env.TBLINK_EXECUTOR_INPUTS)).toBe('[]');
    const pages = JSON.parse(await app.evaluate(() => process.env.TBLINK_EXECUTOR_SERVER_PAGES ?? '{}')) as Record<number, Ma2ExecutorPage>;
    expect(pages[4]!.sequences.some(value => value.sequence === 79)).toBe(true);
    await pool.getByRole('button', { name: '多步', exact: true }).click();
    expect(errors).toEqual([]);
  } finally { await page.evaluate(() => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null })); await app.close(); }
});

test('一层读取异常保留其它层与换页操作，恢复后继续回读', async ({}, info) => {
  test.setTimeout(90000);
  const { app, page, errors } = await launchExecutorFixture(info);
  try {
    const upper = page.locator('[data-executor-band="upper"]');
    const fader = page.locator('[data-executor-band="fader"]');
    await expect(upper.getByRole('button', { name: '执行器 4.101 · xws', exact: true })).toBeVisible();
    await app.evaluate(() => { process.env.TBLINK_EXECUTOR_READ_FAILURE = '4'; });
    await expect(upper.getByRole('button', { name: '等待控台确认', exact: true })).toHaveAttribute('title', /此页暂未读回/);
    await expect(fader.getByRole('button', { name: '执行器 100.1 · 面光_Long_Sequence_Name', exact: true })).toBeVisible();
    await page.getByLabel('上层按钮页码', { exact: true }).fill('5'); await page.getByLabel('上层按钮页码', { exact: true }).press('Enter');
    await expect(upper.getByRole('button', { name: '执行器 5.101 · 蓝色', exact: true })).toBeVisible();
    await expect(page.getByLabel('中层执行器页码', { exact: true })).toHaveValue('100');
    await expect(page.getByLabel('下层按钮页码', { exact: true })).toHaveValue('100');
    await app.evaluate(() => { delete process.env.TBLINK_EXECUTOR_READ_FAILURE; process.env.TBLINK_EXECUTOR_REMOTE_NAME = '恢复后控台改名'; });
    await expect(fader.getByRole('button', { name: '执行器 100.1 · 恢复后控台改名', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await page.evaluate(() => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null })); await app.close(); }
});
