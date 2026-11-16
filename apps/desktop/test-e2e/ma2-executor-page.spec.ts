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
    await expect(upper.getByRole('button', { name: '读取失败，点击刷新', exact: true })).toHaveAttribute('title', /此页暂未读回/);
    await expect(fader.getByRole('button', { name: '执行器 100.1 · 面光_Long_Sequence_Name', exact: true })).toBeVisible();
    await page.getByLabel('上层按钮页码', { exact: true }).fill('5'); await page.getByLabel('上层按钮页码', { exact: true }).press('Enter');
    await expect(upper.getByRole('button', { name: '执行器 5.101 · 蓝色', exact: true })).toBeVisible();
    await expect(page.getByLabel('中层执行器页码', { exact: true })).toHaveValue('100');
    await expect(page.getByLabel('下层按钮页码', { exact: true })).toHaveValue('100');
    await app.evaluate(() => { delete process.env.TBLINK_EXECUTOR_READ_FAILURE; process.env.TBLINK_EXECUTOR_REMOTE_NAME = '恢复后控台改名'; });
    await expect(fader.getByRole('button', { name: '执行器 100.1 · 恢复后控台改名', exact: true })).toBeVisible();
    await app.evaluate(() => { process.env.TBLINK_EXECUTOR_MISSING_PAGE = '100'; });
    await expect(fader.getByText('此页尚未创建', { exact: true })).toBeVisible();
    await expect(fader.getByRole('button', { name: /执行器 100\.1 ·/ })).toHaveCount(0);
    await expect(page.getByLabel('中层执行器页码', { exact: true })).toHaveValue('100');
    expect(await app.evaluate(() => process.env.TBLINK_EXECUTOR_ACTIONS)).toBe('[]');
    expect(await app.evaluate(() => process.env.TBLINK_EXECUTOR_INPUTS)).toBe('[]');
    await page.screenshot({ path: info.outputPath('executor-missing-page.png') });
    expect(errors).toEqual([]);
  } finally { await page.evaluate(() => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null })); await app.close(); }
});


test('控台时间线切换保持顶部工具栏位置，显示完整目录并支持右键修改', async ({}, info) => {
  const { app, page, pool, errors } = await launchExecutorFixture(info, true);
  try {
    const tab = pool.getByRole('button', { name: '控台时间线', exact: true });
    await expect(tab).toBeVisible();
    const toolbar = pool.locator('.ma2-material-menubar');
    const before = await toolbar.boundingBox(); const buttonBefore = await tab.boundingBox();
    await tab.click();
    await expect(tab).toHaveAttribute('aria-pressed', 'true');
    const browser = pool.getByRole('region', { name: '控台时间线与歌曲', exact: true });
    await expect(browser).toContainText('当前节目尚未关联时间线');
    await expect(browser.getByRole('option')).toHaveCount(0);
    await browser.getByRole('button', { name: '关联已有时间线', exact: true }).click();
    await expect(browser.getByRole('option')).toHaveCount(2);
    expect(await toolbar.boundingBox()).toEqual(before); expect(await tab.boundingBox()).toEqual(buttonBefore);
    await browser.getByRole('option', { name: 'Timecode 902 · 未读取时间线', exact: true }).click();
    await expect(browser).toContainText('尚未读取 Cue');
    await browser.getByRole('option', { name: 'Timecode 901 · 已读取时间线', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '修改名称 / MTC', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '修改时间线', exact: true });
    await expect(dialog.getByLabel('时间线名称', { exact: true })).toHaveValue('已读取时间线');
    await expect(dialog.getByLabel('MTC 起始码', { exact: true })).toHaveValue('00:01:00:00');
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.screenshot({ path: info.outputPath('timeline-integrated.png') });
    await expect(page.getByText('试听设置', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('switch', { name: '选中 Cue 实时播放', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '控台布局 / 新建 Cue', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '导入 / 导出', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '灯光', exact: true }).click();
    await page.getByRole('menuitem', { name: '导入与导出', exact: true }).click();
    const fileTools = page.getByRole('region', { name: '导入与导出', exact: true });
    await expect(fileTools.getByRole('button', { name: '导入灯光', exact: true })).toBeVisible();
    await expect(fileTools.getByRole('button', { name: '导出 MIDI', exact: true })).toBeVisible();
    await expect(browser).toHaveCount(0);
    await fileTools.getByRole('button', { name: '关闭灯光工具', exact: true }).click();
    await pool.getByRole('button', { name: '控台页面', exact: true }).click();
    await pool.getByRole('button', { name: '新建 Cue', exact: true }).click();
    await expect(page.getByRole('complementary', { name: '控台 Layout', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '关闭 Layout', exact: true }).click();

    await pool.getByRole('button', { name: '多步', exact: true }).click();
    await expect(browser).toHaveCount(0); expect(await toolbar.boundingBox()).toEqual(before);
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
    await page.getByRole('navigation', { name: '设置子子菜单' }).getByRole('button', { name: 'MA2 控台', exact: true }).click();
    const audition = page.getByRole('switch', { name: '时间线选中 Cue 试听', exact: true });
    await expect(audition).toBeChecked();
    await audition.uncheck();
    expect(await page.evaluate(() => localStorage.getItem('tblink.audition-timeline-cue'))).toBe('false');
    await audition.check();
    expect(errors).toEqual([]);
  } finally { await page.evaluate(() => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null })); await app.close(); }
});


test('150 条控台时间线使用紧凑列表，列表滚动不移动工具栏和右侧操作区', async ({}, info) => {
  const { app, page, pool, errors } = await launchExecutorFixture(info, 150);
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 800));
    await pool.getByRole('button', { name: '控台时间线', exact: true }).click();
    const browser = pool.getByRole('region', { name: '控台时间线与歌曲', exact: true });
    await browser.getByRole('button', { name: '关联已有时间线', exact: true }).click();
    await expect(browser.getByRole('option')).toHaveCount(150);
    await browser.getByRole('option').first().click();
    await browser.getByRole('option').first().press('ArrowDown');
    await expect(browser.getByRole('option').nth(1)).toBeFocused();
    await expect(browser.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
    const panel = browser.getByRole('complementary', { name: '所选时间线', exact: true });
    const toolbar = pool.locator('.ma2-material-menubar');
    const panelBefore = await panel.boundingBox(), toolbarBefore = await toolbar.boundingBox();
    expect((await browser.getByRole('option').first().boundingBox())!.height).toBeLessThanOrEqual(36);
    const scroll = browser.locator('.ma2-timeline-list-scroll');
    expect(await scroll.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(browser.getByRole('option').last()).toBeInViewport();
    expect(await panel.boundingBox()).toEqual(panelBefore);
    expect(await toolbar.boundingBox()).toEqual(toolbarBefore);
    await browser.getByRole('option').last().click();
    await expect(panel).toContainText('Timecode 1050');
    await page.screenshot({ path: info.outputPath('timeline-150-fixed-panel.png') });
    await pool.getByPlaceholder('搜索名称 / 编号').fill('1050');
    await expect(browser.getByRole('option')).toHaveCount(1);
    await browser.getByRole('button', { name: '返回当前节目', exact: true }).click();
    await expect(browser).toContainText('当前节目尚未关联时间线');
    await expect(pool.getByPlaceholder('搜索名称 / 编号')).toHaveValue('');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await page.evaluate(() => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null })); await app.close(); }
});
