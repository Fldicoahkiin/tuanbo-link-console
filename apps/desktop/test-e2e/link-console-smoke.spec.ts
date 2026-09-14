import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject, type LightingTrack } from '@tb/schema';
import { createDefaultIntegrationProfile } from '../src/renderer/src/link/view-models/local-integration-profile';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { exportLightingMidi, materialSceneNames } from '@tb/core/link';
import { promisify } from 'node:util';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import ffmpegPath from 'ffmpeg-static';
import { convertMa2Snapshot } from '../src/main/link/ma2-timecode-conversion';
import { createMa2TimecodeXml } from '../src/main/link/ma2-create';

const execFileAsync = promisify(execFile);
const desktopEntry = join(process.cwd(), process.env.TBLINK_E2E_BUILD_DIR ?? 'out', 'main/index.cjs');

async function displayedLightingEventCount(): Promise<number> {
  return page.locator('.lighting-timeline-point').evaluateAll((elements) => elements.reduce((total, element) => total + 1 + Number(element.querySelector('small')?.textContent?.replace('+', '') ?? 0), 0));
}


async function closeLightingTools(): Promise<void> {
  const close = page.getByRole('button', { name: '关闭灯光工具', exact: true });
  if (await close.isVisible()) await close.click();
}
async function openLightingTools(name: '节目同步' | '节拍与循环' | '导入与导出'): Promise<void> {
  await closeLightingTools();
  await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
  await page.locator('.timeline-lighting-tools > summary').click();
  await page.locator('.timeline-lighting-tools').getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('dialog', { name, exact: true })).toBeVisible();
}
async function openLightingTrack(): Promise<void> {
  await closeLightingTools();
  await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
  await page.locator('.lighting-track-name').first().click();
}

test('32 轨十万事件只渲染可见灯光点，滚动后可选中远处 Cue', async () => {
  await beginNewProject();
  await page.getByLabel('工程名称').fill('灯光密集编排');
  await page.getByRole('button', { name: '创建工程' }).click();
  await addEmptyProgram();
  const main = page.getByRole('navigation', { name: '主要工作区' });
  await closeLightingTools(); await main.getByRole('button', { name: '设置', exact: true }).click();
  await openLightingTools('导入与导出');
  const document = createLightingDocument();
  document.tracks = Array.from({ length: 32 }, (_, index): LightingTrack => ({ id: `track-${index}`, name: `轨道 ${index}`, kind: 'ma2', color: '#abcdef', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: `clip-${index}`, name: '密集编排', start: 0, duration: 3125000, timeLock: 'time', muted: false, events: Array.from({ length: 3125 }, (_, point) => ({ id: `event-${index}-${point}`, kind: 'ma2', at: point * 1000, label: `点 ${index}-${point}`, cue: String(point + 1), sequence: 1, executor: '1.1', action: 'goto' })) }] }));
  await page.locator('.settings-lighting input[type="file"]').setInputFiles({ name: 'scale.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(document)) });
  await page.getByRole('button', { name: '确认导入', exact: true }).click();
  await closeLightingTools(); await main.getByRole('button', { name: '编辑器', exact: true }).click();
  await expect(page.locator('.lighting-lane')).toHaveCount(33);
  const points = page.locator('.lighting-timeline-point');
  await expect.poll(() => points.count()).toBeGreaterThan(0);
  expect(await points.count()).toBeLessThan(2000);
  const oldLabel = await points.first().getAttribute('aria-label');
  await page.locator('.timeline-viewport').evaluate((element) => { element.scrollLeft = 32000; });
  await expect.poll(() => points.first().getAttribute('aria-label')).not.toBe(oldLabel);
  expect(await points.count()).toBeLessThan(2000);
  const target = points.filter({ hasText: '点 0-1001' }).first();
  await target.click();
  await expect(page.getByLabel('Cue 名称', { exact: true })).toHaveValue('点 0-1001');
  await expect(page.getByLabel('灯光点歌曲时间')).toHaveValue('1001');
  await page.getByRole('button', { name: '适合节目时长', exact: true }).click();
  await expect.poll(() => points.count()).toBeLessThan(15000);
  const grouped = points.filter({ has: page.locator('small') }).first();
  await expect(grouped).toBeVisible();
  await grouped.click({ button: 'right' });
  const choice = page.getByRole('button', { name: '选中：点 0-0', exact: true });
  await choice.click();
  await expect(page.getByLabel('Cue 名称', { exact: true })).toHaveValue('点 0-0');
  await expect(page.getByLabel('灯光点歌曲时间')).toHaveValue('0');
});

test('灯光多选整体移动保持间距，批量删除只需一次撤销', async () => {
  await beginNewProject();
  await page.getByLabel('工程名称').fill('灯光多选验收');
  await page.getByRole('button', { name: '创建工程' }).click();
  await addEmptyProgram();
  await closeLightingTools(); await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
  const clip = page.locator('.lighting-clip').first();
  await clip.dblclick({ position: { x: 64, y: 30 } });
  await clip.dblclick({ position: { x: 160, y: 30 } });
  const points = page.locator('.lighting-timeline-point');
  await expect(points).toHaveCount(2);
  await points.first().click();
  await points.last().click({ modifiers: ['Control'] });
  await expect(page.locator('.lighting-timeline-point.selected')).toHaveCount(2);
  const before = await points.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().x));
  const target = await points.first().boundingBox();
  if (!target) throw new Error('灯光点位置不可用');
  await page.mouse.move(target.x + 4, target.y + 8);
  await page.mouse.down();
  await page.mouse.move(target.x + 68, target.y + 8, { steps: 6 });
  await page.mouse.up();
  const after = await points.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().x));
  expect(after[0]! - before[0]!).toBeCloseTo(64, 0);
  expect(after[1]! - before[1]!).toBeCloseTo(64, 0);
  await page.getByTitle('删除选中内容（Delete）').click();
  await expect(points).toHaveCount(0);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(points).toHaveCount(2);
  await points.first().click();
  await page.keyboard.press('Control+a');
  await page.locator('.reference-timeline').press('Home');
  await points.first().click({ button: 'right' });
  await expect(page.locator('.lighting-timeline-point.selected')).toHaveCount(2);
  await page.getByRole('button', { name: '复制 2 个点到播放头', exact: true }).click();
  await expect(points).toHaveCount(4);
  const duplicates = page.locator('.lighting-timeline-point.selected');
  await expect(duplicates).toHaveCount(2);
  const copyPositions = await duplicates.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().x));
  expect(copyPositions[1]! - copyPositions[0]!).toBeCloseTo(after[1]! - after[0]!, 0);
  expect(copyPositions[0]).toBeLessThan(after[0]!);
  await duplicates.first().click({ button: 'right' });
  await page.getByRole('button', { name: '删除 2 个灯光点', exact: true }).click();
  await expect(points).toHaveCount(2);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(points).toHaveCount(4);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(points).toHaveCount(2);
  await points.first().click();
  await page.keyboard.press('Control+a');
  await expect(page.locator('.lighting-timeline-point.selected')).toHaveCount(2);
  await page.keyboard.press('Delete');
  await expect(points).toHaveCount(0);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(points).toHaveCount(2);
  await clip.click({ position: { x: 20, y: 50 } });
  const clipBounds = await clip.boundingBox();
  if (!clipBounds) throw new Error('灯光片段位置不可用');
  await page.mouse.move(clipBounds.x + 100, clipBounds.y + 50);
  await page.mouse.down();
  await page.mouse.move(clipBounds.x + 250, clipBounds.y + 50, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('.lighting-timeline-point.selected')).toHaveCount(2);
  await expect(page.locator('.lighting-marquee')).toHaveCount(0);
  await expect(page.getByText('已选 2 个灯光点', { exact: true })).toBeVisible();
  await page.getByLabel('灯光批量时间偏移').fill('1.5');
  await page.getByLabel('灯光批量时间偏移').press('Tab');
  const shifted = await points.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().x));
  expect(shifted[0]! - after[0]!).toBeCloseTo(48, 0);
  expect(shifted[1]! - after[1]!).toBeCloseTo(48, 0);
  await page.getByLabel('批量执行器').fill('2.5');
  await page.getByLabel('批量执行器').press('Tab');
  await clip.click({ position: { x: 20, y: 50 } });
  await points.first().click();
  await expect(page.getByLabel('执行器', { exact: true })).toHaveValue('2.5');
  await points.last().click();
  await expect(page.getByLabel('执行器', { exact: true })).toHaveValue('2.5');
  await page.keyboard.press('Control+a');
  await page.getByRole('button', { name: '删除选中灯光点', exact: true }).click();
  await expect(points).toHaveCount(0);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(points).toHaveCount(2);
});

test('灯光剪贴板跨节目粘贴、剪切撤销和轨道锁定保持正确', async ({}, testInfo) => {
  await beginNewProject();
  await page.getByLabel('工程名称').fill('灯光剪贴板验收');
  await page.getByRole('button', { name: '创建工程' }).click();
  await addEmptyProgram();
  const navigation = page.getByRole('navigation', { name: '主要工作区' });
  await closeLightingTools(); await navigation.getByRole('button', { name: '编辑器', exact: true }).click();
  let clip = page.locator('.lighting-clip').first();
  const points = page.locator('.lighting-timeline-point');
  await clip.dblclick({ position: { x: 64, y: 30 } });
  await clip.dblclick({ position: { x: 160, y: 30 } });
  await page.keyboard.press('Control+a');
  await page.getByLabel('批量执行器').fill('2.5');
  await page.getByLabel('批量执行器').press('Tab');
  await points.first().click();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+x');
  await expect(points).toHaveCount(0);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(points).toHaveCount(2);
  await closeLightingTools(); await navigation.getByRole('button', { name: '节目单', exact: true }).click();
  await addEmptyProgram();
  await closeLightingTools(); await navigation.getByRole('button', { name: '编辑器', exact: true }).click();
  clip = page.locator('.lighting-clip').first();
  await expect(points).toHaveCount(0);
  await clip.click({ position: { x: 96, y: 50 } });
  await page.locator('.reference-timeline').press('Control+v');
  await expect(points).toHaveCount(2);
  await expect(page.locator('.lighting-timeline-point.selected')).toHaveCount(2);
  const positions = await points.evaluateAll((elements) => elements.map((element) => Number.parseFloat((element as HTMLElement).style.left)));
  expect(positions[0]).toBeCloseTo(96, 0);
  expect(positions[1]).toBeCloseTo(192, 0);
  await points.first().click();
  await expect(page.getByLabel('执行器', { exact: true })).toHaveValue('2.5');
  await page.keyboard.press('Control+a');
  await page.getByRole('button', { name: '灯光锁定', exact: true }).click();
  await page.locator('.reference-timeline').press('Control+x');
  await expect(points).toHaveCount(2);
  await page.locator('.reference-timeline').press('Control+v');
  await expect(points).toHaveCount(2);
  await points.first().click({ button: 'right' });
  await expect(page.getByRole('button', { name: /粘贴到这里/ })).toBeDisabled();
  await page.getByRole('button', { name: /复制灯光点 Ctrl/ }).click();
  await page.getByRole('button', { name: '灯光锁定', exact: true }).click();
  await clip.click({ position: { x: 256, y: 50 } });
  await clip.click({ button: 'right', position: { x: 256, y: 50 } });
  await page.getByRole('button', { name: /粘贴到这里/ }).click();
  await expect(points).toHaveCount(4);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(points).toHaveCount(2);
  const destination = testInfo.outputPath('clipboard.tblink');
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath }); }, destination);
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  await expect.poll(async () => JSON.parse(await readFile(destination, 'utf8')) as unknown).toMatchObject({ rundown: [{ lighting: { tracks: [{ clips: [{ events: [{ executor: '2.5' }, { executor: '2.5' }] }] }] } }, { lighting: { tracks: [{ clips: [{ events: [{ at: 3000, executor: '2.5' }, { at: 6000, executor: '2.5' }] }] }] } }] });
  await page.reload();
  await closeLightingTools(); await navigation.getByRole('button', { name: '编辑器', exact: true }).click();
  await expect(points).toHaveCount(2);
});

test('新建 MA2 Timecode 关联当前节目并保存，失败不产生虚假绑定', async ({}, testInfo) => {
  await beginNewProject();
  await page.getByLabel('工程名称').fill('新建 Timecode');
  await page.getByRole('button', { name: '创建工程' }).click();
  await addEmptyProgram();
  await closeLightingTools(); await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
  await page.getByLabel('MA2 连接方式').selectOption('local');
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
  await page.getByLabel('MA2 onPC 数据目录').fill('C:\\MA2-Test');
  await openLightingTools('节目同步');
  await page.getByLabel('读取 MA2 Timecode 编号').fill('9903');
  const preview = convertMa2Snapshot(createMa2TimecodeXml(9903, '节目 1', '3.3.4.3'), 9903);
  await application.evaluate(({ ipcMain }) => { ipcMain.removeHandler('link:ma2-create'); ipcMain.handle('link:ma2-create', () => { throw new Error('Timecode already exists'); }); });
  await page.getByRole('button', { name: '创建并关联当前节目', exact: true }).click();
  await expect(page.getByText('创建未确认，请读取目标编号检查；不会自动重试', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'MA2 灯光读取预览' })).toHaveCount(0);
  await application.evaluate(({ ipcMain }, result) => { ipcMain.removeHandler('link:ma2-create'); ipcMain.handle('link:ma2-create', (_event, input: { target: number; name: string }) => { if (input.target !== 9903 || input.name !== '节目 1') throw new Error('创建目标不一致'); return result; }); }, preview);
  await page.getByRole('button', { name: '创建并关联当前节目', exact: true }).click();
  await expect(page.getByText('Timecode 9903 已创建并关联当前节目', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '创建并关联当前节目', exact: true })).toBeDisabled();
  const destination = testInfo.outputPath('created-timecode.tblink');
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath }); }, destination);
  await page.keyboard.press('Control+s');
  await expect.poll(() => existsSync(destination)).toBe(true);
  await expect.poll(async () => parseLinkProject(JSON.parse(await readFile(destination, 'utf8'))).rundown[0]!.lighting).toMatchObject({ tracks: [{ kind: 'ma2', name: '灯光' }], ma2Bindings: [{ timecode: 9903, baselineTracks: [] }] });
  await page.keyboard.press('Control+z');
  await expect(page.getByRole('button', { name: '创建并关联当前节目', exact: true })).toBeEnabled();
  await page.keyboard.press('Control+y');
  await expect(page.getByRole('button', { name: '创建并关联当前节目', exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('created-timecode.png') });
  await page.getByLabel('关联 MA2 的节目轨道').selectOption({ index: 1 });
  await page.getByLabel('读取执行器地址').fill('99.219');
  await application.evaluate(({ ipcMain }) => { ipcMain.removeHandler('link:ma2-executor'); ipcMain.handle('link:ma2-executor', () => { throw new Error('执行器不存在'); }); });
  await page.getByRole('button', { name: '读取执行器', exact: true }).click();
  await expect(page.getByRole('button', { name: '关联轨道', exact: true })).toBeDisabled();
  await expect(page.getByText(/执行器不存在/)).toBeVisible();
  await application.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('link:ma2-executor');
    ipcMain.handle('link:ma2-executor', (_event, input: { target: number; executor: string }) => {
      if (input.target !== 9903 || input.executor !== '99.219') throw new Error('执行器读取目标错误');
      return { target: 9903, executor: '99.219', executorName: '灯光执行器 99.219', assignmentName: '灯光序列 9901', readAt: new Date().toISOString(), cueCatalog: [{ sequence: 9901, name: '灯光', cues: [{ index: 1, number: '1.250', name: '开场' }] }] };
    });
  });
  await page.getByRole('button', { name: '读取执行器', exact: true }).click();
  await expect(page.getByLabel('关联 MA2 的执行器')).toHaveValue('99.219');
  await expect(page.locator('.ma2-track-binding')).toContainText('序列 9901 · 1 个 Cue');
  await page.getByRole('button', { name: '关联轨道', exact: true }).click();
  await page.keyboard.press('Control+s');
  await expect.poll(() => existsSync(destination)).toBe(true);
  await expect.poll(async () => parseLinkProject(JSON.parse(await readFile(destination, 'utf8'))).rundown[0]!.lighting!.ma2Bindings![0]!.pendingTracks).toMatchObject([{ executor: '99.219', sequence: 9901, executorName: '灯光执行器 99.219' }]);
  await closeLightingTools(); await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
  await page.locator('.lighting-track-name').first().click();
  await page.keyboard.press('m');
  await expect(page.getByLabel('Cue 编号', { exact: true })).toHaveValue('1.250');
});

test('节目轨道可明确关联 MA2、取消和撤销，并保存待同步绑定', async ({}, testInfo) => {
  await beginNewProject();
  await page.getByLabel('工程名称').fill('新增轨道关联');
  await page.getByRole('button', { name: '创建工程' }).click();
  await addEmptyProgram();
  const navigation = page.getByRole('navigation', { name: '主要工作区' });
  await closeLightingTools(); await navigation.getByRole('button', { name: '编辑器', exact: true }).click();
  await page.locator('.lighting-clip').first().dblclick({ position: { x: 64, y: 30 } });
  await page.locator('.lighting-timeline-point').first().click();
  await page.keyboard.press('Delete');
  await expect(page.locator('.lighting-timeline-point')).toHaveCount(0);
  const xml = await readFile(join(process.cwd(), 'src/main/link/fixtures/ma2-timecode-fractional-3.3.xml'), 'utf8');
  const seq = await readFile(join(process.cwd(), 'src/main/link/fixtures/ma2-sequence-fractional-3.3.xml'), 'utf8');
  const sequenceObject = seq.match(/<Sequ\s[\s\S]*?<\/Sequ>/)?.[0];
  if (!sequenceObject) throw new Error('测试序列缺失');
  const preview = convertMa2Snapshot(xml.replace('</MA>', `${sequenceObject}</MA>`), 9902);
  await application.evaluate(({ ipcMain }, result) => { ipcMain.removeHandler('link:ma2-preview'); ipcMain.handle('link:ma2-preview', () => result); }, preview);
  await closeLightingTools(); await navigation.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
  await page.getByLabel('MA2 连接方式').selectOption('local');
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
  await page.getByLabel('MA2 onPC 数据目录').fill('C:\\MA2-Test');
  await openLightingTools('节目同步');
  await page.getByLabel('读取 MA2 Timecode 编号').fill('9902');
  await page.getByRole('button', { name: '读取灯光编排', exact: true }).click();
  await page.getByRole('button', { name: '加入当前节目', exact: true }).click();
  await page.getByRole('button', { name: '读取灯光编排', exact: true }).click();
  await page.getByLabel('关联 MA2 的节目轨道').selectOption({ index: 1 });
  await page.getByLabel('关联 MA2 的执行器').selectOption('99.219');
  await page.getByRole('button', { name: '关联轨道', exact: true }).click();
  await expect(page.locator('.ma2-pending-track')).toHaveCount(1);
  await page.getByRole('button', { name: '取消关联', exact: true }).click();
  await expect(page.locator('.ma2-pending-track')).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(page.locator('.ma2-pending-track')).toHaveCount(1);
  await page.getByRole('button', { name: '比较节目与控台修改', exact: true }).click();
  await expect(page.getByRole('region', { name: '节目与控台差异' })).toContainText('没有冲突');
  const destination = testInfo.outputPath('pending-track.tblink');
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath }); }, destination);
  await page.keyboard.press('Control+s');
  await expect.poll(() => existsSync(destination)).toBe(true);
  await expect.poll(async () => parseLinkProject(JSON.parse(await readFile(destination, 'utf8'))).rundown[0]!.lighting!.ma2Bindings![0]!.pendingTracks).toMatchObject([{ executor: '99.219' }]);
  await page.screenshot({ path: testInfo.outputPath('ma2-track-binding.png') });
  await closeLightingTools(); await navigation.getByRole('button', { name: '编辑器', exact: true }).click();
  await page.locator('.lighting-track-name').first().click();
  await closeLightingTools(); await navigation.getByRole('button', { name: '设置', exact: true }).click();
  await openLightingTrack();
  await page.getByLabel('灯光打点方式').selectOption('fixed');
  await expect(page.getByLabel('固定 Cue 编号')).toHaveValue('1.250');
  await expect(page.getByLabel('固定 Cue 序列')).toHaveValue('9901');
  await expect(page.getByLabel('固定 Cue 执行器')).toHaveValue('99.219');
  await closeLightingTools(); await navigation.getByRole('button', { name: '编辑器', exact: true }).click();
  await page.locator('.lighting-track-name').first().click();
  await page.keyboard.press('m');
  await expect(page.getByLabel('Cue 编号', { exact: true })).toHaveValue('1.250');
  await page.keyboard.press('Control+s');
  await expect.poll(async () => parseLinkProject(JSON.parse(await readFile(destination, 'utf8'))).rundown[0]!.lighting!.tracks[0]!.cueStamp).toEqual({ mode: 'fixed', cue: '1.250', sequence: 9901, executor: '99.219' });
});

test('MA2 读取预览加入节目、撤销和保存基线完整，未支持事件禁止部分导入', async ({}, testInfo) => {
  await beginNewProject();
  await page.getByLabel('工程名称').fill('MA2 预览验收');
  await page.getByRole('button', { name: '创建工程' }).click();
  await addEmptyProgram();
  const navigation = page.getByRole('navigation', { name: '主要工作区' });
  await closeLightingTools(); await navigation.getByRole('button', { name: '编辑器', exact: true }).click();
  await page.locator('.lighting-clip').first().dblclick({ position: { x: 64, y: 30 } });
  const xml = await readFile(join(process.cwd(), 'src/main/link/fixtures/ma2-timecode-fractional-3.3.xml'), 'utf8');
  const seq = await readFile(join(process.cwd(), 'src/main/link/fixtures/ma2-sequence-fractional-3.3.xml'), 'utf8');
  const sequenceObject = seq.match(/<Sequ\s[\s\S]*?<\/Sequ>/)?.[0];
  if (!sequenceObject) throw new Error('测试序列缺失');
  const preview = convertMa2Snapshot(xml.replace('</MA>', `${sequenceObject}</MA>`), 9902);
  await application.evaluate(({ ipcMain }, result) => {
    ipcMain.removeHandler('link:ma2-preview');
    ipcMain.handle('link:ma2-preview', () => ({ ...result, unconverted: [{ path: 'Event:3', reason: '推杆事件尚未转换' }] }));
  }, preview);
  await closeLightingTools(); await navigation.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
  await page.getByLabel('MA2 连接方式').selectOption('local');
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
  await page.getByLabel('MA2 onPC 数据目录').fill('C:\\MA2-Test');
  await openLightingTools('节目同步');
  await page.getByLabel('读取 MA2 Timecode 编号').fill('9902');
  await page.getByRole('button', { name: '读取灯光编排', exact: true }).click();
  const region = page.getByRole('region', { name: 'MA2 灯光读取预览' });
  await expect(region.getByRole('cell', { name: '7.500', exact: true })).toBeVisible();
  await expect(region.getByRole('button', { name: '加入当前节目', exact: true })).toBeDisabled();
  await expect(region.getByText(/推杆事件尚未转换/)).toBeVisible();
  await application.evaluate(({ ipcMain }, result) => { ipcMain.removeHandler('link:ma2-preview'); ipcMain.handle('link:ma2-preview', () => result); }, preview);
  await page.getByRole('button', { name: '读取灯光编排', exact: true }).click();
  await expect(region.getByRole('button', { name: '加入当前节目', exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('ma2-preview.png') });
  await region.getByRole('button', { name: '加入当前节目', exact: true }).click();
  await closeLightingTools(); await navigation.getByRole('button', { name: '编辑器', exact: true }).click();
  await expect.poll(displayedLightingEventCount).toBe(3);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('.lighting-timeline-point')).toHaveCount(1);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(displayedLightingEventCount).toBe(3);
  await page.getByRole('button', { name: '灯光点 Cue 1.25', exact: true }).click();
  await page.keyboard.press('m');
  await expect.poll(displayedLightingEventCount).toBe(4);
  await expect(page.getByLabel('Cue 编号', { exact: true })).toHaveValue('7.500');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(displayedLightingEventCount).toBe(3);
  await page.getByRole('button', { name: '灯光点 Cue 7.5', exact: true }).click();
  await page.getByLabel('灯光点歌曲时间').fill('2');
  await page.getByLabel('灯光点歌曲时间').press('Tab');
  const changedReadback = structuredClone(preview);
  changedReadback.sourceXml = changedReadback.sourceXml.replace('time="45"', 'time="75"');
  changedReadback.document.tracks[0]!.clips[0]!.duration = 3000;
  changedReadback.document.tracks[0]!.clips[0]!.events[1]!.at = 2500;
  await application.evaluate(({ ipcMain }, result) => { ipcMain.removeHandler('link:ma2-preview'); ipcMain.handle('link:ma2-preview', () => result); }, changedReadback);
  await closeLightingTools(); await navigation.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
  await expect(page.getByLabel('MA2 onPC 数据目录')).toHaveValue('C:\\MA2-Test');
  await openLightingTools('节目同步');
  await page.getByLabel('读取 MA2 Timecode 编号').fill('9902');
  await page.getByRole('button', { name: '读取灯光编排', exact: true }).click();
  await expect(region.getByRole('button', { name: '加入当前节目', exact: true })).toBeDisabled();
  const destination = testInfo.outputPath('ma2-preview.tblink');
  await expect(region.getByRole('status')).toContainText('已对应 2 个点');
  await region.getByRole('button', { name: '比较节目与控台修改', exact: true }).click();
  const difference = page.getByRole('region', { name: '节目与控台差异' });
  await expect(difference).toContainText('1 处冲突');
  await expect(difference).toContainText('1.500 秒');
  await expect(difference).toContainText('2.000 秒');
  await expect(difference).toContainText('2.500 秒');
  await expect(difference.getByRole('button', { name: '同步节目与 MA2', exact: true })).toBeDisabled();
  await page.getByLabel('冲突 1 保留版本').selectOption('remote');
  await expect(difference.getByRole('status')).toHaveText('合并检查通过 · 尚未应用');
  await page.screenshot({ path: testInfo.outputPath('ma2-conflict.png') });
  await application.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('link:ma2-apply');
    ipcMain.handle('link:ma2-apply', () => ({ status: 'incomplete', stage: 'write', message: '验收：写入超时', mayHaveWritten: true, backupFile: null }));
  });
  await difference.getByRole('button', { name: '同步节目与 MA2', exact: true }).click();
  await expect(page.getByText('同步未完成 · 控台可能已写入，请重新读取', { exact: true })).toBeVisible();
  await region.getByRole('button', { name: '比较节目与控台修改', exact: true }).click();
  await expect(difference).toContainText('1.500 秒');
  await expect(difference).toContainText('2.000 秒');
  await page.getByLabel('冲突 1 保留版本').selectOption('remote');
  await application.evaluate(({ ipcMain }, confirmed) => {
    ipcMain.removeHandler('link:ma2-apply');
    ipcMain.handle('link:ma2-apply', () => ({ status: 'verified', confirmed, backupFile: 'tblink_backup_test.xml' }));
  }, changedReadback);
  await difference.getByRole('button', { name: '同步节目与 MA2', exact: true }).click();
  await expect(page.getByText(/节目与 Timecode 9902 已同步并核对/)).toBeVisible();
  await closeLightingTools(); await navigation.getByRole('button', { name: '编辑器', exact: true }).click();
  await page.getByRole('button', { name: '灯光点 Cue 7.5', exact: true }).click();
  await expect(page.getByLabel('灯光点歌曲时间')).toHaveValue('2.5');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByLabel('灯光点歌曲时间')).toHaveValue('2');
  await page.getByLabel('灯光点歌曲时间').fill('2.017');
  await page.getByLabel('灯光点歌曲时间').press('Tab');
  await closeLightingTools(); await navigation.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
  await openLightingTools('节目同步');
  await page.getByLabel('读取 MA2 Timecode 编号').fill('9902');
  await page.getByRole('button', { name: '读取灯光编排', exact: true }).click();
  await region.getByRole('button', { name: '比较节目与控台修改', exact: true }).click();
  await page.getByLabel('冲突 1 保留版本').selectOption('local');
  await expect(difference).toContainText('1 个点将对齐到最近帧');
  await expect(difference).toContainText('最大偏移 16.333 毫秒');
  await expect(difference.getByRole('cell', { name: '2.033', exact: true })).toBeVisible();
  const aligned = structuredClone(preview);
  aligned.sourceXml = aligned.sourceXml.replace('time="45"', 'time="61"');
  aligned.document.tracks[0]!.clips[0]!.duration = 3000;
  aligned.document.tracks[0]!.clips[0]!.events[1]!.at = 61000 / 30;
  await application.evaluate(({ ipcMain }, confirmed) => {
    ipcMain.removeHandler('link:ma2-apply'); ipcMain.handle('link:ma2-apply', (_event, request: { timeAlignment?: string }) => {
      if (request.timeAlignment !== 'nearest-frame') throw new Error('未提交已预览的对齐方式');
      return { status: 'verified', confirmed, backupFile: 'tblink_backup_test.xml' };
    });
  }, aligned);
  await difference.getByRole('button', { name: '同步节目与 MA2', exact: true }).click();
  await closeLightingTools(); await navigation.getByRole('button', { name: '编辑器', exact: true }).click();
  await page.getByRole('button', { name: '灯光点 Cue 7.5', exact: true }).click();
  await expect(page.getByLabel('灯光点歌曲时间')).toHaveValue('2.033333');
  await page.getByLabel('灯光点歌曲时间').focus();
  await page.getByLabel('灯光点歌曲时间').press('Tab');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByLabel('灯光点歌曲时间')).toHaveValue('2.017');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByLabel('灯光点歌曲时间')).toHaveValue('2');
  await closeLightingTools(); await navigation.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
  await openLightingTools('节目同步');
  await page.getByLabel('读取 MA2 Timecode 编号').fill('9902');
  const deletedReadback = structuredClone(preview);
  deletedReadback.document.tracks[0]!.clips[0]!.events.pop();
  deletedReadback.mappings.pop();
  await application.evaluate(({ ipcMain }, result) => { ipcMain.removeHandler('link:ma2-preview'); ipcMain.handle('link:ma2-preview', () => result); }, deletedReadback);
  await page.getByRole('button', { name: '读取灯光编排', exact: true }).click();
  await expect(region.getByRole('status')).toContainText('控台删除 1 个');
  await expect(region.getByText('1.500 秒 · Cue 7.500 · Cue 7.5', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('ma2-readback-comparison.png') });
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath }); }, destination);
  await page.keyboard.press('Control+s');
  await expect.poll(() => existsSync(destination)).toBe(true);
  await expect.poll(async () => JSON.parse(await readFile(destination, 'utf8')) as unknown).toMatchObject({ schemaVersion: 2, rundown: [{ lighting: { ma2Bindings: [{ timecode: 9902, mappings: [{ cueIndex: 1 }, { cueIndex: 2 }] }] } }] });
  await page.reload();
  await closeLightingTools(); await navigation.getByRole('button', { name: '编辑器', exact: true }).click();
  await expect.poll(displayedLightingEventCount).toBe(3);
});

test('MA2 重复 Cue 可逐点确认对应，重新读取清除旧选择', async ({}, testInfo) => {
  await beginNewProject();
  await page.getByLabel('工程名称').fill('MA2 对应验收');
  await page.getByRole('button', { name: '创建工程' }).click();
  await addEmptyProgram();
  const tc = await readFile(join(process.cwd(), 'src/main/link/fixtures/ma2-timecode-fractional-3.3.xml'), 'utf8');
  const seq = await readFile(join(process.cwd(), 'src/main/link/fixtures/ma2-sequence-fractional-3.3.xml'), 'utf8');
  const object = seq.match(/<Sequ\s[\s\S]*?<\/Sequ>/)?.[0];
  if (!object) throw new Error('测试序列缺失');
  const preview = convertMa2Snapshot(tc.replace('</MA>', `${object}</MA>`), 9902);
  const clip = preview.document.tracks[0]!.clips[0]!;
  clip.duration = 4000;
  clip.events.push({ ...clip.events[0]!, id: 'duplicate', at: 1000 });
  preview.mappings.push({ ...preview.mappings[0]!, eventId: 'duplicate', path: 'Timecode:9901/Track:0/SubTrack:0/Event:2' });
  await application.evaluate(({ ipcMain }, result) => { ipcMain.removeHandler('link:ma2-preview'); ipcMain.handle('link:ma2-preview', () => result); }, preview);
  await closeLightingTools(); await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
  await page.getByLabel('MA2 连接方式').selectOption('local');
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
  await page.getByLabel('MA2 onPC 数据目录').fill('C:\\MA2-Test');
  await openLightingTools('节目同步');
  await page.getByLabel('读取 MA2 Timecode 编号').fill('9902');
  await page.getByRole('button', { name: '读取灯光编排', exact: true }).click();
  await page.getByRole('button', { name: '加入当前节目', exact: true }).click();
  const remote = structuredClone(preview);
  remote.document.tracks[0]!.clips[0]!.events[0]!.at = 500;
  remote.document.tracks[0]!.clips[0]!.events[2]!.at = 2500;
  await application.evaluate(({ ipcMain }, result) => { ipcMain.removeHandler('link:ma2-preview'); ipcMain.handle('link:ma2-preview', () => result); }, remote);
  await page.getByRole('button', { name: '读取灯光编排', exact: true }).click();
  const region = page.getByRole('region', { name: 'MA2 灯光读取预览' });
  await expect(region.getByRole('status')).toContainText('待确认 2 个');
  await page.getByLabel('对应 Cue 1.250 · 0.500 秒').selectOption(`old:${clip.events[0]!.id}`);
  await expect(page.getByLabel('对应 Cue 1.250 · 2.500 秒').locator(`option[value="old:${clip.events[0]!.id}"]`)).toBeDisabled();
  await page.getByLabel('对应 Cue 1.250 · 2.500 秒').selectOption('new');
  await expect(region.getByRole('status')).toContainText('已对应 2 个点 · 控台新增 1 个 · 控台删除 1 个 · 待确认 0 个');
  await page.screenshot({ path: testInfo.outputPath('ma2-identity-choice.png') });
  await page.getByRole('button', { name: '读取灯光编排', exact: true }).click();
  await expect(region.getByRole('status')).toContainText('待确认 2 个');
  await expect(page.getByLabel('对应 Cue 1.250 · 0.500 秒')).toHaveValue('');
});

for (const nativeFixture of ['reaper-native-6.05', 'reaper-native-ramp-6.05', 'reaper-native-loop-6.05', 'reaper-native-messages-6.05', 'reaper-native-takes-6.05']) test(`原生 REAPER 6.05 工程经文件选择导入、撤销、保存和重开 ${nativeFixture}`, async ({}, testInfo) => {
  await beginNewProject();
  await page.getByLabel('工程名称').fill('原生 REAPER 验收');
  await page.getByRole('button', { name: '创建工程' }).click();
  await addEmptyProgram();
  const destination = testInfo.outputPath('native-reaper.tblink');
  await application.evaluate(({ dialog }, path) => { dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: path }); }, destination);
  await page.keyboard.press('Control+s');
  const main = page.getByRole('navigation', { name: '主要工作区' });
  await closeLightingTools(); await main.getByRole('button', { name: '设置', exact: true }).click();
  await openLightingTools('导入与导出');
  await page.locator('.settings-lighting input[type="file"]').setInputFiles(join(process.cwd(), `../../packages/core/src/fixtures/${nativeFixture}.rpp`));
  await expect(page.getByRole('region', { name: '灯光导入预览' })).toBeVisible();
  await page.getByRole('button', { name: '确认导入', exact: true }).click();
  const readTrack = async () => parseLinkProject(JSON.parse(await readFile(destination, 'utf8'))).rundown[0]?.lighting?.tracks.find((track) => track.name === 'TBLINK muted solo sample');
  if (nativeFixture === 'reaper-native-6.05') await expect.poll(readTrack).toMatchObject({ muted: true, solo: true, clips: [{ start: 0, duration: 8000, events: [expect.objectContaining({ kind: 'note', at: 1000, duration: 1000, note: 60, velocity: 100 })] }] });
  else {
    await expect.poll(readTrack).toBeDefined();
    const imported = parseLinkProject(JSON.parse(await readFile(destination, 'utf8'))).rundown[0]!.lighting!;
    expect(imported.tracks.filter((track) => track.name.startsWith('ramp-'))).toHaveLength(6);
    const notes = imported.tracks.find((track) => track.name === 'ramp-offset-double')!.clips[0]!.events.filter((event) => event.kind === 'note');
    expect(notes).toHaveLength(3);
    expect(notes[0]!.at).toBe(0);
    expect(notes[0]!.duration).toBeCloseTo(7.804885470350, 7);
    expect(notes[1]!.at).toBeCloseTo(250, 7);
    expect(notes[2]!.at).toBeCloseTo(697.073557013984, 7);
    if (nativeFixture === 'reaper-native-takes-6.05') {
      const takes = imported.tracks.find((track) => track.name === 'native-takes-2')!.clips;
      expect(takes).toHaveLength(3);
      expect(takes.map((clip) => clip.muted)).toEqual([true, false, true]);
      expect(takes[1]!.events[0]).toMatchObject({ kind: 'note', note: 62, at: 2000, duration: 250 });
      expect(imported.tracks.find((track) => track.name === 'native-takes-3')!.clips.map((clip) => clip.muted)).toEqual([false, false, false]);
    }
    if (nativeFixture === 'reaper-native-messages-6.05') {
      const clips = imported.tracks.find((track) => track.name === 'native-message-order')!.clips;
      expect(clips.find((clip) => clip.muted)!.events[0]).toMatchObject({ kind: 'note', note: 65 });
      expect(clips.find((clip) => !clip.muted)!.events.filter((event) => event.kind === 'raw')).toHaveLength(3);
    }
    if (nativeFixture === 'reaper-native-loop-6.05') {
      const loopClip = imported.tracks.find((track) => track.name === 'loop-before-zero')!.clips[0]!;
      const loopNotes = loopClip.events.filter((event) => event.kind === 'note');
      expect(loopNotes).toHaveLength(39);
      expect(loopNotes[0]!.at).toBe(0);
      expect(loopNotes.at(-1)!.at + loopNotes.at(-1)!.duration).toBeCloseTo(6700, 7);
      const clippedNotes = imported.tracks.find((track) => track.name === 'origin-before-zero-double')!.clips[0]!.events.filter((event) => event.kind === 'note');
      expect(clippedNotes.map((event) => event.note)).toEqual([68, 69, 70]);
    }
  }
  await closeLightingTools(); await main.getByRole('button', { name: '编辑器', exact: true }).click();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(readTrack).toBeUndefined();
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(readTrack).toBeDefined();
  const saved = parseLinkProject(JSON.parse(await readFile(destination, 'utf8')));
  expect(saved.rundown[0]!.lighting!.markers).toHaveLength(3);
  await page.reload();
  await closeLightingTools(); await main.getByRole('button', { name: '编辑器', exact: true }).click();
  await expect(page.locator('.lighting-track-name').filter({ hasText: 'TBLINK muted solo sample' })).toBeVisible();
});

test('灯光导入保留变速曲线与音符时间，读取失败清除旧预览', async ({}, testInfo) => {
  await beginNewProject();
  await page.getByLabel('工程名称').fill('灯光导入验收');
  await page.getByRole('button', { name: '创建工程' }).click();
  await addEmptyProgram();
  const destination = testInfo.outputPath('lighting-import.tblink');
  await closeLightingTools(); await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
  await expect(page.locator('.lighting-clip')).toHaveCount(1);
  await page.locator('.lighting-clip').dblclick({ position: { x: 60, y: 20 } });
  await application.evaluate(({ dialog }, path) => { dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: path }); }, destination);
  await page.keyboard.press('Control+s');
  await expect(async () => { expect(JSON.parse(await readFile(destination, 'utf8')) as unknown).toHaveProperty('rundown'); }).toPass({ timeout: 10000 });
  const saved = JSON.parse(await readFile(destination, 'utf8')) as { rundown: Array<{ lighting: { tracks: unknown[]; tempos: unknown[]; markers: unknown[]; version: number; loop: unknown; outputMode: string; templates: unknown[] } }> };
  const source = { ...saved.rundown[0]!.lighting, tracks: [{ id: 'import-track', name: '变速导入', kind: 'midi', color: '#abcdef', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: 'import-clip', name: '测试片段', start: 0, duration: 8, timeLock: 'beat', muted: false, events: [
    { id: 'start', kind: 'point', at: 0, value: 0, shape: 'linear' }, { id: 'end', kind: 'point', at: 8, value: 100, shape: 'hold' },
    { id: 'note', kind: 'note', at: 2, duration: 4, note: 60, velocity: 100 }
  ] }] }], tempos: [{ beat: 0, bpm: 120, numerator: 4, denominator: 4 }, { beat: 4, bpm: 60, numerator: 4, denominator: 4 }] };
  await closeLightingTools(); await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
  await openLightingTools('导入与导出');
  const file = page.locator('.settings-lighting input[type="file"]');
  await file.setInputFiles({ name: 'lighting.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(source)) });
  await expect(page.getByRole('region', { name: '灯光导入预览' })).toBeVisible();
  await file.setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{ broken') });
  await expect(page.getByRole('region', { name: '灯光导入预览' })).toHaveCount(0);
  await file.setInputFiles({ name: 'lighting.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(source)) });
  await page.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect.poll(async () => JSON.parse(await readFile(destination, 'utf8')) as unknown).toMatchObject({ rundown: [{ lighting: { tracks: [expect.anything(), expect.objectContaining({ name: '变速导入', clips: [expect.objectContaining({ timeLock: 'time', duration: 6000, events: expect.arrayContaining([
    expect.objectContaining({ kind: 'point', at: 2000, value: 50 }), expect.objectContaining({ kind: 'note', at: 1000, duration: 3000 })
  ]) })] })], tempos: [{ beat: 0, bpm: 120, numerator: 4, denominator: 4 }] } }] });
  await closeLightingTools(); await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (JSON.parse(await readFile(destination, 'utf8')) as typeof saved).rundown[0]!.lighting.tracks.length).toBe(1);
  await closeLightingTools(); await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
  await openLightingTools('导入与导出');
  const rpp = `<REAPER_PROJECT 0.1 6.05 1
TEMPO 120
MARKER 1 1 "Intro" 0
MARKER 1 2 "Chorus" 1
MARKER 1 5 "" 1
<TRACK
NAME "RPP state"
MUTESOLO 1 2 0
LOCK 1
<ITEM
POSITION 0
LENGTH 8
<SOURCE MIDI
HASDATA 1 960 QN
E 0 90 3c 64
E 960 80 3c 00
>
>
>
>`;
  await file.setInputFiles({ name: 'states.rpp', mimeType: 'text/plain', buffer: Buffer.from(rpp) });
  await expect(page.getByRole('region', { name: '灯光导入预览' })).toBeVisible();
  await page.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect.poll(async () => JSON.parse(await readFile(destination, 'utf8')) as unknown).toMatchObject({ rundown: [{ lighting: {
    tracks: [expect.anything(), expect.objectContaining({ name: 'RPP state', muted: true, solo: true, locked: true })],
    markers: expect.arrayContaining([expect.objectContaining({ name: 'Intro', startMs: 1000, endMs: null }), expect.objectContaining({ name: 'Chorus', startMs: 2000, endMs: 5000 })])
  } }] });
  await closeLightingTools(); await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (JSON.parse(await readFile(destination, 'utf8')) as typeof saved).rundown[0]!.lighting.markers).toHaveLength(0);
  const leftDirectory = testInfo.outputPath('left'); const rightDirectory = testInfo.outputPath('right');
  await mkdir(leftDirectory, { recursive: true }); await mkdir(rightDirectory, { recursive: true });
  const rppPath = join(leftDirectory, 'external.rpp');
  const leftMidi = join(leftDirectory, 'same.mid'); const rightMidi = join(rightDirectory, 'same.mid');
  const midi = (note: number) => {
    const document = createLightingDocument();
    document.tracks.push({ id: 'external', name: 'External', kind: 'midi', color: '#abcdef', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: 'external-clip', name: 'External', start: 0, duration: 2, timeLock: 'beat', muted: false, events: [{ id: 'external-note', kind: 'note', at: 0, duration: 1, note, velocity: 100 }] }] });
    return exportLightingMidi(document);
  };
  await writeFile(leftMidi, midi(60)); await writeFile(rightMidi, midi(72));
  const externalRpp = rpp.replace('HASDATA 1 960 QN\nE 0 90 3c 64\nE 960 80 3c 00', 'FILE "../right/same.mid"');
  await writeFile(rppPath, externalRpp);
  await closeLightingTools(); await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
  await openLightingTools('导入与导出');
  // Use physical files so Electron's native File path bridge is exercised.
  await file.setInputFiles([rppPath, rightMidi, leftMidi]);
  await expect(page.getByRole('region', { name: '灯光导入预览' })).toBeVisible();
  await page.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect.poll(async () => JSON.parse(await readFile(destination, 'utf8')) as unknown).toMatchObject({ rundown: [{ lighting: { tracks: [expect.anything(), expect.objectContaining({ clips: [expect.objectContaining({ events: [expect.objectContaining({ kind: 'note', note: 72 })] })] })] } }] });
  await writeFile(rppPath, externalRpp.replace('TEMPO 120', 'TEMPO 60\n<TEMPOENVEX\nACT 1 -1\nPT 0 60 0\nPT 4 180 1\n>'));
  await file.setInputFiles([rppPath, rightMidi, leftMidi]);
  await page.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect.poll(async () => {
    const lighting = parseLinkProject(JSON.parse(await readFile(destination, 'utf8'))).rundown[0]!.lighting!;
    const note = lighting.tracks[2]?.clips[0]?.events[0];
    return note?.kind === 'note' ? note.duration : null;
  }).toBeCloseTo((Math.sqrt(7200) - 60) / 0.03, 6);
});

test('只做标记可在时间尺拖动改名删除并撤销保存', async ({}, testInfo) => {
  await beginNewProject();
  await page.getByLabel('工程名称').fill('标记验收');
  await page.getByRole('button', { name: '创建工程' }).click();
  await addEmptyProgram();
  const main = page.getByRole('navigation', { name: '主要工作区' });
  await closeLightingTools(); await main.getByRole('button', { name: '设置', exact: true }).click();
  await openLightingTrack();
  await page.getByLabel('灯光打点方式').selectOption('marker');
  await closeLightingTools(); await main.getByRole('button', { name: '编辑器', exact: true }).click();
  await page.locator('.lighting-track-name').first().click();
  await page.keyboard.press('m');
  const marker = page.getByRole('button', { name: '时间线标记 标记 1', exact: true });
  await expect(marker).toBeVisible();
  await expect(page.locator('.lighting-timeline-point')).toHaveCount(0);
  const box = await marker.boundingBox(); if (!box) throw new Error('标记位置不可见');
  await page.mouse.move(box.x + 5, box.y + 10);
  await page.mouse.down(); await page.mouse.move(box.x + 85, box.y + 10, { steps: 6 }); await page.mouse.up();
  await expect(marker).not.toHaveAttribute('title', /· 0.000 秒/);
  await page.keyboard.press('Control+z');
  await expect(marker).toHaveAttribute('title', /· 0.000 秒/);
  await marker.dblclick();
  await page.getByLabel('时间线标记名称').fill('副歌开始');
  await page.getByLabel('时间线标记名称').press('Enter');
  const renamed = page.getByRole('button', { name: '时间线标记 副歌开始', exact: true });
  await renamed.focus(); await page.keyboard.press('Delete');
  await expect(page.locator('.timeline-marker')).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(renamed).toBeVisible();
  const destination = testInfo.outputPath('markers.tblink');
  await application.evaluate(({ dialog }, path) => { dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: path }); }, destination);
  await page.keyboard.press('Control+s');
  await expect.poll(async () => { try { return parseLinkProject(JSON.parse(await readFile(destination, 'utf8'))).rundown[0]?.lighting?.markers; } catch { return null; } }).toMatchObject([{ name: '副歌开始', startMs: 0, endMs: null }]);
  await page.screenshot({ path: testInfo.outputPath('timeline-markers.png') });
  await closeLightingTools(); await main.getByRole('button', { name: '设置', exact: true }).click();
  await openLightingTools('节拍与循环');
  await page.getByLabel('标记区域终点').fill('10');
  await page.getByLabel('标记区域终点').press('Enter');
  await page.getByLabel('标记起点', { exact: true }).fill('5');
  await page.getByLabel('标记起点', { exact: true }).press('Enter');
  await expect(page.getByLabel('标记区域终点')).toHaveValue('15');
  await page.getByLabel('标记区域终点').fill('4');
  await page.getByLabel('标记区域终点').press('Enter');
  await expect.poll(() => page.getByLabel('标记区域终点').evaluate((element) => (element as HTMLInputElement).validity.valid)).toBe(false);
  await page.getByLabel('标记区域终点').press('Escape');
  await expect(page.getByLabel('标记区域终点')).toHaveValue('15');
  await page.keyboard.press('Control+z');
  await expect(page.getByLabel('标记起点', { exact: true })).toHaveValue('0');
  await expect(page.getByLabel('标记区域终点')).toHaveValue('10');
  await closeLightingTools(); await main.getByRole('button', { name: '编辑器', exact: true }).click();
  const savedRegion = async () => parseLinkProject(JSON.parse(await readFile(destination, 'utf8'))).rundown[0]!.lighting!.markers[0]!;
  await page.keyboard.press('Control+s');
  await expect.poll(savedRegion).toMatchObject({ startMs: 0, endMs: 10000 });
  const endHandle = page.getByRole('button', { name: '副歌开始 区域终点', exact: true });
  const endBox = await endHandle.boundingBox(); if (!endBox) throw new Error('区域终点不可见');
  await page.mouse.move(endBox.x + 4, endBox.y + 4); await page.mouse.down();
  await page.mouse.move(endBox.x + 64, endBox.y + 4, { steps: 5 });
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(endHandle).toHaveCSS('left', `${endBox.x + 4 - (await renamed.boundingBox())!.x}px`);
  await page.mouse.move(endBox.x + 4, endBox.y + 4); await page.mouse.down();
  await page.mouse.move(endBox.x + 64, endBox.y + 4, { steps: 5 }); await page.mouse.up();
  await expect.poll(async () => (await savedRegion()).endMs).toBeGreaterThan(10000);
  await expect.poll(async () => (await savedRegion()).startMs).toBe(0);
  await page.keyboard.press('Control+z');
  await expect.poll(savedRegion).toMatchObject({ startMs: 0, endMs: 10000 });
  const startHandle = page.getByRole('button', { name: '副歌开始 区域起点', exact: true });
  const startBox = await startHandle.boundingBox(); if (!startBox) throw new Error('区域起点不可见');
  await page.mouse.move(startBox.x + 5, startBox.y + 4); await page.mouse.down();
  await page.mouse.move(startBox.x + 45, startBox.y + 4, { steps: 5 }); await page.mouse.up();
  await expect.poll(async () => (await savedRegion()).startMs).toBeGreaterThan(0);
  await expect.poll(async () => (await savedRegion()).endMs).toBe(10000);
  await page.keyboard.press('Control+z');
  await expect.poll(savedRegion).toMatchObject({ startMs: 0, endMs: 10000 });
  await page.screenshot({ path: testInfo.outputPath('timeline-region-handles.png') });
});

test('固定 Cue 设置控制时间线连续打点并可撤销', async () => {
  await beginNewProject();
  await page.getByLabel('工程名称').fill('固定 Cue 验收');
  await page.getByRole('button', { name: '创建工程' }).click();
  await addEmptyProgram();
  const main = page.getByRole('navigation', { name: '主要工作区' });
  await closeLightingTools(); await main.getByRole('button', { name: '设置', exact: true }).click();
  await openLightingTrack();
  await page.getByLabel('灯光打点方式').selectOption('fixed');
  await page.getByLabel('固定 Cue 编号').fill('7.500');
  await page.getByLabel('固定 Cue 编号').press('Tab');
  await page.getByLabel('固定 Cue 序列').fill('9901');
  await page.getByLabel('固定 Cue 序列').press('Tab');
  await page.getByLabel('固定 Cue 执行器').fill('99.219');
  await page.getByLabel('固定 Cue 执行器').press('Tab');
  await closeLightingTools(); await main.getByRole('button', { name: '编辑器', exact: true }).click();
  await page.locator('.lighting-track-name').first().click();
  await page.keyboard.press('m');
  await page.keyboard.press('m');
  await expect.poll(displayedLightingEventCount).toBe(2);
  await expect(page.getByLabel('Cue 编号', { exact: true })).toHaveValue('7.500');
  await closeLightingTools(); await main.getByRole('button', { name: '设置', exact: true }).click();
  await openLightingTrack();
  await page.keyboard.press('m');
  await expect.poll(displayedLightingEventCount).toBe(3);
  await page.keyboard.press('Control+z');
  await expect.poll(displayedLightingEventCount).toBe(2);
});

test('设备地址草稿不会被独立 MIDI 设置覆盖，保存后两项均保留', async () => {
  const profile = createDefaultIntegrationProfile();
  profile.midiPortProfiles.push({ id: 'lighting-events-output', direction: 'output', portName: 'Draft Test Output' });
  await page.evaluate((value) => window.tbLink.saveIntegrationProfile({ profile: value }), profile);
  await page.reload();
  await closeLightingTools(); await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
  const address = page.getByLabel('WebSocket 地址');
  await address.fill('ws://127.0.0.1:4456');
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
  await page.getByRole('button', { name: 'OBS Studio 故障处理', exact: true }).click();
  await page.getByLabel('工作目录', { exact: true }).fill('C:/unsaved-maintenance');
  await page.getByRole('button', { name: '关闭 OBS Studio 故障处理', exact: true }).click();
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
  await page.getByLabel('灯光事件输出端口').selectOption('');
  await expect.poll(() => page.evaluate(async () => (await window.tbLink.loadIntegrationProfile())?.midiPortProfiles.some((port) => port.id === 'lighting-events-output'))).toBe(false);
  await expect(address).toHaveValue('ws://127.0.0.1:4456');
  await page.getByRole('button', { name: '仅保存 OBS', exact: true }).click();
  await expect.poll(() => page.evaluate(async () => (await window.tbLink.loadIntegrationProfile())?.obs.webSocketUrl)).toBe('ws://127.0.0.1:4456');
  expect(await page.evaluate(async () => (await window.tbLink.loadIntegrationProfile())?.obs.workingDirectory)).toBe(profile.obs.workingDirectory);
  expect(await page.evaluate(async () => (await window.tbLink.loadIntegrationProfile())?.midiPortProfiles.some((port) => port.id === 'lighting-events-output'))).toBe(false);
  await page.reload();
  await closeLightingTools(); await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
  await expect(address).toHaveValue('ws://127.0.0.1:4456');
  await expect(page.getByLabel('灯光事件输出端口')).toHaveValue('');
});

test('渐变节拍设置移动节拍 Cue，撤销重做与重开保持一致', async ({}, testInfo) => {
  const project = createEmptyLinkProject('渐变节拍验收'); project.schemaVersion = 2;
  const lighting = createLightingDocument();
  lighting.tempos = [{ beat: 0, bpm: 60, numerator: 4, denominator: 4 }, { beat: 8, bpm: 180, numerator: 4, denominator: 4 }];
  lighting.tracks.push({ id: 'track', name: '灯光', kind: 'ma2', color: '#abcdef', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [
    { id: 'beat', name: '节拍', start: 0, duration: 8, timeLock: 'beat', muted: false, events: [{ id: 'beat-cue', kind: 'ma2', at: 3, cue: '1', sequence: 1, executor: '1.1', action: 'goto', label: '节拍Cue' }] },
    { id: 'time', name: '时间', start: 0, duration: 5000, timeLock: 'time', muted: false, events: [{ id: 'time-cue', kind: 'ma2', at: 2500, cue: '2', sequence: 1, executor: '1.1', action: 'goto', label: '时间Cue' }] }
  ] });
  project.rundown.push({ id: 'song', title: '渐变节目', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting });
  const destination = testInfo.outputPath('ramp.tblink'); await writeFile(destination, JSON.stringify(project));
  await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, destination);
  await page.getByRole('button', { name: '打开工程', exact: true }).click();
  const main = page.getByRole('navigation', { name: '主要工作区' });
  await closeLightingTools(); await main.getByRole('button', { name: '设置', exact: true }).click();
  await openLightingTools('节拍与循环');
  await expect(page.getByLabel('变速点 2 变化方式')).toBeDisabled();
  await page.getByLabel('变速点 1 变化方式').selectOption('linear');
  await expect.poll(async () => parseLinkProject(JSON.parse(await readFile(destination, 'utf8'))).rundown[0]!.lighting!.tempos[0]!.transition).toBe('linear');
  await page.screenshot({ path: testInfo.outputPath('tempo-ramp-settings.png') });
  await closeLightingTools(); await main.getByRole('button', { name: '编辑器', exact: true }).click();
  await page.locator('.lighting-timeline-point').filter({ hasText: '节拍Cue' }).click();
  await expect(page.getByLabel('灯光点歌曲时间')).toHaveValue('2');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByLabel('灯光点歌曲时间')).toHaveValue('3');
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(page.getByLabel('灯光点歌曲时间')).toHaveValue('2');
  await page.locator('.lighting-timeline-point').filter({ hasText: '时间Cue' }).click();
  await expect(page.getByLabel('灯光点歌曲时间')).toHaveValue('2.5');
  await page.reload();
  await closeLightingTools(); await main.getByRole('button', { name: '编辑器', exact: true }).click();
  await page.locator('.lighting-timeline-point').filter({ hasText: '节拍Cue' }).click();
  await expect(page.getByLabel('灯光点歌曲时间')).toHaveValue('2');
});

test('顶部工程名与紧凑素材侧栏支持大量素材搜索和滚动', async ({}, testInfo) => {
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1180, 720));
  const project = createEmptyLinkProject('大型演出联动工程');
  project.mediaAssets = Array.from({ length: 600 }, (_, index) => ({
    id: `library-${index}`, name: `演出素材 ${String(index).padStart(4, '0')}`,
    kind: 'audio', folderId: null, relativePath: `assets/audio-${index}.wav`,
    sha256: 'a'.repeat(64), byteLength: 100, durationMs: 1000
  }));
  project.rundown.push({ id: 'library-program', title: '素材验收节目', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [] });
  await mkdir(testInfo.outputDir, { recursive: true });
  const projectPath = testInfo.outputPath('library.tblink');
  await writeFile(projectPath, JSON.stringify(project));
  await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, projectPath);
  await page.getByRole('button', { name: '打开工程', exact: true }).click();
  await expect(page.locator('.toolbar-project-name strong')).toHaveText(project.name);
  await expect(page.locator('.app-sidebar')).not.toContainText(project.name);
  await closeLightingTools(); await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
  const library = page.locator('.sidebar-editor .resource-library');
  const table = library.locator('.media-resource-table');
  await expect(library.locator('.asset-row')).toHaveCount(600);
  const viewport = await table.boundingBox();
  expect(viewport?.height).toBeGreaterThan(250);
  await expect.poll(() => library.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  const last = library.locator('.asset-row').last();
  await last.scrollIntoViewIfNeeded();
  await expect(last).toContainText('0599');
  await last.click();
  await expect(last).toHaveClass(/is-selected/);
  await expect(library.getByLabel('搜索素材')).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('editor-library-scrolled.png') });
  await library.getByLabel('搜索素材').fill('0599');
  await expect(library.locator('.asset-row')).toHaveCount(1);
  await expect(library.locator('.asset-row')).toContainText('0599');
  await library.getByLabel('素材类型').selectOption('video');
  await expect(library.getByText('没有找到匹配的素材，试试其他名称')).toBeVisible();
  await library.getByLabel('素材类型').selectOption('all');
  await library.getByLabel('搜索素材').fill('');
  await expect(library.locator('.asset-row')).toHaveCount(600);
  await table.evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: testInfo.outputPath('editor-library.png') });
  await library.getByLabel('列表视图', { exact: true }).click();
  await expect(table).toHaveClass(/media-view-list/);
  await library.getByLabel('搜索素材').fill('0599');
  await library.getByLabel('管理素材 演出素材 0599', { exact: true }).click();
  await expect(page.getByRole('button', { name: '重命名', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await library.getByRole('button', { name: /OBS 场景/ }).click();
  await expect(library.locator('.asset-row')).toHaveCount(0);
  await library.getByRole('button', { name: /本地素材/ }).click();
  await expect(library.locator('.asset-row')).toHaveCount(1);
  await closeLightingTools(); await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.locator('.toolbar-project-name strong')).toHaveText(project.name);
  await page.screenshot({ path: testInfo.outputPath('settings-submenu.png') });
});

test('设置各页面在最小窗口内字段可读且不横向溢出', async ({}, testInfo) => {
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1180, 720));
  await beginNewProject();
  await page.getByLabel('工程名称').fill('设置验收');
  await page.getByRole('button', { name: '创建工程' }).click();
  await addEmptyProgram();
  await closeLightingTools(); await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
  for (const [index, name] of ['播放', '画面与同步', '设备连接', '外观与更新'].entries()) {
    await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name, exact: true }).click();
    await expect(page.locator('.settings-detail > header h2')).toHaveText(name);
    await expect.poll(() => page.locator('.settings-detail').evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath(`settings-${index}.png`) });
    if (name === '播放') {
      await page.getByLabel('播放主控模式').selectOption('internal');
      const fadeOut = page.getByLabel('淡出时长（秒）');
      await fadeOut.fill('1.2');
      await fadeOut.press('Tab');
      await expect(fadeOut).toBeEnabled();
      await expect(fadeOut).toHaveValue('1.2');
      for (const invalid of ['', '-1', '31']) {
        await fadeOut.fill(invalid);
        await fadeOut.press('Tab');
        await expect(fadeOut).toHaveValue('1.2');
      }
      await fadeOut.fill('2');
      await fadeOut.press('Escape');
      await expect(fadeOut).toHaveValue('1.2');
      await expect.poll(() => page.locator('.settings-detail').evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: testInfo.outputPath('settings-internal-playback.png') });
      await page.getByLabel('播放主控模式').selectOption('p1');
      await page.getByLabel('播放主控模式').selectOption('internal');
      await expect(page.getByLabel('淡出时长（秒）')).toHaveValue('1.2');
      await page.getByLabel('播放主控模式').selectOption('p1');
    }

  }
});

test('灯光直接在时间线打点拖动，歌曲时间一致，自动保存和重开', async ({}, testInfo) => {
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1200, 800));
  await beginNewProject();
  await page.getByLabel('工程名称').fill('时间线灯光验收');
  await page.getByRole('button', { name: '创建工程' }).click();
  const destination = testInfo.outputPath('lighting.tblink');
  await application.evaluate(({ dialog }, path) => { dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: path }); }, destination);
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  await addEmptyProgram();
  await closeLightingTools(); await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
  await expect(page.locator('.app-sidebar .resource-library')).toBeVisible();
  await expect(page.locator('.cue-studio-grid > .resource-library')).toHaveCount(0);
  await expect(page.locator('.lighting-lane')).toHaveCount(1);
  await closeLightingTools(); await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
  await openLightingTrack();
  await expect(page.getByLabel('灯光轨道名称')).toBeEnabled();
  await closeLightingTools(); await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
  await expect(page.getByRole('button', { name: '添加灯光轨道', exact: true })).toHaveCount(0);
  await page.locator('.lighting-track-name').click();
  await expect(page.locator('.lighting-inspector').getByLabel('灯光播放方式')).toHaveValue('music');
  await expect(page.locator('.reference-timeline').getByLabel('灯光播放方式')).toHaveCount(0);
  expect((await page.locator('.lighting-lane').boundingBox())!.height).toBe(72);
  const visualHeading = page.locator('.visual-layer-heading').last();
  const initialLight = (await page.locator('.lighting-heading:visible').boundingBox())!;
  expect(initialLight.y).toBeLessThan((await visualHeading.boundingBox())!.y);
  const grip = (await page.getByLabel('调整灯光轨道顺序').boundingBox())!;
  const visualBounds = (await visualHeading.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, visualBounds.y + visualBounds.height - 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await page.locator('.lighting-heading:visible').boundingBox())!.y).toBeGreaterThan((await visualHeading.boundingBox())!.y);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await page.locator('.lighting-heading:visible').boundingBox())!.y).toBe(initialLight.y);
  await expect(page.getByLabel('灯光片段编辑器')).toHaveCount(0);
  await page.locator('.lighting-clip').dblclick({ position: { x: 160, y: 20 } });
  await expect(page.locator('.lighting-timeline-point')).toHaveCount(1);
  const timeInput = page.getByLabel('灯光点歌曲时间');
  const initialSeconds = Number(await timeInput.inputValue());
  expect(initialSeconds).toBeGreaterThan(4);
  const point = page.locator('.lighting-timeline-point');
  const pointBefore = await point.boundingBox();
  expect(pointBefore!.width).toBeLessThanOrEqual(10);
  const headBefore = await page.locator('.timeline-playhead').boundingBox();
  expect(Math.abs(pointBefore!.x - headBefore!.x)).toBeLessThan(3);
  const cueNumber = page.getByLabel('Cue 编号', { exact: true });
  const originalCue = await cueNumber.inputValue();
  await cueNumber.fill('错误编号');
  await cueNumber.press('Tab');
  await expect(cueNumber).toHaveValue(originalCue);
  await cueNumber.fill('1.25');
  await cueNumber.press('Tab');
  await expect(cueNumber).toHaveValue('1.25');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(cueNumber).toHaveValue(originalCue);
  const ma2Action = page.getByLabel('MA2 动作', { exact: true });
  await ma2Action.selectOption('go');
  await expect(cueNumber).toHaveCount(0);
  await expect(page.getByLabel('序列', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('执行器', { exact: true })).toBeVisible();
  await expect.poll(async () => JSON.parse(await readFile(destination, 'utf8')) as unknown).toMatchObject({ rundown: [{ lighting: { tracks: [{ clips: [{ events: [{ action: 'go' }] }] }] } }] });
  await ma2Action.selectOption('off');
  await expect(cueNumber).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('lighting-executor-properties.png') });
  await point.click();
  await page.keyboard.press('m');
  await expect.poll(displayedLightingEventCount).toBe(2);
  await expect(cueNumber).toHaveValue('1');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('.lighting-timeline-point')).toHaveCount(1);
  await point.click();
  await expect(ma2Action).toHaveValue('off');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(ma2Action).toHaveValue('go');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(ma2Action).toHaveValue('goto');
  await expect(cueNumber).toHaveValue(originalCue);
  await page.getByLabel('Cue 名称', { exact: true }).fill('主歌亮起');
  const bounds = await point.boundingBox();
  await page.mouse.move(bounds!.x + 8, bounds!.y + 8);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + 72, bounds!.y + 8, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => Number(await timeInput.inputValue())).toBeCloseTo(initialSeconds + 2, 2);
  const moved = await point.boundingBox();
  const head = await page.locator('.timeline-playhead').boundingBox();
  expect(Math.abs(moved!.x - head!.x)).toBeLessThan(3);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => Number(await timeInput.inputValue())).toBeCloseTo(initialSeconds, 2);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(async () => Number(await timeInput.inputValue())).toBeCloseTo(initialSeconds + 2, 2);
  await point.click();
  await page.keyboard.press('m');
  await expect.poll(displayedLightingEventCount).toBe(2);
  await expect.poll(async () => JSON.parse(await readFile(destination, 'utf8')) as unknown).toMatchObject({ schemaVersion: 2, rundown: [{ lighting: { tracks: [{ clips: [{ events: [expect.objectContaining({ kind: 'ma2', label: '主歌亮起' }), expect.objectContaining({ kind: 'ma2', cue: '2' })] }] }] } }] });
  await expect(page.getByLabel('灯光点时间显示')).toBeVisible();
  await expect(page.locator('.lighting-timeline-point:visible')).toHaveCount(1);
  await expect(page.locator('.lighting-timeline-point:visible small')).toHaveText('+1');

  await expect(page.getByLabel('执行器', { exact: true })).toBeVisible();
  await page.locator('.lighting-clip').click({ position: { x: 400, y: 10 } });
  await page.locator('.lighting-timeline-point').last().click({ button: 'right' });
  await page.getByRole('button', { name: '复制到播放头', exact: true }).click();
  await expect.poll(displayedLightingEventCount).toBe(3);
  expect(Number(await timeInput.inputValue())).toBeCloseTo(12.5, 1);
  await page.locator('.lighting-timeline-point').last().click({ button: 'right' });
  await page.locator('.lighting-point-menu').getByRole('button', { name: '删除灯光点', exact: true }).click();
  await expect.poll(displayedLightingEventCount).toBe(2);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(displayedLightingEventCount).toBe(3);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(displayedLightingEventCount).toBe(2);
  await page.locator('.lighting-timeline-point').last().click();

  await expect(page.locator('.property-advanced')).toHaveCount(0);

  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1200, 800));
  await page.screenshot({ path: testInfo.outputPath('lighting-timeline.png') });
  const inspectorBounds = await page.locator('.cue-inspector').boundingBox();
  expect(inspectorBounds!.x + inspectorBounds!.width).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
  const timelineBounds = await page.locator('.reference-timeline').boundingBox();
  const previewBounds = await page.locator('.editor-preview-row').boundingBox();
  expect(timelineBounds!.width).toBeGreaterThan(previewBounds!.width - 3);
  expect(inspectorBounds!.y + inspectorBounds!.height).toBeLessThanOrEqual(timelineBounds!.y);

  await page.reload();
  await closeLightingTools(); await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
  await expect.poll(displayedLightingEventCount).toBe(2);
  await page.locator('.lighting-heading').filter({ has: page.getByRole('button', { name: '删除灯光轨道', exact: true }) }).click({ button: 'right' });
  await page.locator('.resource-context-menu').getByRole('button', { name: '删除灯光轨道', exact: true }).click();
  await expect(page.locator('.lighting-lane')).toHaveCount(0);
  await expect.poll(async () => JSON.parse(await readFile(destination, 'utf8')) as unknown).toMatchObject({ rundown: [{ lighting: { tracks: [] } }] });
  await page.reload();
  await closeLightingTools(); await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
  await expect(page.locator('.lighting-lane')).toHaveCount(0);
  await page.getByRole('button', { name: '添加灯光轨道', exact: true }).click();
  await expect(page.locator('.lighting-lane')).toHaveCount(1);
  await page.getByRole('button', { name: '删除灯光轨道', exact: true }).click();
  await expect(page.locator('.lighting-lane')).toHaveCount(0);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('.lighting-lane')).toHaveCount(1);
});

test('打开编辑器保留 OBS 原场景且不产生整理图层的撤销步骤', async ({}, testInfo) => {
  const project = createEmptyLinkProject('场景与撤销验收');
  project.obsOutputMode = 'scenes';
  const base = { timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, enabled: true, notes: '' };
  project.rundown.push({ id: 'song', title: '场景节目', enabled: true, notes: '', referenceMediaClips: [],
    visualLayers: [{ id: 'visual', name: '原图层', visible: true, locked: false }], cues: [
      { ...base, id: 'visual-cue', name: '原场景画面', layerId: 'visual', durationMs: 5000, actions: [{ id: 'show', label: '原画面', kind: 'obs.setSceneItemEnabled', sceneName: '用户竖屏场景', sourceName: '用户机位', enabled: true }] },
      { ...base, id: 'point', name: '旧打点', actions: [] }
    ] });
  const destination = testInfo.outputPath('scene-history.tblink');
  await writeFile(destination, JSON.stringify(project));
  await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, destination);
  await page.getByRole('button', { name: '打开工程', exact: true }).click();
  const main = page.getByRole('navigation', { name: '主要工作区' });
  await closeLightingTools(); await main.getByRole('button', { name: '编辑器', exact: true }).click();
  const point = page.locator('.timeline-cue').filter({ hasText: '旧打点' });
  await point.click();
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  const name = page.locator('.cue-inspector .title-input');
  await name.click(); await name.press('Tab');
  const notes = page.locator('.cue-inspector').getByLabel('备注', { exact: true });
  await notes.click(); await notes.press('Tab');
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  await name.fill(''); await name.press('Tab');
  await expect(name).toHaveValue('旧打点');
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  await name.fill('修改打点'); await name.press('Tab');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(name).toHaveValue('旧打点');
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(name).toHaveValue('修改打点');
  await expect.poll(async () => parseLinkProject(JSON.parse(await readFile(destination, 'utf8'))).rundown[0]!.cues[1]!.name).toBe('修改打点');
  const saved = parseLinkProject(JSON.parse(await readFile(destination, 'utf8')));
  expect(saved.rundown[0]!.cues[0]!.actions).toEqual(project.rundown[0]!.cues[0]!.actions);
  await page.reload();
  await closeLightingTools(); await main.getByRole('button', { name: '编辑器', exact: true }).click();
  await page.locator('.timeline-cue').filter({ hasText: '修改打点' }).click();
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
});

test('OBS 采集预热显示准备状态，持续无画面才报错，恢复后清除错误', async ({}, testInfo) => {
  const project = createEmptyLinkProject('采集预热验收');
  project.obsOutputMode = 'scenes';
  project.rundown.push({ id: 'song', title: '采集节目', enabled: true, notes: '', referenceMediaClips: [],
    visualLayers: [{ id: 'visual', name: '机位', visible: true, locked: false }], cues: [
      { id: 'cue', name: '机位画面', layerId: 'visual', enabled: true, notes: '', durationMs: 5000,
        timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
        actions: [{ id: 'show', label: '机位', kind: 'obs.setProgramScene', sceneName: '用户场景' }] }
    ] });
  const destination = testInfo.outputPath('preview.tblink');
  await writeFile(destination, JSON.stringify(project));
  const pixels = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16;
    const blank = canvas.toDataURL(); const context = canvas.getContext('2d');
    if (!context) throw new Error('缺少测试绘图上下文');
    context.fillStyle = '#4588aa'; context.fillRect(0, 0, 16, 16);
    return { blank, visible: canvas.toDataURL() };
  });
  await application.evaluate(({ dialog, ipcMain, BrowserWindow }, { destination, blank }) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [destination] });
    ipcMain.removeHandler('link:obs-inventory');
    ipcMain.handle('link:obs-inventory', () => ({ scenes: ['用户场景'], inputs: ['用户机位'], inputKinds: { 用户机位: 'dshow_input' }, sceneItems: { 用户场景: ['用户机位'] }, filters: {}, transitions: [], inputAudioStates: {}, sourceSizes: { 用户机位: { width: 1920, height: 1080 } } }));
    ipcMain.removeHandler('link:obs-source-screenshot'); ipcMain.handle('link:obs-source-screenshot', () => blank);
    BrowserWindow.getAllWindows()[0]!.webContents.send('link:obs-status', { status: 'connected', obsVersion: '32.2.2', webSocketVersion: '5.6.3' });
  }, { destination, blank: pixels.blank });
  await page.getByRole('button', { name: '打开工程', exact: true }).click();
  await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
  await expect(page.locator('.stage-obs-warming')).toHaveText('正在准备采集画面…');
  await expect(page.locator('.stage-obs-error')).toHaveCount(0);
  await expect(page.locator('.stage-obs-error')).toContainText('尚未提供画面');
  await expect(page.locator('.stage-obs-warming')).toHaveCount(0);
  await application.evaluate(({ ipcMain }, data) => { ipcMain.removeHandler('link:obs-source-screenshot'); ipcMain.handle('link:obs-source-screenshot', () => data); }, pixels.visible);
  await expect(page.getByRole('img', { name: 'OBS 用户场景', exact: true })).toBeVisible();
  await expect(page.locator('.stage-obs-error')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('capture-ready.png') });
});

test('节目属性拒绝空名称，无修改不产生撤销，改名备注可撤销保存重开', async ({}, testInfo) => {
  const project = createEmptyLinkProject('节目属性验收');
  project.rundown.push({ id: 'song', title: '原节目', enabled: true, notes: '原备注', referenceMediaClips: [], cues: [],
    visualLayers: [{ id: 'visual', name: '原图层', visible: true, locked: false }] });
  const destination = testInfo.outputPath('programme-properties.tblink');
  await writeFile(destination, JSON.stringify(project));
  await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, destination);
  await page.getByRole('button', { name: '打开工程', exact: true }).click();
  await page.getByRole('button', { name: '节目属性', exact: true }).click();
  const panel = page.locator('.p1-item-inspector');
  const name = panel.getByLabel('名称', { exact: true });
  const notes = panel.getByRole('textbox', { name: '备注', exact: true });
  const undo = page.getByRole('button', { name: '撤销', exact: true });
  await expect(name).toHaveValue('原节目');
  await expect(undo).toBeDisabled();
  await name.click(); await name.press('Tab');
  await expect(undo).toBeDisabled();
  await notes.click(); await notes.press('Tab');
  await expect(undo).toBeDisabled();
  for (const invalid of ['', '   ']) {
    await name.fill(invalid); await name.press('Tab');
    await expect(name).toHaveValue('原节目');
    await expect(undo).toBeDisabled();
  }
  await name.fill('改名节目'); await name.press('Tab');
  await notes.fill('修改备注'); await notes.press('Tab');
  await undo.click();
  await expect(notes).toHaveValue('原备注');
  await expect(name).toHaveValue('改名节目');
  await undo.click();
  await expect(name).toHaveValue('原节目');
  await expect(undo).toBeDisabled();
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(async () => parseLinkProject(JSON.parse(await readFile(destination, 'utf8'))).rundown[0]!.notes).toBe('修改备注');
  await page.reload();
  await page.getByRole('button', { name: '节目属性', exact: true }).click();
  await expect(name).toHaveValue('改名节目');
  await expect(notes).toHaveValue('修改备注');
  await expect(undo).toBeDisabled();
});

test('设置分类清晰，首页无重复入口，场景在原编辑器编排', async ({}, testInfo) => {
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await beginNewProject();
  await page.getByLabel('工程名称').fill('简洁工作台');
  await page.getByRole('button', { name: '创建工程' }).click();
  await application.evaluate(({ dialog }, destination) => { dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: destination }); }, testInfo.outputPath('simple.tblink'));
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  await expect(page.getByRole('button', { name: '导入 IBC 工程' })).toHaveCount(0);
  await expect(page.getByText('画面设置', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '连接与设备', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button')).toHaveText(['设备连接', '播放', '画面与同步', '外观与更新']);
  await expect(page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button').first()).toHaveText('设备连接');
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '播放', exact: true }).click();
  await page.getByLabel('播放主控模式').selectOption('internal');
  await page.getByRole('button', { name: '画面与同步', exact: true }).click();
  await expect(page.getByLabel('OBS 输出方式')).toHaveCount(0);
  await expect(page.getByText('跟随 OBS', { exact: true })).toBeVisible();
  await expect(page.getByLabel('工程输出画布')).toHaveCount(0);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1200, 800));
  await page.screenshot({ path: testInfo.outputPath('settings-picture.png') });
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
  await expect(page.locator('.app-sidebar').getByRole('navigation', { name: '设置子菜单' })).toBeVisible();
  await expect(page.locator('.settings-submenus')).toBeVisible();
  const sidebar = await page.locator('.app-sidebar').boundingBox();
  const submenu = await page.locator('.settings-submenus').boundingBox();
  expect(submenu!.x).toBeGreaterThanOrEqual(sidebar!.x);
  expect(submenu!.x + submenu!.width).toBeLessThanOrEqual(sidebar!.x + sidebar!.width);
  await expect(page.getByRole('navigation', { name: '主要工作区' }).getByRole('button')).toHaveText(['节目单', '编辑器', '设置']);
  await page.screenshot({ path: testInfo.outputPath('settings-devices.png') });
  await closeSettingsDialog();
  await addEmptyProgram();
  await expect(page.getByLabel('完整场景切换点')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('simple-home.png') });
  await application.evaluate(({ ipcMain, BrowserWindow }) => {
    ipcMain.removeHandler('link:obs-inventory');
    ipcMain.handle('link:obs-inventory', () => ({ scenes: ['全景拉腿', '近景'], inputs: ['摄像头'], inputKinds: { 摄像头: 'dshow_input' }, sceneItems: { 全景拉腿: ['摄像头'], 近景: ['摄像头'] }, filters: {}, transitions: [], inputAudioStates: {}, sourceSizes: {} }));
    BrowserWindow.getAllWindows()[0]?.webContents.send('link:obs-status', { status: 'connected', obsVersion: '32.2.2', webSocketVersion: '5.6.3' });
  });
  await page.getByRole('button', { name: /编辑器/ }).first().click();
  await expect(page.locator('.rundown-tabs')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /修改节目名称：/ })).toBeVisible();
  await page.getByRole('button', { name: '刷新 OBS 资源', exact: true }).click();
  await expect(page.locator('.obs-camera-row')).toHaveCount(2);
  await page.locator('.obs-camera-row').filter({ hasText: '全景拉腿' }).dblclick();
  await expect(page.locator('.action-card')).toHaveCount(1);
  await expect(page.locator('.action-card select').first()).toHaveValue('obs.setProgramScene');
  await expect(page.locator('.cue-inspector')).toContainText('场景');
  await expect(page.getByRole('button', { name: '保存工程', exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('simple-editor.png') });
});

test('播放列表可新建、改名、分配歌曲和删除，删除列表不删除歌曲', async ({}, testInfo) => {
  await beginNewProject();
  await page.getByLabel('工程名称').fill('列表操作验收');
  await page.getByRole('button', { name: '创建工程' }).click();
  await page.getByRole('button', { name: '新建播放列表', exact: true }).click();
  await page.getByRole('textbox', { name: '列表名称' }).fill('暖场');
  await page.getByRole('button', { name: '保存列表' }).click();
  await addEmptyProgram();
  await expect(page.locator('.p1-media-card')).toHaveCount(1);
  await page.getByRole('button', { name: '新建播放列表', exact: true }).click();
  await page.getByRole('textbox', { name: '列表名称' }).fill('正式');
  await page.getByRole('button', { name: '保存列表' }).click();
  await expect(page.locator('.p1-media-card')).toHaveCount(0);
  await page.locator('.p1-playlist-pane > button').filter({ hasText: '暖场' }).click();
  await page.getByRole('button', { name: '节目属性', exact: true }).click();
  await page.getByLabel('所属播放列表').selectOption({ label: '正式' });
  await expect(page.locator('.p1-media-card')).toHaveCount(0);
  const target = page.locator('.p1-playlist-pane > button').filter({ hasText: '正式' });
  await target.dblclick();
  await page.getByRole('textbox', { name: '列表名称' }).fill('正式演出');
  await page.getByRole('button', { name: '保存列表' }).click();
  await expect(page.locator('.p1-media-card')).toHaveCount(1);
  await page.locator('.p1-playlist-pane > button').filter({ hasText: '正式演出' }).click({ button: 'right' });
  await page.getByRole('button', { name: '上移列表', exact: true }).click();
  await expect(page.locator('.p1-playlist-pane > button').nth(1)).toContainText('正式演出');
  await page.locator('.p1-media-card').dragTo(page.locator('.p1-playlist-pane > button').filter({ hasText: '暖场' }));
  await expect(page.locator('.p1-media-card')).toHaveCount(0);
  await page.locator('.p1-playlist-pane > button').filter({ hasText: '暖场' }).click();
  await page.locator('.p1-media-card').dragTo(page.locator('.p1-playlist-pane > button').filter({ hasText: '正式演出' }));
  await application.evaluate(({ dialog }, destination) => { dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: destination }); }, testInfo.outputPath('playlist.tblink'));
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  await page.reload();
  await page.locator('.p1-playlist-pane > button').filter({ hasText: '正式演出' }).click();
  await expect(page.locator('.p1-media-card')).toHaveCount(1);
  await page.locator('.p1-playlist-pane > button').filter({ hasText: '正式演出' }).click({ button: 'right' });
  await page.getByRole('button', { name: '删除列表', exact: true }).click();
  await page.getByRole('button', { name: '删除列表，保留歌曲' }).click();
  await page.locator('.p1-playlist-pane > button').filter({ hasText: '未分组' }).click();
  await expect(page.locator('.p1-media-card')).toHaveCount(1);
  await expect(page.locator('.p1-playlist-pane > button').filter({ hasText: '正式演出' })).toHaveCount(0);
});

let application: ElectronApplication;
let page: Page;

test('播放预检阻断直接展示节目、原因和处理办法，紧凑窗口不遮挡控件', async ({}, testInfo) => {
  const audioPath = testInfo.outputPath('notice.wav');
  const projectPath = testInfo.outputPath('notice.tblink');
  await createAudioFixture(audioPath);
  const project = parseLinkProject({ ...createEmptyLinkProject('播放诊断'), playbackSource: 'internal', obsOutputMode: 'scenes', rundown: [{
    id: 'song', title: '387..MP4', referenceAudio: { assetId: 'audio', relativePath: 'notice.wav', sha256: createHash('sha256').update(await readFile(audioPath)).digest('hex'), durationMs: 4000 },
    cues: [{ id: 'cue', name: '显示画面', durationMs: 1000, timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, actions: [{ id: 'source', label: '显示来源 · 显示器采集', kind: 'obs.setSceneItemEnabled', sceneName: '测试场景', sourceName: '显示器采集', enabled: true }] }]
  }] });
  await writeFile(projectPath, JSON.stringify(project));
  await page.evaluate((profile) => window.tbLink.saveIntegrationProfile({ profile }), createDefaultIntegrationProfile());
  await page.reload();
  await application.evaluate(({ ipcMain, BrowserWindow, dialog }, path) => {
    const status = { status: 'connected', obsVersion: '32.2.2', webSocketVersion: '5.6.3', error: null };
    const handlers: Record<string, () => unknown> = {
      'link:obs-connect': () => status, 'link:obs-snapshot': () => status,
      'link:security-preflight': () => ({ credentialDecryptable: true, logRedactionReady: true }),
      'link:obs-inventory': () => ({ videoSettings: { baseWidth: 1080, baseHeight: 1920 }, scenes: ['测试场景'], inputs: [], inputKinds: {}, sceneItems: { 测试场景: [] }, filters: {}, transitions: [], inputAudioStates: {}, sourceSizes: {} })
    };
    for (const [channel, handler] of Object.entries(handlers)) { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler); }
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] });
    BrowserWindow.getAllWindows()[0]!.setSize(1180, 800);
    BrowserWindow.getAllWindows()[0]!.webContents.send('link:obs-status', status);
  }, projectPath);
  await page.getByRole('button', { name: '打开工程', exact: true }).click();
  const before = await page.locator('.unified-player').boundingBox();
  await page.locator('.player-buttons').getByRole('button', { name: '播放', exact: true }).click();
  const notice = page.locator('.player-status-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('播放未开始：预检未通过');
  await expect(notice).toContainText('完整场景模式：387..MP4');
  await expect(notice).toContainText('显示来源 · 显示器采集');
  await expect(notice).toContainText('Cue 编排');
  await expect(notice.locator('details')).toHaveCount(0);
  const bounds = await notice.boundingBox();
  const spectrum = await page.locator('.home-spectrum-monitor').boundingBox();
  expect(await page.locator('.unified-player').boundingBox()).toEqual(before);
  expect(bounds!.x).toBeGreaterThanOrEqual(spectrum!.x);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(spectrum!.y + spectrum!.height);
  await page.screenshot({ path: testInfo.outputPath('playback-notice.png') });
  await notice.getByRole('button', { name: '关闭播放提示' }).click();
  await expect(notice).toHaveCount(0);
  await page.locator('.player-buttons').getByRole('button', { name: '播放', exact: true }).click();
  await expect(notice).toBeVisible();
  await notice.locator('p').click();
  await expect(notice).toBeVisible();
  await page.locator('.p1-digital-panel').click();
  await expect(notice).toHaveCount(0);
});

test('编辑器共用正式播放器，打点和菜单切换不中断，暂停定位重新激活 OBS', async ({}, testInfo) => {
  const audioPath = testInfo.outputPath('transport.wav');
  const projectPath = testInfo.outputPath('transport.tblink');
  await createAudioFixture(audioPath, 440, 30);
  const lighting = createLightingDocument();
  lighting.tracks = [{ id: 'light', name: '灯光', kind: 'ma2', color: '#ffffff', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: 'clip', name: '灯光', start: 0, duration: 30000, timeLock: 'time', muted: false, events: [] }] }];
  const project = parseLinkProject({ ...createEmptyLinkProject('共用播放验收'), schemaVersion: 2, playbackSource: 'internal', obsOutputMode: 'scenes', rundown: [{ id: 'song', title: '共用歌曲', lighting,
    referenceAudio: { assetId: 'audio', relativePath: 'transport.wav', sha256: createHash('sha256').update(await readFile(audioPath)).digest('hex'), durationMs: 30000 },
    cues: [{ id: 'scene', name: '正式画面', timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, actions: [{ id: 'action', kind: 'obs.setProgramScene', label: '切换正式画面', sceneName: '测试场景' }] }] }] });
  await writeFile(projectPath, JSON.stringify(project));
  const profile = createDefaultIntegrationProfile();
  profile.midiPortProfiles.push({ id: 'lighting-record-input', direction: 'input', portName: 'Transport Input' });
  await page.evaluate((value) => window.tbLink.saveIntegrationProfile({ profile: value }), profile);
  await page.addInitScript(() => {
    const input = Object.assign(new EventTarget(), { id: 'record', name: 'Transport Input', type: 'input', state: 'connected', open: () => Promise.resolve() });
    Reflect.set(window, '__transportInput', input);
    const access = Object.assign(new EventTarget(), { inputs: new Map([['record', input]]), outputs: new Map() });
    Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: () => Promise.resolve(access) });
  });
  await page.reload();
  await application.evaluate(({ ipcMain, BrowserWindow, dialog }, path) => {
    Reflect.set(globalThis, '__transportActions', []);
    const handlers: Record<string, (...args: unknown[]) => unknown> = {
      'link:obs-connect': () => ({ status: 'connected', obsVersion: '32.2.2', webSocketVersion: '5.6.3', error: null }),
      'link:obs-snapshot': () => ({ status: 'connected', obsVersion: '32.2.2', webSocketVersion: '5.6.3', error: null }),
      'link:security-preflight': () => ({ credentialDecryptable: true, logRedactionReady: true }),
      'link:obs-inventory': () => ({ videoSettings: { baseWidth: 1080, baseHeight: 1920 }, scenes: ['测试场景'], inputs: [], inputKinds: {}, sceneItems: { 测试场景: [] }, filters: {}, transitions: [], inputAudioStates: {}, sourceSizes: {} }),
      'link:obs-internal-audio': () => undefined,
      'link:obs-execute': (...args) => { (Reflect.get(globalThis, '__transportActions') as unknown[]).push(args[1]); }
    };
    for (const [channel, handler] of Object.entries(handlers)) { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler); }
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] });
    BrowserWindow.getAllWindows()[0]!.webContents.send('link:obs-status', { status: 'connected', obsVersion: '32.2.2', webSocketVersion: '5.6.3', error: null });
  }, projectPath);
  await page.getByRole('button', { name: '打开工程', exact: true }).click();
  const navigation = page.getByRole('navigation', { name: '主要工作区' });
  await navigation.getByRole('button', { name: '编辑器', exact: true }).click();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('link:obs-status', { status: 'connected', obsVersion: '32.2.2', webSocketVersion: '5.6.3', error: null }));
  await expect(page.getByLabel('连接状态', { exact: true })).toContainText('主控本机播放');
  await expect(page.locator('.timeline-toolbar > audio')).toHaveCount(0);
  await page.getByRole('button', { name: '录制灯光', exact: true }).click();
  await expect(page.getByRole('button', { name: '结束录制', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '播放时间线', exact: true }).click();
  await expect(page.getByRole('button', { name: '暂停时间线', exact: true })).toBeVisible();
  await expect.poll(() => application.evaluate(() => (Reflect.get(globalThis, '__transportActions') as unknown[]).length)).toBe(1);
  await page.evaluate(() => {
    const event = new Event('midimessage'); Object.defineProperty(event, 'data', { value: new Uint8Array([0xb0, 7, 96]) });
    (Reflect.get(window, '__transportInput') as EventTarget).dispatchEvent(event);
  });
  await page.getByRole('button', { name: '结束录制', exact: true }).click();
  await expect(page.locator('.lighting-clip')).toHaveCount(2);
  await page.locator('.lighting-track-name').click();
  await page.locator('.reference-timeline').press('KeyM');
  await expect(page.locator('.lighting-timeline-point')).toHaveCount(2);
  await expect(page.getByRole('button', { name: '暂停时间线', exact: true })).toBeVisible();
  await navigation.getByRole('button', { name: '节目单', exact: true }).click();
  await expect(page.locator('.player-transport')).toHaveClass(/status-playing/);
  await navigation.getByRole('button', { name: '编辑器', exact: true }).click();
  await page.getByRole('button', { name: '暂停时间线', exact: true }).click();
  const paused = await page.locator('.timeline-transport code').textContent();
  await page.waitForTimeout(250);
  await expect(page.locator('.timeline-transport code')).toHaveText(paused!);
  await page.getByRole('button', { name: '回到时间线开头', exact: true }).click();
  await expect(page.locator('.timeline-transport code')).toHaveText('00:00:00:00');
  await page.getByRole('button', { name: '播放时间线', exact: true }).click();
  await expect(page.getByRole('button', { name: '暂停时间线', exact: true })).toBeVisible();
  await expect.poll(() => application.evaluate(() => (Reflect.get(globalThis, '__transportActions') as unknown[]).length)).toBe(2);
  await page.getByRole('button', { name: '停止时间线', exact: true }).click();
  await expect(page.getByRole('button', { name: '播放时间线', exact: true })).toBeVisible();
  await expect.poll(async () => parseLinkProject(JSON.parse(await readFile(projectPath, 'utf8'))).rundown[0]?.lighting?.tracks[0]?.clips[0]?.events.length).toBe(1);
  await page.screenshot({ path: testInfo.outputPath('shared-transport.png') });
});

test.beforeEach(async ({}, testInfo) => {
  application = await electron.launch({
    args: [`--user-data-dir=${testInfo.outputPath('user-data')}`, desktopEntry]
  });
  page = await application.firstWindow();
  await page.evaluate(() => {
    localStorage.removeItem('tblink.cue-workspace-layout.v1');
    localStorage.removeItem('tblink.last-project-path.v1');
  });
  await page.reload();
});

test.afterEach(async () => {
  await page.evaluate(() => Promise.all([
    window.tbLink.setDocumentDirty(false),
    window.tbLink.setRuntimeActive(false)
  ]));
  await application.close();
});

async function openSettingsDialog(): Promise<void> {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: /设备连接/ }).click();
  await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeVisible();
  const followSettings = page.locator('.p1-follow-settings');
  if (await followSettings.isVisible() && !(await followSettings.getAttribute('open') !== null)) await followSettings.locator('summary').first().click();
}

async function closeSettingsDialog(): Promise<void> {
  await page.getByRole('button', { name: /节目单/ }).first().click();
  await expect(page.getByRole('dialog', { name: '设置', exact: true })).toHaveCount(0);
}

test('主窗口、最小 preload 和新工程工作流可用', async ({}, testInfo) => {
  await expect(page).toHaveTitle(/团播联动台/);
  await expect(page.getByText('节目单', { exact: true }).first()).toBeVisible();
  const nativeChrome = await application.evaluate(({ BrowserWindow, Menu }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error('主窗口不存在');
    return {
      windowSize: window.getSize(),
      contentSize: window.getContentSize(),
      hasMenu: Menu.getApplicationMenu() !== null
    };
  });
  expect(nativeChrome.windowSize).toEqual(nativeChrome.contentSize);
  expect(nativeChrome.hasMenu).toBe(false);
  await expect(page.getByRole('button', { name: '最小化窗口' })).toBeVisible();
  await expect(page.getByRole('button', { name: '最大化或还原窗口' })).toBeVisible();
  await expect(page.getByRole('button', { name: '关闭窗口' })).toBeVisible();
  await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible();
  await expect(page.locator('.unified-toolbar .update-trigger')).toHaveCount(0);
  const bridge = await page.evaluate(() => ({
    hasLink: typeof window.tbLink === 'object',
    hasLegacyRuntime: 'tbRuntime' in window,
    hasNodeProcess: 'process' in window,
    keys: Object.keys(window.tbLink)
  }));
  expect(bridge.hasLink).toBe(true);
  expect(bridge.hasLegacyRuntime).toBe(false);
  expect(bridge.hasNodeProcess).toBe(false);
  expect(bridge.keys).not.toEqual(expect.arrayContaining(['openProgramWindow', 'listDesktopCaptureSources', 'rtmpStart', 'obsStart']));
  expect(bridge.keys).toEqual(expect.arrayContaining([
    'controlWindow',
    'setRuntimeActive',
    'detectLocalIntegrations',
    'importMediaAsset',
    'ensureMediaPreviewUrl',
    'ensureMediaAudioUrl',
    'detectCurrentP1Project',
    'importP1Project',
    'previewP1ProjectExport',
    'exportP1Project',
    'readObsInventory',
    'getObsSourceScreenshot',
    'activateManagedObsOutput',
    'executeManagedMediaEvent',
    'getUpdateStatus',
    'saveUpdateToken',
    'clearUpdateToken',
    'checkForUpdates',
    'downloadUpdate',
    'installUpdate',
    'onUpdateStatus'
  ]));

  await openSettingsDialog();
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '外观与更新', exact: true }).click();
  await page.getByRole('button', { name: '软件更新' }).click();
  await expect(page.getByRole('dialog', { name: '软件更新', exact: true }).getByRole('heading', { name: '软件更新' })).toBeVisible();
  await expect(page.getByText('开发模式不执行安装更新，请使用 Windows 安装版验证')).toBeVisible();
  const developmentVersion = await application.evaluate(({ app }) => app.getVersion());
  await expect(page.getByText(`当前版本 ${developmentVersion}`)).toBeVisible();
  await page.getByRole('button', { name: '关闭软件更新' }).click();
  await closeSettingsDialog();

  await beginNewProject();
  await page.getByLabel('工程名称').fill('E2E 联动工程');
  await page.getByRole('button', { name: '创建工程' }).click();
  await expect(page.locator('.p1-project-workspace')).toBeVisible();
  const projectPath = testInfo.outputPath('e2e-project.tblink');
  await application.evaluate(({ dialog }, destination) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: destination });
  }, projectPath);
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.locator('.project-save-status')).toHaveText('已自动保存');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: /画面与同步/ }).click();
  await expect(page.getByLabel('工程输出画布')).toHaveCount(0);
  await expect(page.getByLabel('工程输出分辨率')).toHaveCount(0);
  await expect(page.getByText('画布、分辨率和方向统一在 OBS 中设置', { exact: true })).toBeVisible();
  await expect.poll(async () => parseLinkProject(JSON.parse(await readFile(projectPath, 'utf8'))).outputCanvas).toEqual({ width: 1080, height: 1920 });
  await expect(page.getByLabel('工程帧率')).toHaveValue('30');
  await page.getByLabel('工程帧率').selectOption('25');
  await expect(page.getByLabel('工程帧率')).toHaveValue('25');
  await page.getByLabel('工程帧率').selectOption('30');
  await closeSettingsDialog();
  await addEmptyProgram();
  await expect(page.getByRole('button', { name: /全部节目/ })).toBeVisible();
  await expect(page.locator('.p1-media-pane .p1-pane-title')).toContainText('节目单');
  await page.getByRole('button', { name: '节目属性', exact: true }).click();
  await expect(page.getByText('编辑节目', { exact: true })).toBeVisible();
  await expect(page.locator('.p1-media-card')).toHaveCount(1);
  await page.locator('.p1-media-card').click({ button: 'right' });
  await expect(page.getByRole('button', { name: '打开 Cue 编辑器' })).toBeVisible();
  await page.locator('.toolbar-project-summary').click();
  await expect(page.getByRole('button', { name: '打开 Cue 编辑器' })).toHaveCount(0);
  await expect(page.locator('input.title-input')).toHaveValue('节目 1');
  await page.screenshot({ path: testInfo.outputPath('p1-style-project-workspace.png') });
  expect(await page.locator('.p1-inspector-content').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await expect(page.getByText('当前节目', { exact: true })).toHaveCount(0);
  const itemEnabled = page.getByRole('checkbox', { name: '启用' });
  await expect(itemEnabled).toBeChecked();
  await itemEnabled.uncheck();
  await expect(page.locator('.rundown-row')).toHaveClass(/is-disabled/);
  await itemEnabled.check();

  await page.getByRole('button', { name: /编辑器/ }).click();
  await expect(page.getByRole('button', { name: /修改节目名称：/ })).toBeVisible();
  await page.getByRole('button', { name: /节目单/ }).click();
  await page.locator('.rundown-index').click();
  await expect(page.locator('.p1-media-card').getByText('当前节目', { exact: true })).toBeVisible();
  await page.locator('.p1-media-card').click({ button: 'right' });
  await page.getByRole('button', { name: '打开 Cue 编辑器' }).click();
  await expect(page.locator('.reference-stage .stage-canvas.portrait')).toBeVisible();
  await expect(page.locator('.reference-stage .stage-toolbar')).toHaveCount(0);
  await expect(page.getByText('1080×1920', { exact: true })).toBeVisible();
  await expect(page.getByText('P1 直播放', { exact: true })).toHaveCount(0);
  await expect(page.getByText('先选同名节目，播放后自动跟随 MTC', { exact: true })).toHaveCount(0);
  const applicationBorder = await page.locator('.stage-frame').evaluate((element) => {
    const style = window.getComputedStyle(element, '::after');
    return { borderStyle: style.borderStyle, content: style.content, zIndex: style.zIndex };
  });
  expect(applicationBorder).toEqual({ borderStyle: 'solid', content: '\"\"', zIndex: '2147483647' });
  await expect(page.locator('.workspace-splitter')).toHaveCount(2);
  const resourceBefore = await page.locator('.cue-inspector').boundingBox();
  const resourceSplitter = page.getByRole('button', { name: '调整属性面板宽度', exact: true });
  const splitterBox = await resourceSplitter.boundingBox();
  if (!resourceBefore || !splitterBox) throw new Error('资源库分隔线尺寸不可用');
  await page.mouse.move(splitterBox.x + 2, splitterBox.y + 20);
  await page.mouse.down();
  await page.mouse.move(splitterBox.x - 42, splitterBox.y + 20);
  await page.mouse.up();
  const resourceAfter = await page.locator('.cue-inspector').boundingBox();
  expect(resourceAfter?.width).toBeGreaterThan(resourceBefore.width + 30);
  await expect(page.getByText('媒体', { exact: true })).toBeVisible();
  const resourceFilter = page.locator('.resource-filterbar select');
  await expect(resourceFilter).toHaveCSS('color-scheme', 'dark');
  const optionPalette = await resourceFilter.locator('option').first().evaluate((option) => {
    const style = getComputedStyle(option);
    return { color: style.color, backgroundColor: style.backgroundColor };
  });
  expect(optionPalette).toEqual(await page.locator('html').getAttribute('data-theme') === 'light'
    ? { color: 'rgb(23, 32, 51)', backgroundColor: 'rgb(240, 242, 246)' }
    : { color: 'rgb(246, 248, 252)', backgroundColor: 'rgb(32, 36, 45)' });
  await expect(page.getByRole('button', { name: '添加来源或媒体' })).toBeVisible();
  await expect(page.getByRole('button', { name: '工程资源' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'OBS 资源', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '刷新 OBS 资源' })).toBeVisible();
  await page.locator('.media-table-body').click({ button: 'right' });
  await expect(page.getByRole('button', { name: '导入视频素材', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '添加音频', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '添加图片', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('resource-library-context-menu.png') });
  await page.getByRole('button', { name: '新建文件夹' }).last().click();
  await page.locator('.new-folder-editor input').fill('测试资源');
  await page.getByRole('button', { name: '确定' }).click();
  await expect(page.locator('.folder-row').getByText('测试资源')).toBeVisible();
  await page.locator('.folder-row').click({ button: 'right' });
  await page.getByRole('button', { name: '重命名文件夹' }).click();
  await page.locator('.media-inline-name').fill('演出素材');
  await page.locator('.media-inline-name').press('Enter');
  await expect(page.locator('.folder-row').getByText('演出素材')).toBeVisible();
  await expect(page.getByText('图层 2', { exact: true })).toBeVisible();
  await expect(page.getByText('图层 1', { exact: true })).toBeVisible();
  const layerHeadings = page.locator('.visual-layer-heading');
  await expect(layerHeadings.locator('.layer-name')).toHaveText(['图层 2', '图层 1']);
  const topLayerNameBox = await layerHeadings.nth(0).locator('.layer-name').boundingBox();
  const bottomLayerNameBox = await layerHeadings.nth(1).locator('.layer-name').boundingBox();
  if (!topLayerNameBox || !bottomLayerNameBox) throw new Error('图层标题整行拖动区域不可用');
  await page.mouse.move(topLayerNameBox.x + topLayerNameBox.width / 2, topLayerNameBox.y + topLayerNameBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(bottomLayerNameBox.x + bottomLayerNameBox.width / 2, bottomLayerNameBox.y + bottomLayerNameBox.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(layerHeadings.locator('.layer-name')).toHaveText(['图层 1', '图层 2']);
  await page.getByTitle('撤销').click();
  await expect(layerHeadings.locator('.layer-name')).toHaveText(['图层 2', '图层 1']);
  await expect(page.getByText('歌曲音频', { exact: true })).toBeVisible();
  await expect(page.getByText('MIDI 动作', { exact: true })).toHaveCount(0);
  await expect(page.getByText('灯光 Cue', { exact: true })).toHaveCount(0);
  const hevcFixture = testInfo.outputPath('hevc-with-audio.mp4');
  await createHevcFixture(hevcFixture);
  await page.locator('.resource-library input[type="file"]').setInputFiles(hevcFixture);
  const hevcAsset = page.locator('.asset-row').filter({ hasText: 'hevc-with-audio.mp4' });
  await expect(hevcAsset).toBeVisible({ timeout: 30_000 });
  await hevcAsset.dblclick();
  const stageLayer = page.locator('.stage-media-layer');
  const stageVideo = stageLayer.locator('video');
  await expect(stageLayer).toBeVisible();
  await expect.poll(() => stageVideo.evaluate((video) => ({ width: (video as HTMLVideoElement).videoWidth, readyState: (video as HTMLVideoElement).readyState }))).toMatchObject({ width: 320, readyState: expect.any(Number) });
  await expect.poll(() => stageVideo.evaluate((video) => (video as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  await expect(stageVideo).toHaveJSProperty('muted', false);
  await expect(page.locator('.clip-inspector .visual-layout-editor')).toBeVisible();
  await expect(page.locator('.clip-inspector .visual-source-summary')).toContainText('原始尺寸 320 × 568');
  await page.screenshot({ path: testInfo.outputPath('media-properties.png') });
  const positionX = page.locator('.clip-inspector').getByRole('spinbutton', { name: '位置 X', exact: true });
  const positionY = page.locator('.clip-inspector').getByRole('spinbutton', { name: '位置 Y', exact: true });
  const originalX = await positionX.inputValue();
  await positionX.fill('640');
  await positionX.press('Enter');
  await expect(positionX).toHaveValue('640');
  await positionY.focus();
  await positionY.press('Tab');
  await positionX.fill('');
  await positionX.press('Tab');
  await expect(positionX).toHaveValue('640');
  await positionX.fill('800');
  await positionX.press('Escape');
  await expect(positionX).toHaveValue('640');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(positionX).toHaveValue(originalX);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(positionX).toHaveValue('640');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(positionX).toHaveValue(originalX);
  await stageLayer.click({ button: 'right' });
  const stageMediaMenu = page.locator('.stage-media-context-menu');
  await expect(stageMediaMenu.getByRole('button', { name: '原始大小' })).toBeVisible();
  await expect(stageMediaMenu.getByRole('button', { name: '画布居中' })).toBeVisible();
  await expect(stageMediaMenu.getByRole('button', { name: '适应画布' })).toBeVisible();
  await expect(stageMediaMenu.getByRole('button', { name: '移到最顶图层' })).toBeVisible();
  await expect(stageMediaMenu.getByRole('button', { name: '从时间线删除' })).toBeVisible();
  await stageMediaMenu.getByRole('button', { name: '画布居中' }).click();
  await expect.poll(() => stageLayer.evaluate((element) => Number.parseFloat((element as HTMLElement).style.left))).toBe(50);
  await expect(page.locator('.timeline-clip').first().locator('.timeline-trim-handle')).toHaveCount(2);
  await expect(page.getByRole('button', { name: '播放时间线' })).toBeVisible();
  await expect(page.getByRole('button', { name: '上一帧' })).toBeVisible();
  await expect(page.getByRole('button', { name: '下一帧' })).toBeVisible();
  const visualLanes = page.locator('.timeline-lane[data-visual-layer-id]');
  await expect(visualLanes.nth(0).locator('.timeline-clip')).toHaveCount(1);
  await expect(layerHeadings.nth(0).locator('.layer-name')).toHaveText('hevc-with-audio.mp4');
  const clipBeforeLayerMove = await visualLanes.nth(0).locator('.timeline-clip').boundingBox();
  const targetVisualLaneBox = await visualLanes.nth(1).boundingBox();
  if (!clipBeforeLayerMove || !targetVisualLaneBox) throw new Error('素材跨图层拖动区域不可用');
  await page.mouse.move(clipBeforeLayerMove.x + clipBeforeLayerMove.width / 2, clipBeforeLayerMove.y + clipBeforeLayerMove.height / 2);
  await page.mouse.down();
  await page.mouse.move(clipBeforeLayerMove.x + clipBeforeLayerMove.width / 2, targetVisualLaneBox.y + targetVisualLaneBox.height / 2, { steps: 6 });
  await expect(visualLanes.nth(1)).toHaveClass(/is-drop-target/);
  await expect.poll(() => visualLanes.nth(0).locator('.timeline-clip').evaluate((element) => Number.parseFloat(getComputedStyle(element).translate.split(' ')[1] ?? '0'))).toBeGreaterThan(40);
  await page.mouse.up();
  await expect(visualLanes.nth(1).locator('.timeline-clip')).toHaveCount(1);
  await expect(visualLanes.nth(0).locator('.timeline-clip')).toHaveCount(0);
  await expect(layerHeadings.nth(1).locator('.layer-name')).toHaveText('hevc-with-audio.mp4');
  await page.getByTitle('撤销').click();
  await expect(visualLanes.nth(0).locator('.timeline-clip')).toHaveCount(1);
  await expect(layerHeadings.nth(0).locator('.layer-name')).toHaveText('hevc-with-audio.mp4');

  const embeddedAudioToggle = page.getByRole('checkbox', { name: /片段声音/ });
  await expect(embeddedAudioToggle).toBeChecked();
  await embeddedAudioToggle.uncheck();
  await expect(embeddedAudioToggle).not.toBeChecked();
  await expect(page.locator('.timeline-clip')).toHaveCount(1);
  await expect(stageLayer).toBeVisible();
  await page.getByTitle('撤销').click();
  await expect(embeddedAudioToggle).toBeChecked();
  const layerBeforeMove = await stageLayer.boundingBox();
  if (!layerBeforeMove) throw new Error('画布素材拖动前位置不可用');
  const layerLeftBeforeMove = await stageLayer.evaluate((element) => Number.parseFloat((element as HTMLElement).style.left) || 0);
  await page.mouse.move(layerBeforeMove.x + layerBeforeMove.width / 2, layerBeforeMove.y + layerBeforeMove.height / 2);
  await page.mouse.down();
  await page.mouse.move(layerBeforeMove.x + layerBeforeMove.width / 2 + 50, layerBeforeMove.y + layerBeforeMove.height / 2 + 35, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => stageLayer.evaluate((element) => Number.parseFloat((element as HTMLElement).style.left))).toBeGreaterThan(layerLeftBeforeMove + 10);
  await page.getByRole('button', { name: '播放时间线' }).click();
  await expect.poll(() => stageVideo.evaluate((video) => (video as HTMLVideoElement).currentTime)).toBeGreaterThan(0);
  await page.getByRole('button', { name: '暂停时间线' }).click();
  const originalClip = page.locator('.timeline-clip').first();
  const originalClipBox = await originalClip.boundingBox();
  const rulerBoxForSplit = await page.locator('.timeline-ruler').boundingBox();
  if (!originalClipBox || !rulerBoxForSplit) throw new Error('时间线切割定位尺寸不可用');
  await page.mouse.click(originalClipBox.x + originalClipBox.width / 2, rulerBoxForSplit.y + rulerBoxForSplit.height / 2);
  await originalClip.click();
  await page.locator('.reference-timeline').press('s');
  await expect(page.locator('.timeline-clip')).toHaveCount(2);
  await page.locator('.reference-timeline').press('Control+c');
  await page.locator('.lighting-clip').first().click({ position: { x: 20, y: 50 } });
  await page.locator('.reference-timeline').press('Control+v');
  await expect(page.locator('.timeline-clip')).toHaveCount(2);
  await originalClip.click();
  await page.mouse.click(rulerBoxForSplit.x + Math.min(rulerBoxForSplit.width - 20, 180), rulerBoxForSplit.y + rulerBoxForSplit.height / 2);
  await page.locator('.reference-timeline').press('Control+v');
  await expect(page.locator('.timeline-clip')).toHaveCount(3);
  await page.locator('.timeline-clip.is-selected').click({ button: 'right' });
  const timelineContextMenu = page.locator('.timeline-context-menu');
  await expect(timelineContextMenu.getByRole('button', { name: /在播放头切割/ })).toBeVisible();
  await expect(timelineContextMenu.getByRole('button', { name: /复制片段/ })).toBeVisible();
  await expect(timelineContextMenu.getByRole('button', { name: /粘贴到播放头/ })).toBeVisible();
  await page.locator('.timeline-toolbar').click();
  await page.screenshot({ path: testInfo.outputPath('interactive-hevc-reference-stage.png') });
  await expect(page.getByRole('button', { name: /添加 Cue/ })).toHaveCount(0);
  await application.evaluate(({ ipcMain, BrowserWindow }) => {
    ipcMain.removeHandler('link:obs-inventory');
    ipcMain.handle('link:obs-inventory', () => ({ scenes: ['测试摄像头 A', '测试摄像头 B'], inputs: [], inputKinds: {}, sceneItems: { '测试摄像头 A': [], '测试摄像头 B': [] }, filters: {}, transitions: [], inputAudioStates: {}, sourceSizes: {} }));
    BrowserWindow.getAllWindows()[0]!.webContents.send('link:obs-status', { status: 'connected', obsVersion: '32.2.2', webSocketVersion: '5.6.3', error: null });
  });
  await page.getByRole('button', { name: '刷新 OBS 资源', exact: true }).click();
  for (const [index, name] of ['测试摄像头 A', '测试摄像头 B'].entries()) {
    await page.locator('.obs-camera-row').filter({ hasText: name }).dblclick();
    await page.locator('.cue-inspector .title-input').fill(`Cue ${index + 1}`);
    await page.locator('.cue-inspector .title-input').press('Tab');
  }
  const layerCues = page.locator('.timeline-lane[data-visual-layer-id] .timeline-cue');
  await expect(layerCues).toHaveCount(2);
  const timelineViewport = page.locator('.timeline-viewport');
  const contentWidthBeforeZoom = await page.locator('.timeline-content').evaluate((element) => element.getBoundingClientRect().width);
  await timelineViewport.hover();
  await page.keyboard.down('Control');
  for (let step = 0; step < 20; step += 1) await page.mouse.wheel(0, -280);
  await page.keyboard.up('Control');
  await expect.poll(() => page.locator('.timeline-content').evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(contentWidthBeforeZoom);
  await page.mouse.wheel(0, 280);
  await expect.poll(() => timelineViewport.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await timelineViewport.evaluate((element) => {
    element.scrollLeft = 0;
    element.dispatchEvent(new Event('scroll'));
  });
  await page.getByRole('button', { name: '适合节目时长' }).click();
  const cueToMove = layerCues.filter({ hasText: 'Cue 2' });
  const cueBeforeMove = await cueToMove.boundingBox();
  if (!cueBeforeMove) throw new Error('Cue 拖动前位置不可用');
  await page.mouse.move(cueBeforeMove.x + 12, cueBeforeMove.y + 8);
  await page.mouse.down();
  await page.mouse.move(cueBeforeMove.x + 132, cueBeforeMove.y + 8, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await cueToMove.boundingBox())?.x ?? 0).toBeGreaterThan(cueBeforeMove.x + 80);
  await layerCues.filter({ hasText: 'Cue 1' }).click();
  await expect(page.locator('.cue-inspector .title-input')).toHaveValue('Cue 1');
  await expect(page.locator('.cue-inspector .track-labels')).toHaveCount(0);
  await expect(page.locator('.cue-inspector .add-action-row')).toHaveCount(0);
  const playheadBeforeCueSelection = await page.locator('.timeline-transport code').textContent();
  if (!playheadBeforeCueSelection) throw new Error('选择 Cue 前无法读取播放头');
  await layerCues.filter({ hasText: 'Cue 2' }).click();
  await expect(page.locator('.timeline-transport code')).toHaveText(playheadBeforeCueSelection);
  await expect(page.locator('.cue-inspector .title-input')).toHaveValue('Cue 2');
  await page.locator('.cue-inspector .title-input').fill('第二个 Cue');
  await page.locator('.cue-inspector .title-input').press('Tab');
  await layerCues.filter({ hasText: '第二个 Cue' }).click();
  await expect(page.locator('.cue-inspector .title-input')).toHaveValue('第二个 Cue');
  await page.screenshot({ path: testInfo.outputPath('resource-library-lighting-workspace.png') });
  await expect(page.getByRole('button', { name: /演出控制/ })).toHaveCount(0);
  await openSettingsDialog();
  await expect(page.getByText('当前节目：节目 1', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '启动设备并准备跟随 P1' })).toBeEnabled();
  await expect(page.getByText('Windows 安全存储')).toBeVisible();
  await expect(page.getByText('P1 MTC 输入尚未接通')).toBeVisible();
  await expect(page.locator('.integration-tools-menu')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '本机设置' })).toHaveCount(0);
  await expect(page.getByText('P1 音频工程同步')).toBeVisible();
  await expect(page.locator('.p1-import-menu > summary')).toBeVisible();
  await expect(page.getByRole('button', { name: '读取 P1 当前工程' })).not.toBeVisible();
  await expect(page.getByRole('button', { name: '选择 .hia 文件' })).not.toBeVisible();
  await expect(page.getByRole('button', { name: '同步回 P1 工程' })).toBeDisabled();
  await openSettingsDialog();
  await expect(page.getByRole('button', { name: '一键识别并连接' })).toBeVisible();
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: /设备连接/ }).click();
  await expect(page.getByRole('button', { name: '打开诊断与日志' })).toHaveCount(0);
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: /设备连接/ }).click();
  await page.screenshot({ path: testInfo.outputPath('codex-sidebar-settings.png') });
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
  await expect(page.locator('.program-configuration[open]')).toHaveCount(2);
  await expect(page.getByText('直播伴侣')).toHaveCount(0);
  await expect(page.locator('.device-maintenance-backdrop')).toHaveCount(0);
  const configurationHeaders = await page.locator('.program-card-title').evaluateAll((summaries) => (
    summaries.map((summary) => { const bounds = summary.getBoundingClientRect(); return { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right }; })
  ));
  expect(configurationHeaders).toHaveLength(2);
  const [firstConfiguration, secondConfiguration] = configurationHeaders;
  expect(secondConfiguration!.top >= firstConfiguration!.bottom || secondConfiguration!.left >= firstConfiguration!.right).toBe(true);
  await page.getByRole('button', { name: 'OBS Studio 故障处理' }).scrollIntoViewIfNeeded();
  const deviceGridBeforeMaintenance = await page.locator('.integration-grid').boundingBox();
  await page.getByRole('button', { name: 'OBS Studio 故障处理' }).click();
  await expect(page.getByRole('dialog', { name: 'OBS Studio 故障处理' })).toBeVisible();
  expect(await page.locator('.integration-grid').boundingBox()).toEqual(deviceGridBeforeMaintenance);
  await expect(page.getByLabel('工作目录')).toBeVisible();
  await expect(page.getByLabel('启动参数（每行一个）')).toBeVisible();
  await page.getByRole('button', { name: '关闭 OBS Studio 故障处理' }).click();
  await expect(page.locator('.device-maintenance-backdrop')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /运行日志/ })).toHaveCount(0);
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: /设备连接/ }).click();
  await expect(page.getByRole('button', { name: '打开诊断与日志' })).toHaveCount(0);
  await closeSettingsDialog();
});

test('保存旧快照不会清除后来修改的退出保护', async ({}, testInfo) => {
  await page.evaluate(async (destination) => {
    const project = await window.tbLink.createProject('旧快照');
    await window.tbLink.setDocumentDirty(true);
    await window.tbLink.saveProject(destination, project);
  }, testInfo.outputPath('snapshot.tblink'));
  const result = await application.evaluate(({ BrowserWindow, dialog }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error('主窗口不存在');
    let warningTitle = '';
    const mutableDialog = dialog as unknown as { showMessageBoxSync: (...args: unknown[]) => number };
    mutableDialog.showMessageBoxSync = (...args: unknown[]) => {
      const options = (args.length > 1 ? args[1] : args[0]) as { title?: string } | undefined;
      warningTitle = options?.title ?? '';
      return 0;
    };
    window.close();
    return { warningTitle, destroyed: window.isDestroyed() };
  });
  expect(result).toEqual({ warningTitle: '工程尚未保存', destroyed: false });
});

test('运行会话未停止时主进程拒绝关闭窗口', async () => {
  await page.evaluate(() => window.tbLink.setRuntimeActive(true));
  const result = await application.evaluate(({ BrowserWindow, dialog }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error('主窗口不存在');
    const mutableDialog = dialog as unknown as { showMessageBoxSync: (...args: unknown[]) => number };
    const original = mutableDialog.showMessageBoxSync;
    let warningTitle = '';
    mutableDialog.showMessageBoxSync = (...args: unknown[]) => {
      const options = (args.length > 1 ? args[1] : args[0]) as { title?: string } | undefined;
      warningTitle = options?.title ?? '';
      return 0;
    };
    try {
      window.close();
      return { warningTitle, destroyed: window.isDestroyed() };
    } finally {
      mutableDialog.showMessageBoxSync = original;
    }
  });
  expect(result).toEqual({ warningTitle: '联动尚未停止', destroyed: false });
  await page.evaluate(() => window.tbLink.setRuntimeActive(false));
});

test('没有联动工程时可直接选择 P1 音频并自动建档', async ({}, testInfo) => {
  const audioPath = testInfo.outputPath('p1-audio.wav');
  const p1Path = testInfo.outputPath('p1-show.hia');
  const linkPath = testInfo.outputPath('p1-show.tblink');
  await createAudioFixture(audioPath);
  await writeFile(p1Path, `<?xml version="1.0" encoding="UTF-8"?>
<playerRoot>
  <audioPlayList CurrentList="0"><audioPlayElement caption="P1 节目" type="0"/></audioPlayList>
  <videoPlayList CurrentList="0"><videoPlayElement caption="P1 节目" type="0"><media mediaType="4" resourceFilePath="${audioPath.replaceAll('\\', '/')}" playEndAction="2" cut_start="0" cut_end="4" volume="100" mute="0" shortcut="" MidiStartTime="0" audio_caption_="测试音乐"/></videoPlayElement></videoPlayList>
</playerRoot>
`, 'utf8');
  await application.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [paths.p1Path] });
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: paths.linkPath });
  }, { p1Path, linkPath });
  await openSettingsDialog();
  await expect(page.locator('.integration-setup-primary > .p1-sync-panel')).toBeVisible();
  await expect(page.locator('.program-card .p1-sync-panel')).toHaveCount(0);
  await page.locator('.p1-import-menu > summary').click();
  await expect(page.getByRole('button', { name: '读取 P1 当前工程' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '选择 .hia 文件' })).toBeEnabled();
  await page.getByRole('button', { name: '选择 .hia 文件' }).click();
  await expect(page.getByText('已建立映射')).toBeVisible();
  await expect(page.locator('.p1-sync-summary')).toContainText('1 首音频');
  await page.getByRole('button', { name: /节目单/ }).first().click();
  await expect(page.locator('.p1-project-ribbon')).toHaveAttribute('title', linkPath);
  await page.getByRole('button', { name: /节目单/ }).click();
  await expect(page.locator('.p1-playlist-pane').getByText('P1 节目', { exact: true })).toBeVisible();
  await expect(page.locator('.p1-media-card').getByText('测试音乐', { exact: true })).toBeVisible();
  await page.locator('.rundown-index').click();
  await page.getByRole('button', { name: /编辑器/ }).click();
  await expect(page.locator('.timeline-waveform-canvas:visible')).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => page.locator('.timeline-waveform-canvas:visible').evaluate((canvas) => canvas.getBoundingClientRect().height)).toBeGreaterThanOrEqual(70);
  await expect(page.locator('.reference-timeline')).toHaveAttribute('data-duration-ms', '4000');
  await page.locator('.lighting-clip').dblclick({ position: { x: 64, y: 20 } });
  const lightingPoint = (await page.locator('.lighting-timeline-point').boundingBox())!;
  await page.mouse.move(lightingPoint.x + 8, lightingPoint.y + 8);
  await page.mouse.down();
  await page.mouse.move(lightingPoint.x + 104, lightingPoint.y + 8, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.reference-timeline')).toHaveAttribute('data-duration-ms', '5000');
  await expect(page.getByLabel('内容超出音频范围')).toBeVisible();
  await page.getByRole('button', { name: '删除灯光点', exact: true }).click();
  await expect(page.locator('.reference-timeline')).toHaveAttribute('data-duration-ms', '4000');
  await expect(page.getByLabel('内容超出音频范围')).toHaveCount(0);
  await page.getByRole('button', { name: '播放时间线' }).click();
  await expect(page.getByRole('button', { name: '暂停时间线' })).toBeVisible();
  await expect.poll(() => page.locator('.timeline-toolbar > audio').evaluate((audio) => (audio as HTMLAudioElement).currentTime), { timeout: 8000 }).toBeGreaterThanOrEqual(3.9);
  await expect(page.getByRole('button', { name: '播放时间线' })).toBeVisible();
  await expect(page.locator('.timeline-transport code')).toHaveText('00:00:04:00');
  await page.getByRole('button', { name: '播放时间线' }).click();
  await expect(page.getByRole('button', { name: '暂停时间线' })).toBeVisible();
  await expect.poll(() => page.locator('.timeline-toolbar > audio').evaluate((audio) => (audio as HTMLAudioElement).currentTime)).toBeLessThan(2);
  await page.getByRole('button', { name: '暂停时间线' }).click();
  await page.screenshot({ path: testInfo.outputPath('reference-audio-waveform.png') });

});

test('素材缩略图生成失败会明确显示原因而不是静默降级', async ({}, testInfo) => {
  await beginNewProject();
  await page.getByLabel('工程名称').fill('缩略图失败验证');
  await page.getByRole('button', { name: '创建工程' }).click();
  const projectPath = testInfo.outputPath('thumbnail-error.tblink');
  await application.evaluate(({ dialog }, destination) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: destination });
  }, projectPath);
  await page.getByRole('button', { name: '保存' }).click();
  await addEmptyProgram();
  await page.getByRole('button', { name: /编辑器/ }).click();
  const mediaPath = testInfo.outputPath('thumbnail-source.mp4');
  await createHevcFixture(mediaPath);
  await page.locator('.resource-library input[type="file"]').setInputFiles(mediaPath);
  await expect(page.locator('.asset-row').filter({ hasText: 'thumbnail-source.mp4' })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.project-save-status')).toHaveText('已自动保存');

  await application.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('link:ensure-media-preview-url');
    ipcMain.handle('link:ensure-media-preview-url', () => {
      throw new Error('模拟缩略图解码失败');
    });
  });
  await page.reload();
  await expect(page.locator('.p1-project-workspace')).toBeVisible();
  await page.getByRole('button', { name: /编辑器/ }).click();
  await expect(page.getByLabel(/缩略图生成失败：.*模拟缩略图解码失败/)).toBeVisible();
  await expect(page.locator('.media-thumbnail.failed')).toContainText('失败');
});

test('新建工程不会静默覆盖当前未保存修改', async () => {
  await beginNewProject();
  await page.getByLabel('工程名称').fill('需要保护的工程');
  await page.getByRole('button', { name: '创建工程' }).click();
  await addEmptyProgram();
  await expect(page.getByRole('button', { name: '保存工程', exact: true })).toBeVisible();

  await page.evaluate(() => { window.confirm = () => false; });
  await beginNewProject();
  await expect(page.getByRole('heading', { name: '新建联动工程' })).toHaveCount(0);
  await expect(page.locator('.p1-project-workspace')).toBeVisible();

  await page.evaluate(() => { window.confirm = () => true; });
  await beginNewProject();
  await expect(page.getByRole('heading', { name: '新建联动工程' })).toBeVisible();
});

test('损坏的工作区布局会明确告警而不是静默清零', async () => {
  await page.evaluate(() => {
    localStorage.setItem('tblink.cue-workspace-layout.v1', '{broken-json');
  });
  await page.reload();
  await page.getByRole('button', { name: /编辑器/ }).click();
  await expect(page.locator('.toast.error')).toContainText('工作区布局恢复失败');
  await expect(page.locator('.toast.error')).toContainText('已使用默认布局');
});

test('工程恢复存储不可用时明确告警且界面保持可用', async ({}, testInfo) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = function getItem(key: string): string | null {
      if (key === 'tblink.last-project-path.v1') throw new Error('模拟恢复存储不可用');
      return null;
    };
  });
  await page.reload();
  await expect(page.locator('.toast.error')).toContainText('读取上次工程路径失败：模拟恢复存储不可用');
  await expect(page.getByRole('button', { name: '新建工程', exact: true })).toBeEnabled();

  await beginNewProject();
  await page.getByLabel('工程名称').fill('恢复存储故障工程');
  await page.getByRole('button', { name: '创建工程' }).click();
  const projectPath = testInfo.outputPath('storage-failure.tblink');
  await application.evaluate(({ dialog }, destination) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: destination });
  }, projectPath);
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.locator('.p1-project-ribbon')).toHaveAttribute('title', projectPath);
});

test('左侧分类导航与紧凑窗口栏在最小窗口内不重叠', async () => {
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error('主窗口不存在');
    window.setSize(1180, 720);
  });
  await expect(page.getByRole('button', { name: '关闭窗口' })).toBeVisible();
  const layout = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>('.app-shell');
    const sidebar = document.querySelector<HTMLElement>('.app-sidebar');
    const workspace = document.querySelector<HTMLElement>('.app-workspace');
    const toolbar = document.querySelector<HTMLElement>('.unified-toolbar');
    const navigation = document.querySelector<HTMLElement>('.main-nav');
    const settings = document.querySelector<HTMLElement>('.main-nav[aria-label="主要工作区"] > button:last-child');
    const controls = document.querySelector<HTMLElement>('.window-controls');
    if (!shell || !sidebar || !workspace || !toolbar || !navigation || !settings || !controls) throw new Error('应用框架结构不完整');
    const shellBox = shell.getBoundingClientRect();
    const sidebarBox = sidebar.getBoundingClientRect();
    const workspaceBox = workspace.getBoundingClientRect();
    const toolbarBox = toolbar.getBoundingClientRect();
    const navigationBox = navigation.getBoundingClientRect();
    const settingsBox = settings.getBoundingClientRect();
    const controlsBox = controls.getBoundingClientRect();
    return {
      shellWidth: shellBox.width,
      sidebarLeft: sidebarBox.left,
      sidebarRight: sidebarBox.right,
      workspaceLeft: workspaceBox.left,
      workspaceRight: workspaceBox.right,
      clientWidth: toolbar.clientWidth,
      scrollWidth: toolbar.scrollWidth,
      toolbarHeight: toolbarBox.height,
      navigationLeft: navigationBox.left,
      navigationRight: navigationBox.right,
      settingsBottom: settingsBox.bottom,
      sidebarBottom: sidebarBox.bottom,
      controlsRight: controlsBox.right,
      toolbarRight: toolbarBox.right
    };
  });
  expect(layout.shellWidth).toBe(1180);
  expect(layout.sidebarLeft).toBe(0);
  expect(layout.sidebarRight).toBe(layout.workspaceLeft);
  expect(layout.workspaceRight).toBe(1180);
  expect(layout.scrollWidth).toBe(layout.clientWidth);
  expect(layout.navigationLeft).toBeGreaterThanOrEqual(layout.sidebarLeft);
  expect(layout.navigationRight).toBeLessThanOrEqual(layout.sidebarRight);
  expect(layout.settingsBottom).toBeLessThanOrEqual(layout.sidebarBottom);
  expect(layout.toolbarHeight).toBeLessThanOrEqual(54);
  expect(layout.controlsRight).toBeLessThanOrEqual(layout.toolbarRight);
});

test('所有工作区在最小窗口尺寸内保持主视口边界', async () => {
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error('主窗口不存在');
    window.setSize(1180, 720);
  });
  for (const name of ['节目单', '编辑器']) {
    await page.getByRole('button', { name: new RegExp(name) }).click();
    const boundaries = await page.evaluate(() => {
      const shell = document.querySelector<HTMLElement>('.app-shell');
      const toolbar = document.querySelector<HTMLElement>('.unified-toolbar');
      const main = document.querySelector<HTMLElement>('.app-main');
      if (!shell || !toolbar || !main) throw new Error('应用主视口结构不完整');
      const shellBox = shell.getBoundingClientRect();
      const toolbarBox = toolbar.getBoundingClientRect();
      const mainBox = main.getBoundingClientRect();
      return {
        documentClientWidth: document.documentElement.clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        shellLeft: shellBox.left,
        shellRight: shellBox.right,
        toolbarLeft: toolbarBox.left,
        toolbarRight: toolbarBox.right,
        mainLeft: mainBox.left,
        mainRight: mainBox.right,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        mainBottom: mainBox.bottom
      };
    });
    expect(boundaries.documentScrollWidth).toBe(boundaries.documentClientWidth);
    expect(boundaries.shellLeft).toBeGreaterThanOrEqual(0);
    expect(boundaries.shellRight).toBeLessThanOrEqual(boundaries.viewportWidth);
    expect(boundaries.toolbarLeft).toBeGreaterThanOrEqual(0);
    expect(boundaries.toolbarRight).toBeLessThanOrEqual(boundaries.viewportWidth);
    expect(boundaries.mainLeft).toBeGreaterThanOrEqual(0);
    expect(boundaries.mainRight).toBeLessThanOrEqual(boundaries.viewportWidth);
    expect(boundaries.mainBottom).toBeLessThanOrEqual(boundaries.viewportHeight);
  }
});

test('软件更新窗口始终位于工作区上方且不会被工具栏裁切', async ({}, testInfo) => {
  await beginNewProject();
  await page.getByLabel('工程名称').fill('更新窗口层级验证');
  await page.getByRole('button', { name: '创建工程' }).click();
  await addEmptyProgram();
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error('主窗口不存在');
    window.setSize(1180, 640);
  });
  await openSettingsDialog();
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '外观与更新', exact: true }).click();
  await page.getByRole('button', { name: '软件更新' }).click();
  const dialog = page.getByRole('dialog', { name: '软件更新' });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('button', { name: '关闭软件更新' })).toBeVisible();
  const layout = await page.evaluate(() => {
    const overlay = document.querySelector<HTMLElement>('.update-overlay');
    const card = document.querySelector<HTMLElement>('.update-center');
    if (!overlay || !card) throw new Error('软件更新窗口结构不完整');
    const cardBox = card.getBoundingClientRect();
    const samplePoints = [0.15, 0.5, 0.85].map((ratio) => {
      const topElement = document.elementFromPoint(cardBox.left + cardBox.width / 2, cardBox.top + cardBox.height * ratio);
      return topElement?.closest('.update-center') === card;
    });
    return {
      mountedAtDocumentRoot: overlay.parentElement === document.body,
      dialogIsModal: overlay.getAttribute('aria-modal') === 'true',
      cardTop: cardBox.top,
      cardBottom: cardBox.bottom,
      cardWidth: cardBox.width,
      viewportHeight: window.innerHeight,
      dialogOnTop: samplePoints.every(Boolean),
      overlayCoversViewport: overlay.getBoundingClientRect().height === window.innerHeight,
      nativeDialogOpen: overlay.tagName === 'DIALOG' && (overlay as HTMLDialogElement).open
    };
  });
  expect(layout.mountedAtDocumentRoot).toBe(true);
  expect(layout.dialogIsModal).toBe(true);
  expect(layout.cardTop).toBeGreaterThanOrEqual(16);
  expect(layout.cardBottom).toBeLessThanOrEqual(layout.viewportHeight - 16);
  expect(layout.cardWidth).toBeGreaterThanOrEqual(440);
  expect(layout.cardWidth).toBeLessThanOrEqual(520);
  expect(layout.dialogOnTop).toBe(true);
  expect(layout.overlayCoversViewport).toBe(true);
  expect(layout.nativeDialogOpen).toBe(true);
  await expect(page.locator('.app-shell')).toHaveJSProperty('inert', true);
  await expect(page.getByRole('button', { name: '关闭软件更新' })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('software-update-project-overlay.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.app-shell')).toHaveJSProperty('inert', false);
  await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeVisible();
  await closeSettingsDialog();
});

test('取消重启安装后更新按钮会恢复可操作', async () => {
  await application.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('link:update-status');
    ipcMain.handle('link:update-status', () => ({
      phase: 'downloaded',
      currentVersion: '0.2.10',
      availableVersion: '0.2.11',
      releaseDate: '2026-08-28T00:00:00.000Z',
      progressPercent: 100,
      transferredBytes: 1,
      totalBytes: 1,
      tokenConfigured: true,
      message: '版本 0.2.11 已下载，确认后重启安装'
    }));
    ipcMain.removeHandler('link:update-install');
    ipcMain.handle('link:update-install', () => new Promise<void>((resolve) => setTimeout(resolve, 100)));
  });
  await page.reload();
  await openSettingsDialog();
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '外观与更新', exact: true }).click();
  await page.getByRole('button', { name: '软件更新' }).click();
  const install = page.getByRole('button', { name: '重启并安装' });
  await expect(install).toBeEnabled();
  await install.click();
  await expect(install).toBeDisabled();
  await expect(install).toBeEnabled();
});

test('重复打开更新窗口并切换全部工作区不会产生 renderer 异常', async () => {
  const rendererErrors: string[] = [];
  page.on('pageerror', (error) => rendererErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') rendererErrors.push(message.text());
  });

  await beginNewProject();
  await page.getByLabel('工程名称').fill('稳定性巡检工程');
  await page.getByRole('button', { name: '创建工程' }).click();
  await addEmptyProgram();
  await page.locator('.rundown-index').click();

  for (const name of ['节目单', '编辑器']) {
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.waitForTimeout(100);
  }
  await openSettingsDialog();
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: /设备连接/ }).click();
  for (let iteration = 0; iteration < 5; iteration += 1) {
    await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '外观与更新', exact: true }).click();
    await page.getByRole('button', { name: '软件更新' }).click();
    await expect(page.getByRole('dialog', { name: '软件更新' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '软件更新' })).toHaveCount(0);
    await expect(page.locator('.app-shell')).toHaveJSProperty('inert', false);
  }

  expect(rendererErrors).toEqual([]);
});

test('同一配置只能打开一个主控实例，重复启动不产生第二套输出', async ({}, testInfo) => {
  const executable = await application.evaluate(() => process.execPath);
  await execFileAsync(executable, [`--user-data-dir=${testInfo.outputPath('user-data')}`, desktopEntry], { windowsHide: true, timeout: 10_000 });
  expect(application.windows()).toHaveLength(1);
  await expect(page.getByRole('button', { name: '新建工程', exact: true })).toBeVisible();
});

test('内部主控可直接批量导入音乐，保存模式并保留 P1 跟随入口', async ({}, testInfo) => {
  const projectPath = testInfo.outputPath('internal.tblink');
  const audioPath = testInfo.outputPath('music.wav'); await createAudioFixture(audioPath);
  await beginNewProject();
  await page.getByLabel('工程名称').fill('内部歌曲工程'); await page.getByRole('button', { name: '创建工程' }).click();
  await application.evaluate(({ dialog }, destination) => { dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: destination }); }, projectPath);
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  await expect(page.getByRole('button', { name: '播放主控 音乐、画面与灯光' })).toHaveCount(0);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '播放', exact: true }).click();
  await page.getByLabel('播放主控模式').selectOption('internal');
  await closeSettingsDialog();
  await page.getByLabel('导入主控音乐').setInputFiles(audioPath);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
  await expect(page.locator('.audio-device-section select:visible')).toHaveCount(3);
  await expect(page.getByLabel('灯光 MIDI 输出')).toBeVisible();
  await expect(page.getByLabel('音乐监听设备')).toBeVisible();
  await page.getByLabel('音频采样率').selectOption('44100');
  await expect.poll(() => page.evaluate(async () => (await window.tbLink.loadIntegrationProfile())?.internalPlayer?.audioSampleRate)).toBe(44100);
  await page.getByLabel('音频采样率').selectOption('48000');
  await expect.poll(() => page.evaluate(async () => (await window.tbLink.loadIntegrationProfile())?.internalPlayer?.audioSampleRate)).toBe(48000);
  await page.getByText('更多音频与 MIDI 设置', { exact: true }).click();
  await expect(page.getByLabel('音乐监听设备')).toBeVisible();
  await expect(page.getByLabel('灯光事件输出端口')).toBeVisible();
  await closeSettingsDialog();
  await expect(page.locator('.p1-media-card')).toHaveCount(1);
  await expect(page.locator('.p1-media-card')).toContainText('music.wav');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1180, 720));
  const homeLayout = await page.evaluate(() => {
    const selectors = ['.p1-project-ribbon .project-save-status', '.p1-project-ribbon .primary-button', '.player-buttons', '.p1-media-pane', '.inspector-edit'];
    const controls = document.querySelector('.window-controls')!.getBoundingClientRect();
    return selectors.map((selector) => {
      const box = document.querySelector(selector)!.getBoundingClientRect();
      return { selector, right: box.right, left: box.left, top: box.top, bottom: box.bottom,
        coveredByWindowControls: box.left < controls.right && box.right > controls.left && box.top < controls.bottom && box.bottom > controls.top };
    });
  });
  for (const box of homeLayout) {
    expect(box.left, box.selector).toBeGreaterThanOrEqual(0);
    expect(box.right, box.selector).toBeLessThanOrEqual(1180);
    expect(box.bottom, box.selector).toBeLessThanOrEqual(720);
    expect(box.coveredByWindowControls, box.selector).toBe(false);
  }
  await page.getByRole('button', { name: '节目属性', exact: true }).click();
  await page.getByRole('button', { name: 'music.wav 独立音量', exact: true }).click();
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeVisible();
  const songVolume = page.getByRole('spinbutton', { name: '歌曲音量', exact: true });
  await expect(songVolume).toHaveValue('100');
  await songVolume.fill('60');
  await songVolume.press('Enter');
  await expect(songVolume).toHaveValue('60');
  await songVolume.fill('101');
  await songVolume.press('Enter');
  await expect(songVolume).toHaveValue('60');
  await songVolume.fill('');
  await songVolume.press('Tab');
  await expect(songVolume).toHaveValue('60');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(songVolume).toHaveValue('100');
  const mtcOffset = page.getByRole('textbox', { name: 'MTC 偏移（时:分:秒:帧）', exact: true });
  await expect(mtcOffset).toHaveValue('00:00:00:00');
  await mtcOffset.fill('01:02:03:17'); await mtcOffset.press('Enter');
  await expect(mtcOffset).toHaveValue('01:02:03:17');
  await expect(page.getByLabel('偏移后 MTC 时间码', { exact: true })).toHaveText('01:02:03:17');
  await mtcOffset.fill('00:00:00:30'); await mtcOffset.press('Enter');
  await expect(mtcOffset).toHaveValue('01:02:03:17');
  await songVolume.fill('45'); await songVolume.press('Enter');
  await expect(page.getByRole('button', { name: 'music.wav 独立音量', exact: true })).toHaveText('音量 45%');
  await expect.poll(async () => parseLinkProject(JSON.parse(await readFile(projectPath, 'utf8'))).rundown[0]?.playback?.volume).toBe(45);
  await expect.poll(async () => parseLinkProject(JSON.parse(await readFile(projectPath, 'utf8'))).rundown[0]?.playback?.mtcOffsetMs).toBe(3723567);
  await page.getByRole('button', { name: '编辑内容', exact: true }).click();
  await expect(page.locator('.p1-project-workspace')).toBeHidden();
  await page.getByRole('button', { name: /节目单/ }).first().click();

  await expect(page.locator('.project-save-status')).toHaveText('已自动保存');
  await page.reload(); await expect(page.getByRole('button', { name: '播放主控 音乐、画面与灯光' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'music.wav 独立音量', exact: true })).toHaveText('音量 45%');
  await page.getByRole('button', { name: 'music.wav 独立音量', exact: true }).click();
  await expect(mtcOffset).toHaveValue('01:02:03:17');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '播放', exact: true }).click();
  await expect(page.getByLabel('播放主控模式')).toHaveValue('internal');
  await closeSettingsDialog();
  await expect(page.locator('.p1-media-card')).toHaveCount(1);
  await openSettingsDialog();
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '播放', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: /同时播放视频素材原声/ })).not.toBeChecked();
  await page.getByRole('button', { name: /节目单/ }).first().click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '播放', exact: true }).click();
  await page.getByLabel('播放主控模式').selectOption('p1');
  await closeSettingsDialog();
  await expect(page.getByRole('button', { name: '切换为本软件播放', exact: true })).toBeVisible();
});

test('已保存工程会自动保存修改并在重新打开时恢复', async ({}, testInfo) => {
  await beginNewProject();
  await page.getByLabel('工程名称').fill('自动恢复工程');
  await page.getByRole('button', { name: '创建工程' }).click();
  const projectPath = testInfo.outputPath('auto-restore.tblink');
  await application.evaluate(({ dialog }, destination) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: destination });
  }, projectPath);
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.locator('.p1-project-ribbon')).toHaveAttribute('title', projectPath);

  await addEmptyProgram();
  await expect(page.locator('.p1-media-card')).toHaveCount(1);
  await expect(page.locator('.project-save-status')).toHaveText('已自动保存');

  await page.reload();
  await expect(page.locator('.p1-project-workspace')).toBeVisible();
  await expect(page.getByRole('button', { name: '演出控制' })).toHaveCount(0);
  await expect(page.locator('.p1-project-ribbon')).toHaveAttribute('title', projectPath);
  await expect(page.locator('.p1-media-card')).toHaveCount(1);
});

test('Cue 时间线的统一图层、取消拖动、适配、滚动和播放键盘行为稳定', async ({}, testInfo) => {
  await beginNewProject();
  await page.getByLabel('工程名称').fill('时间线回归工程');
  await page.getByRole('button', { name: '创建工程' }).click();
  const projectPath = testInfo.outputPath('timeline-regression.tblink');
  await application.evaluate(({ dialog }, destination) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: destination });
  }, projectPath);
  await page.getByRole('button', { name: '保存' }).click();
  await addEmptyProgram();
  await page.locator('.rundown-index').click();
  await page.getByRole('button', { name: /编辑器/ }).click();

  const firstAudioPath = testInfo.outputPath('timeline-a.wav');
  await createAudioFixture(firstAudioPath);
  await page.locator('.resource-library input[type="file"]').setInputFiles(firstAudioPath);
  const firstAudioAsset = page.locator('.asset-row').filter({ hasText: 'timeline-a.wav' });
  await expect(firstAudioAsset).toBeVisible({ timeout: 30_000 });
  await firstAudioAsset.dblclick();
  await expect(page.locator('.timeline-clip.audio')).toHaveCount(1);
  await expect(page.locator('.visual-layer-heading')).toHaveCount(3);
  await expect(page.locator('.stage-media-layer')).toHaveCount(0);

  const audioClip = page.locator('.timeline-clip.audio').first();
  const audioOrigin = await audioClip.boundingBox();
  if (!audioOrigin) throw new Error('音频片段拖动区域不可用');
  await page.mouse.move(audioOrigin.x + audioOrigin.width / 2, audioOrigin.y + audioOrigin.height / 2);
  await page.mouse.down();
  await page.mouse.move(audioOrigin.x + audioOrigin.width / 2 + 120, audioOrigin.y + audioOrigin.height / 2);
  await expect.poll(async () => (await audioClip.boundingBox())?.x ?? 0).toBeGreaterThan(audioOrigin.x + 80);
  await audioClip.dispatchEvent('pointercancel', { pointerId: 1 });
  await page.mouse.up();
  await expect.poll(async () => (await audioClip.boundingBox())?.x ?? 0).toBeCloseTo(audioOrigin.x, 0);

  const secondAudioPath = testInfo.outputPath('timeline-b.wav');
  await createAudioFixture(secondAudioPath, 660);
  await page.locator('.resource-library input[type="file"]').setInputFiles(secondAudioPath);
  const secondAudioAsset = page.locator('.asset-row').filter({ hasText: 'timeline-b.wav' });
  await expect(secondAudioAsset).toBeVisible({ timeout: 30_000 });
  await secondAudioAsset.dblclick();
  await expect(page.locator('.timeline-clip.audio')).toHaveCount(2);
  await expect(page.locator('.visual-layer-heading')).toHaveCount(4);
  await expect(page.locator('audio.timeline-audio-engine')).toHaveCount(1, { timeout: 10_000 });
  await expect(page.locator('.project-save-status')).toHaveText('已自动保存');
  const savedAudioProject = parseLinkProject(JSON.parse(await readFile(projectPath, 'utf8')));
  const topAudio = savedAudioProject.mediaAssets.find((asset) => asset.name === 'timeline-b.wav');
  expect(topAudio).toBeDefined();
  await expect(page.locator('audio.timeline-audio-engine')).toHaveAttribute('data-asset-id', topAudio!.id);

  const splitButton = page.getByRole('button', { name: '在播放头切割选中片段' });
  await expect(splitButton).toBeDisabled();
  await page.getByRole('button', { name: '跳到时间线结尾' }).click();
  await page.locator('.reference-timeline').press('Space');
  await expect(page.getByRole('button', { name: '暂停时间线' })).toBeVisible();
  await expect(page.locator('.timeline-transport code')).not.toHaveText('00:01:00:00');
  await page.locator('.reference-timeline').press('ArrowRight');
  await expect(page.getByRole('button', { name: '播放时间线' })).toBeVisible();

  const timelineViewport = page.locator('.timeline-viewport');
  await page.getByRole('button', { name: '适合节目时长' }).click();
  await expect.poll(async () => {
    const viewportWidth = await timelineViewport.evaluate((element) => element.clientWidth);
    const contentWidth = await page.locator('.timeline-content').evaluate((element) => element.getBoundingClientRect().width);
    return Math.abs(contentWidth - viewportWidth);
  }).toBeLessThanOrEqual(1);

  const addLayer = page.getByTitle('在顶部添加图层');
  for (let index = 0; index < 8; index += 1) await addLayer.click();
  const layerHeadings = page.locator('.visual-layer-heading');
  await expect(layerHeadings).toHaveCount(12);
  await layerHeadings.first().getByTitle('删除空图层').click();
  await expect(layerHeadings).toHaveCount(11);
  const timelineShell = page.locator('.timeline-shell');
  await expect.poll(() => timelineShell.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await timelineShell.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => timelineShell.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
});

async function createHevcFixture(path: string): Promise<void> {
  if (!ffmpegPath) throw new Error('E2E 缺少 FFmpeg 运行时');
  await execFileAsync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x1f6feb:s=320x568:r=30:d=2',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=2',
    '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', path
  ], { windowsHide: true });
}

async function createAudioFixture(path: string, frequency = 440, duration = 4): Promise<void> {
  if (!ffmpegPath) throw new Error('E2E 缺少 FFmpeg 运行时');
  await execFileAsync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000:duration=${duration}`,
    '-c:a', 'pcm_s16le', path
  ], { windowsHide: true });
}


test('外观支持深浅两套皮肤、保存选择并实时跟随系统', async ({}, testInfo) => {
  await beginNewProject();
  await page.getByRole('button', { name: '创建工程', exact: true }).click();
  await addEmptyProgram();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '外观与更新', exact: true }).click();
  await page.getByLabel('外观', { exact: true }).selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const foreground = await page.locator('.main-nav button').nth(1).evaluate((element) => getComputedStyle(element).color);
  expect(foreground).toBe('rgb(23, 32, 51)');
  await page.screenshot({ path: testInfo.outputPath('appearance-light.png') });
  await page.getByLabel('外观', { exact: true }).selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '外观与更新', exact: true }).click();
  await expect(page.getByLabel('外观', { exact: true })).toHaveValue('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByLabel('外观', { exact: true }).selectOption('system');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: testInfo.outputPath('appearance-dark.png') });
});





test('开发窗口支持 Alt+R 刷新', async () => {
  await page.evaluate(() => { document.documentElement.setAttribute('data-refresh-check', 'before'); });
  await application.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0]!.webContents;
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'R', modifiers: ['alt'] });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'R', modifiers: ['alt'] });
  });
  await expect(page.locator('html')).not.toHaveAttribute('data-refresh-check', 'before');
  await expect(page.getByRole('button', { name: '新建工程', exact: true })).toBeVisible();
});

async function beginNewProject(): Promise<void> {
  const welcome = page.getByRole('button', { name: '新建工程', exact: true });
  if (await welcome.isVisible()) { await welcome.click(); return; }
  const menu = page.locator('.project-file-menu');
  if (await menu.getAttribute('open') === null) await menu.locator('summary').click();
  await page.getByRole('button', { name: '新建独立工程', exact: true }).click();
}

test('新建独立工程先保存原节目，取消保存不会清空当前内容', async ({}, testInfo) => {
  await beginNewProject();
  await page.getByLabel('工程名称').fill('需要保留的节目单');
  await page.getByRole('button', { name: '创建工程', exact: true }).click();
  await addEmptyProgram();
  await page.evaluate(() => { window.confirm = () => true; });
  await application.evaluate(({ dialog }) => { dialog.showSaveDialog = () => Promise.resolve({ canceled: true, filePath: '' }); });
  await beginNewProject();
  await page.getByLabel('工程名称').fill('另一份节目单');
  await page.getByRole('button', { name: '创建工程', exact: true }).click();
  await expect(page.getByRole('heading', { name: '新建联动工程' })).toBeVisible();
  await expect(page.locator('.p1-media-card')).toHaveCount(1);
  const originalPath = testInfo.outputPath('preserved.tblink');
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath }); }, originalPath);
  await page.getByRole('button', { name: '创建工程', exact: true }).click();
  await expect(page.getByRole('heading', { name: '新建联动工程' })).toHaveCount(0);
  await expect(page.locator('.p1-media-card')).toHaveCount(0);
  const saved = JSON.parse(await readFile(originalPath, 'utf8')) as { name: string; rundown: { title: string }[] };
  expect(saved.name).toBe('需要保留的节目单');
  expect(saved.rundown).toHaveLength(1);
  expect(saved.rundown[0]?.title).toBe('节目 1');
});

test('右上角操作栏不属于窗口拖动区，更多和窗口按钮可点击', async () => {
  await beginNewProject();
  await page.getByRole('button', { name: '创建工程', exact: true }).click();
  for (const selector of ['.project-file-menu', '.project-player-setup', '.p1-project-actions', '.project-file-menu > summary', '.unified-toolbar', '.window-controls button']) {
    const regions = await page.locator(selector).evaluateAll((elements) => elements.map((element) => getComputedStyle(element).getPropertyValue('-webkit-app-region')));
    expect(regions.length).toBeGreaterThan(0);
    expect(regions.every((region) => region === 'no-drag')).toBe(true);
  }
  await page.locator('.project-file-menu > summary').click();
  await expect(page.getByRole('button', { name: '新建独立工程' })).toBeVisible();
  await page.locator('.project-file-menu > summary').click();
  await expect(page.locator('.sidebar-brand')).toHaveCount(0);
  for (const selector of ['.persistent-project-toolbar', '.toolbar-drag-space']) {
    expect(await page.locator(selector).evaluate((element) => getComputedStyle(element).getPropertyValue('-webkit-app-region'))).toBe('drag');
  }
  const drag = await page.locator('.toolbar-drag-space').boundingBox();
  const controls = await page.locator('.window-controls').boundingBox();
  expect(drag!.width).toBeGreaterThan(24);
  expect(drag!.x + drag!.width).toBeLessThan(controls!.x);
  const maximized = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMaximized());
  await page.getByRole('button', { name: '最大化或还原窗口' }).click();
  await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMaximized())).toBe(!maximized);
  await page.getByRole('button', { name: '最大化或还原窗口' }).click();
  await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMaximized())).toBe(maximized);
});

test('P1 模式的名称、波形、试听和模式切换互不重叠', async ({}, testInfo) => {
  await beginNewProject();
  await page.getByRole('button', { name: '创建工程', exact: true }).click();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1100, 760));
  const player = page.locator('.following-mode');
  const parts = [player.locator('.p1-monitor-caption'), player.locator('.home-waveform-monitor'), player.locator('.p1-monitor-empty'), player.locator('.player-mode-note')];
  const parent = await player.boundingBox();
  let bottom = parent!.y;
  for (const part of parts) {
    const box = await part.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(bottom);
    expect(box!.y + box!.height).toBeLessThanOrEqual(parent!.y + parent!.height);
    bottom = box!.y + box!.height;
  }
  await page.screenshot({ path: testInfo.outputPath('compact-program.png') });
});

async function addEmptyProgram(): Promise<void> {
  const grid = page.locator('.p1-media-grid');
  const box = await grid.boundingBox();
  await grid.click({ button: 'right', position: { x: box!.width - 10, y: box!.height - 10 } });
  await page.getByRole('menuitem', { name: '新建空白节目', exact: true }).click();
}

test('MIDI 顶部状态在启动和插拔时更新，不依赖打开设置', async () => {
  await openSettingsDialog();
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
  await page.getByLabel('保存本机集成档案').click();
  await expect.poll(() => page.evaluate(() => window.tbLink.loadIntegrationProfile())).not.toBeNull();
  await page.evaluate(async () => {
    const profile = await window.tbLink.loadIntegrationProfile();
    if (!profile) throw new Error('缺少测试配置');
    await window.tbLink.saveIntegrationProfile({ profile: { ...profile, midiPortProfiles: profile.midiPortProfiles.map((port) => ({ ...port, portName: port.id === profile.p1.controlOutputPortProfileId ? 'Startup Test Output' : '' })) } });
  });
  await page.addInitScript(() => {
    const output = { id: 'startup-output', name: 'Startup Test Output', manufacturer: 'Test', type: 'output', state: 'connected', connection: 'closed' };
    const outputs = new Map([['startup-output', output]]);
    const access = Object.assign(new EventTarget(), { inputs: new Map(), outputs, onstatechange: null as ((event: Event) => void) | null });
    Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: () => Promise.resolve(access) });
    window.addEventListener('test-midi-disconnect', () => { outputs.clear(); access.dispatchEvent(new Event('statechange')); });
    window.addEventListener('test-midi-reconnect', () => { outputs.set('startup-output', output); access.dispatchEvent(new Event('statechange')); });
  });
  await page.reload();
  await expect(page.getByRole('navigation', { name: '设置子菜单' })).toHaveCount(0);
  const midi = page.locator('.toolbar-connection').filter({ has: page.locator('strong', { hasText: /^MIDI$/ }) });
  await expect(midi).toContainText('已连接');
  await page.evaluate(() => window.dispatchEvent(new Event('test-midi-disconnect')));
  await expect(midi).toContainText('未连接');
  await page.evaluate(() => window.dispatchEvent(new Event('test-midi-reconnect')));
  await expect(midi).toContainText('已连接');
});

test('顶部连接状态跨页面显示，并跟随 OBS 连接变化', async () => {
  const status = page.getByLabel('连接状态', { exact: true });
  await expect(status).toContainText('OBS未连接');
  await expect(status).toContainText('MIDI未配置');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('link:obs-status', { status: 'connected', obsVersion: '32.2.2', webSocketVersion: '5.6.3', error: null }));
  await expect(status).toContainText('OBS已连接');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(status).toBeVisible();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('link:obs-status', { status: 'disconnected', obsVersion: null, webSocketVersion: null, error: null }));
  await expect(status).toContainText('OBS未连接');
  await expect(page.locator('.project-more-actions')).toHaveCount(0);
});

test('顶部贯穿整个窗口，三个窗口按钮和工具栏同层', async () => {
  const topbar = page.locator('.app-topbar');
  const bar = await topbar.boundingBox();
  const shell = await page.locator('.app-shell').boundingBox();
  const controls = await page.locator('.window-controls').boundingBox();
  const sidebar = await page.locator('.app-sidebar').boundingBox();
  expect(bar!.x).toBe(shell!.x);
  expect(bar!.width).toBe(shell!.width);
  expect(controls!.y).toBe(bar!.y);
  expect(controls!.height).toBe(bar!.height);
  expect(controls!.x + controls!.width).toBe(bar!.x + bar!.width);
  expect(sidebar!.y).toBeGreaterThanOrEqual(bar!.y + bar!.height);
  expect(await page.locator('.unified-toolbar').evaluate((element) => getComputedStyle(element).position)).toBe('static');
});

test('编辑器恢复最后选择的节目，顶部改名自动保存，删除后回退', async ({}, testInfo) => {
  await beginNewProject();
  await page.getByRole('button', { name: '创建工程', exact: true }).click();
  await addEmptyProgram();
  await addEmptyProgram();
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath }); }, testInfo.outputPath('editor-selection.tblink'));
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  await page.getByRole('button', { name: /编辑器/ }).first().click();
  await expect(page.locator('.rundown-tabs, .studio-heading')).toHaveCount(0);
  await page.getByRole('button', { name: '修改节目名称：节目 2', exact: true }).click();
  await page.getByRole('textbox', { name: '当前节目名称', exact: true }).fill('第二幕');
  await page.getByRole('textbox', { name: '当前节目名称', exact: true }).press('Enter');
  await expect(page.getByRole('button', { name: '修改节目名称：第二幕', exact: true })).toBeVisible();
  await expect(page.locator('.project-save-status')).toHaveText('已自动保存');
  await page.screenshot({ path: testInfo.outputPath('editor-program-name.png') });
  await page.reload();
  await page.getByRole('button', { name: /编辑器/ }).first().click();
  await expect(page.getByRole('button', { name: '修改节目名称：第二幕', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /节目单/ }).first().click();
  await page.locator('.p1-media-card').filter({ hasText: '节目 1' }).click();
  await page.getByRole('button', { name: /编辑器/ }).first().click();
  await expect(page.getByRole('button', { name: '修改节目名称：节目 1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /节目单/ }).first().click();
  await page.locator('.p1-media-card').filter({ hasText: '第二幕' }).click();
  await page.getByRole('button', { name: '节目属性', exact: true }).click();
  await page.evaluate(() => { window.confirm = () => true; });
  await page.locator('.p1-inspector-actions').getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('button', { name: /编辑器/ }).first().click();
  await expect(page.getByRole('button', { name: '修改节目名称：节目 1', exact: true })).toBeVisible();
});


test('独立素材场景同步、场景长度拖动与低功率切换', async ({}, testInfo) => {
  const scenePixels = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
    const context = canvas.getContext('2d'); if (!context) throw new Error('无法创建场景预览测试画面');
    context.fillStyle = '#2060a0'; context.fillRect(0, 0, 32, 32); return canvas.toDataURL();
  });
  await application.evaluate(({ ipcMain }, imageData) => {
    ipcMain.removeHandler('link:obs-source-screenshot');
    ipcMain.handle('link:obs-source-screenshot', () => imageData);
  }, scenePixels);
  await beginNewProject(); await page.getByLabel('工程名称').fill('来源闭环'); await page.getByRole('button', { name: '创建工程' }).click();
  const destination = testInfo.outputPath('sources.tblink');
  await application.evaluate(({ dialog }, path) => { dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: path }); }, destination);
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  await addEmptyProgram();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '画面与同步', exact: true }).click();
  await expect(page.getByLabel('OBS 输出方式')).toHaveCount(0);
  await expect(page.getByRole('switch', { name: '视频定位缓存', exact: true })).toBeChecked();
  await page.getByRole('switch', { name: '视频定位缓存', exact: true }).uncheck();
  await page.getByRole('switch', { name: '视频定位缓存', exact: true }).check();
  expect(await page.evaluate(() => localStorage.getItem('tblink.precise-seeking'))).toBe('true');
  await page.getByRole('switch', { name: '视频定位缓存', exact: true }).uncheck();
  expect(await page.evaluate(() => localStorage.getItem('tblink.precise-seeking'))).toBe('false');
  await closeSettingsDialog();
  await application.evaluate(({ ipcMain, BrowserWindow }) => {
    const inventory = { scenes: ['全景拉腿'], inputs: [], inputKinds: {}, sceneItems: { 全景拉腿: [] }, filters: {}, transitions: ['Fade', 'Cut'], inputAudioStates: {}, sourceSizes: {} };
    for (const channel of ['link:obs-inventory', 'link:obs-source-create', 'link:obs-source-options', 'link:obs-source-apply', 'link:obs-source-cancel']) ipcMain.removeHandler(channel);
    ipcMain.handle('link:obs-inventory', () => inventory);
    ipcMain.handle('link:obs-source-create', (_event, payload: { kind: string; name: string; sceneName: string }) => ({ inputName: `团播·${payload.name}`, sceneName: payload.sceneName, sceneItemId: 99, kind: payload.kind }));
    ipcMain.handle('link:obs-source-options', () => [{ label: '真实设备', value: 'device-1', enabled: true }]);
    ipcMain.handle('link:obs-source-apply', (_event, payload: { inputName: string; settings: { text: string } }) => {
      if (payload.settings.text !== '欢迎来到直播间') throw new Error('文本没有正确送到 OBS');
    });
    ipcMain.handle('link:obs-source-cancel', () => undefined);
    BrowserWindow.getAllWindows()[0]?.webContents.send('link:obs-status', { status: 'connected', obsVersion: '32.2.2', webSocketVersion: '5.6.0', error: null });
  });
  await page.getByRole('button', { name: '编辑器', exact: true }).click();
  await page.getByRole('button', { name: '刷新 OBS 资源', exact: true }).click();
  await page.locator('.media-resource-table').click({ button: 'right' });
  for (const label of ['视频采集设备', '媒体', '浏览器', '窗口采集', '文本', '显示器采集', '音频输入采集', '音频输出采集']) await expect(page.locator('.resource-context-menu').getByRole('button', { name: label, exact: true })).toBeVisible();
  await page.locator('.resource-context-menu').getByRole('button', { name: '视频采集设备', exact: true }).click();
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByLabel('设备 / 窗口').selectOption('device-1');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '添加视频采集设备' })).toHaveCount(0);
  await page.getByRole('button', { name: '添加来源或媒体' }).click();
  await page.locator('.resource-context-menu').getByRole('button', { name: '文本', exact: true }).click();
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByLabel('文本内容').fill('欢迎来到直播间');
  await page.screenshot({ path: testInfo.outputPath('source-dialog.png') });
  await page.getByRole('button', { name: '添加到 OBS 场景', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '添加文本', exact: true })).toHaveCount(0);
  await expect(page.locator('.timeline-cue')).toHaveCount(0);
  await page.locator('.obs-camera-row').filter({ hasText: '全景拉腿' }).dblclick();
  await expect(page.locator('.timeline-cue')).toHaveCount(1);
  await expect(page.getByRole('img', { name: 'OBS 全景拉腿', exact: true })).toBeVisible();
  await expect(page.locator('.stage-obs-handle')).toHaveCount(0);
  await page.locator('.timeline-cue').click();
  await page.getByLabel('Cue OBS 转场', { exact: true }).selectOption('Fade');
  await page.getByLabel('Cue 过渡时长（毫秒）', { exact: true }).fill('650');
  await page.getByLabel('Cue 过渡时长（毫秒）', { exact: true }).press('Enter');
  await expect.poll(async () => parseLinkProject(JSON.parse(await readFile(destination, 'utf8'))).rundown[0]?.cues[0]?.actions[0]).toMatchObject({ transition: { name: 'Fade', durationMs: 650 } });
  await expect(page.locator('.project-save-status')).toHaveText('已自动保存');
  const project = JSON.parse(await readFile(destination, 'utf8')) as { rundown: { cues: { actions: { kind: string; sceneName: string }[] }[] }[] };
  expect(project.rundown[0]?.cues[0]?.actions).toEqual([expect.objectContaining({ kind: 'obs.setProgramScene', sceneName: '全景拉腿' })]);
  await application.evaluate(({ ipcMain, BrowserWindow }) => {
    ipcMain.removeHandler('link:obs-inventory');
    ipcMain.handle('link:obs-inventory', () => ({ scenes: ['全景拉腿', '近景拉腿'], inputs: [], inputKinds: {}, sceneItems: { 全景拉腿: [], 近景拉腿: [] }, filters: {}, transitions: [], inputAudioStates: {}, sourceSizes: {} }));
    Reflect.set(globalThis, '__publishedSceneMedia', []);
    ipcMain.removeHandler('link:obs-media-scenes-prepare');
    ipcMain.handle('link:obs-media-scenes-prepare', (_event, projectPath: string, project: unknown) => {
      (Reflect.get(globalThis, '__publishedSceneMedia') as unknown[]).push({ projectPath, project });
    });
    BrowserWindow.getAllWindows()[0]!.webContents.send('link:obs-inventory-changed', null);
  });
  await expect(page.locator('.obs-camera-row').filter({ hasText: '近景拉腿' })).toBeVisible();
  const audioPath = testInfo.outputPath('scene-material.wav'); await createAudioFixture(audioPath);
  await page.locator('.resource-library input[type="file"]').setInputFiles(audioPath);
  const assetRow = page.locator('.asset-row').filter({ hasText: 'scene-material.wav' });
  await expect(assetRow).toBeVisible();
  await expect.poll(() => application.evaluate(() => (Reflect.get(globalThis, '__publishedSceneMedia') as unknown[]).length)).toBe(1);
  const published = await application.evaluate((): unknown => Reflect.get(globalThis, '__publishedSceneMedia'));
  expect(published).toEqual([expect.objectContaining({ projectPath: destination, project: expect.objectContaining({ mediaAssets: expect.arrayContaining([expect.objectContaining({ name: 'scene-material.wav' })]) }) })]);
  const sceneClip = page.locator('.timeline-cue.visual-obs-clip').first();
  await expect(sceneClip.locator('.timeline-trim-handle')).toHaveCount(2);
  const original = await sceneClip.boundingBox(); if (!original) throw new Error('场景片段不可见');
  await sceneClip.hover();
  const handle = await sceneClip.locator('.timeline-trim-handle.end').boundingBox(); if (!handle) throw new Error('场景尾部不可见');
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 60, handle.y + handle.height / 2, { steps: 5 }); await page.mouse.up();
  await expect.poll(async () => (await sceneClip.boundingBox())!.width).toBeGreaterThan(original.width + 20);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '画面与同步', exact: true }).click();
  await page.getByRole('combobox', { name: '运行模式' }).selectOption('low-power'); await closeSettingsDialog();
  await page.getByRole('button', { name: '编辑器', exact: true }).click();
  await expect(page.locator('.reference-stage')).toHaveCount(0);
  await expect(page.locator('video')).toHaveCount(0);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '画面与同步', exact: true }).click();
  await page.getByRole('combobox', { name: '运行模式' }).selectOption('normal'); await closeSettingsDialog();
  await page.getByRole('button', { name: '编辑器', exact: true }).click();
  await expect(page.locator('.reference-stage')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('scene-duration-and-preview.png') });
  await expect(page.locator('.timeline-cue')).toHaveCount(1);
  await expect(page.locator('.project-save-status')).toHaveText('已自动保存');
  const saved = parseLinkProject(JSON.parse(await readFile(destination, 'utf8')));
  const material = saved.mediaAssets[0]!;
  const materialScene = materialSceneNames(saved.projectId, material).sceneName;
  await application.evaluate(({ ipcMain, BrowserWindow }, sceneName) => {
    ipcMain.removeHandler('link:obs-inventory');
    ipcMain.handle('link:obs-inventory', () => ({ scenes: ['全景拉腿', sceneName], inputs: [], inputKinds: {}, sceneItems: {}, filters: {}, transitions: [], inputAudioStates: {}, sourceSizes: {} }));
    BrowserWindow.getAllWindows()[0]!.webContents.send('link:obs-inventory-changed', null);
  }, materialScene);
  await page.locator('.obs-camera-row').filter({ hasText: materialScene }).dblclick();
  await expect(page.locator('.timeline-cue')).toHaveCount(1);
  await expect(page.locator('.project-save-status')).toHaveText('已自动保存');
  await expect.poll(async () => parseLinkProject(JSON.parse(await readFile(destination, 'utf8'))).rundown[0]!.referenceMediaClips.length).toBe(1);
  const mediaClip = parseLinkProject(JSON.parse(await readFile(destination, 'utf8'))).rundown[0]!.referenceMediaClips[0]!;
  expect(mediaClip.assetId).toBe(material.id);
  expect(mediaClip.sourceOffsetMs).toBe(0);
});

test('音乐自然结束补齐最后轮询间隔的 Cue，手动跳到结尾只释放音符', async ({}, testInfo) => {
  const audioPath = testInfo.outputPath('tail.wav');
  const projectPath = testInfo.outputPath('tail.tblink');
  await createAudioFixture(audioPath);
  const lighting = createLightingDocument(); lighting.outputMode = 'direct';
  lighting.tracks = [{ id: 'lighting', name: '灯光', kind: 'ma2', color: '#ffffff', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: 'lighting-output', controller: 7, noteNames: {}, clips: [{ id: 'clip', name: '灯光', start: 0, duration: 4200, muted: false, timeLock: 'time', events: [
    { id: 'held', kind: 'note', at: 1000, duration: 3200, note: 60, velocity: 100 },
    { id: 'tail', kind: 'ma2', at: 3999, cue: '1.25', sequence: 1, executor: '1.5', action: 'goto', label: '结尾 Cue' },
    { id: 'outside', kind: 'cc', at: 4000, controller: 7, value: 99 }
  ] }] }];
  const project = createEmptyLinkProject('结束边界'); project.schemaVersion = 2;
  project.rundown.push({ id: 'song', title: '结尾验收', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting,
    referenceAudio: { assetId: 'audio', relativePath: 'tail.wav', sha256: createHash('sha256').update(await readFile(audioPath)).digest('hex'), durationMs: 4000 } });
  await writeFile(projectPath, JSON.stringify(project));
  const profile = createDefaultIntegrationProfile();
  profile.midiPortProfiles.find((port) => port.id === 'lighting-output')!.portName = 'Tail Test';
  await page.evaluate((value) => window.tbLink.saveIntegrationProfile({ profile: value }), profile);
  await page.reload();
  await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, projectPath);
  await page.getByRole('button', { name: '打开工程', exact: true }).click();
  await closeLightingTools(); await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
  await page.evaluate(() => {
    const packets: number[][] = [];
    Reflect.set(window, '__tailPackets', packets);
    const audio = document.querySelector<HTMLAudioElement>('.timeline-toolbar > audio');
    const lifecycle: Array<{ event: string; time: number; ended: boolean; seeking: boolean }> = [];
    Reflect.set(window, '__tailLifecycle', lifecycle);
    for (const event of ['playing', 'pause', 'seeking', 'seeked', 'ended']) audio?.addEventListener(event, () => lifecycle.push({ event, time: audio.currentTime, ended: audio.ended, seeking: audio.seeking }));
    const output = { name: 'Tail Test', state: 'connected', open: () => Promise.resolve(), send: (bytes: number[]) => packets.push([...bytes]) };
    const access = Object.assign(new EventTarget(), { inputs: new Map(), outputs: new Map([['out', output]]) });
    Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: () => Promise.resolve(access) });
    // Deterministically leave a final polling interval for the ended cleanup to flush.
    const interval = window.setInterval.bind(window);
    Object.defineProperty(window, 'setInterval', { configurable: true, value: (handler: TimerHandler, delay?: number, ...args: unknown[]): number => interval(delay === 5 && typeof handler === 'function' ? () => {
      const audio = document.querySelector<HTMLAudioElement>('.timeline-toolbar > audio');
      if (!audio || audio.currentTime < 3.98) (handler as (...values: unknown[]) => void)(...args);
    } : handler, delay, ...args) });
  });
  await expect.poll(() => page.locator('.timeline-toolbar > audio').evaluate((audio) => (audio as HTMLAudioElement).readyState)).toBeGreaterThanOrEqual(2);
  await page.locator('.lighting-track-name').click();
  await page.getByLabel('灯光播放方式').selectOption('linked');
  await page.getByRole('button', { name: '播放时间线', exact: true }).click();
  await expect(page.getByRole('button', { name: '暂停时间线', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '播放时间线', exact: true })).toBeVisible({ timeout: 12000 });
  await expect.poll(() => page.evaluate(() => (Reflect.get(window, '__tailPackets') as number[][]).map((bytes) => bytes[0]))).toEqual([0x90, 0xf0, 0x80]).catch(async (error: unknown) => {
    await writeFile(testInfo.outputPath('audio-lifecycle.json'), JSON.stringify(await page.evaluate((): unknown => Reflect.get(window, '__tailLifecycle')), null, 2));
    throw error;
  });
  await page.getByRole('button', { name: '回到时间线开头', exact: true }).click();
  await page.getByRole('button', { name: '播放时间线', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (Reflect.get(window, '__tailPackets') as number[][]).length)).toBe(4);
  await page.locator('.timeline-toolbar > audio').evaluate((audio) => { (audio as HTMLAudioElement).currentTime = 4; });
  await expect(page.getByRole('button', { name: '播放时间线', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (Reflect.get(window, '__tailPackets') as number[][]).map((bytes) => bytes[0]))).toEqual([0x90, 0xf0, 0x80, 0x90, 0x80]);
});

test('灯光录制按实际音乐位置保存输入事件', async ({}, testInfo) => {
  const audioPath = testInfo.outputPath('p1-audio.wav');
  const p1Path = testInfo.outputPath('p1-show.hia');
  const linkPath = testInfo.outputPath('p1-show.tblink');
  await createAudioFixture(audioPath);
  await writeFile(p1Path, `<?xml version="1.0" encoding="UTF-8"?>
<playerRoot>
  <audioPlayList CurrentList="0"><audioPlayElement caption="P1 节目" type="0"/></audioPlayList>
  <videoPlayList CurrentList="0"><videoPlayElement caption="P1 节目" type="0"><media mediaType="4" resourceFilePath="${audioPath.replaceAll('\\', '/')}" playEndAction="2" cut_start="0" cut_end="4" volume="100" mute="0" shortcut="" MidiStartTime="0" audio_caption_="测试音乐"/></videoPlayElement></videoPlayList>
</playerRoot>
`, 'utf8');
  await application.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [paths.p1Path] });
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: paths.linkPath });
  }, { p1Path, linkPath });
  await openSettingsDialog();
  await expect(page.locator('.integration-setup-primary > .p1-sync-panel')).toBeVisible();
  await expect(page.locator('.program-card .p1-sync-panel')).toHaveCount(0);
  await page.locator('.p1-import-menu > summary').click();
  await expect(page.getByRole('button', { name: '读取 P1 当前工程' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '选择 .hia 文件' })).toBeEnabled();
  await page.getByRole('button', { name: '选择 .hia 文件' }).click();
  await expect(page.getByText('已建立映射')).toBeVisible();
  await expect(page.locator('.p1-sync-summary')).toContainText('1 首音频');
  await page.getByRole('button', { name: /节目单/ }).first().click();
  await expect(page.locator('.p1-project-ribbon')).toHaveAttribute('title', linkPath);
  await page.getByRole('button', { name: /节目单/ }).click();
  await expect(page.locator('.p1-playlist-pane').getByText('P1 节目', { exact: true })).toBeVisible();
  await expect(page.locator('.p1-media-card').getByText('测试音乐', { exact: true })).toBeVisible();
  await page.locator('.rundown-index').click();
  await page.getByRole('button', { name: /编辑器/ }).click();
  await closeLightingTools(); await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
  await page.getByLabel('保存本机集成档案').click();
  await expect.poll(() => page.evaluate(() => window.tbLink.loadIntegrationProfile())).not.toBeNull();
  await page.evaluate(async () => {
    const profile = await window.tbLink.loadIntegrationProfile();
    if (!profile) throw new Error('测试配置未保存');
    await window.tbLink.saveIntegrationProfile({ profile: { ...profile, midiPortProfiles: [...profile.midiPortProfiles, { id: 'lighting-record-input', direction: 'input', portName: 'Test Lighting Input' }] } });
  });
  await page.reload();
  await expect.poll(() => page.evaluate(async () => (await window.tbLink.loadIntegrationProfile())?.midiPortProfiles.find((port) => port.id === 'lighting-record-input')?.portName)).toBe('Test Lighting Input');
  await closeLightingTools(); await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
  await page.evaluate(() => {
    const input = Object.assign(new EventTarget(), { name: 'Test Lighting Input', state: 'connected', open: () => Promise.resolve() });
    const access = Object.assign(new EventTarget(), { inputs: new Map([['test', input]]), outputs: new Map() });
    Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: () => Promise.resolve(access) });
    Reflect.set(window, '__testLightingInput', input);
    Reflect.set(window, '__testLightingAccess', access);
  });
  await expect.poll(() => page.locator('.timeline-toolbar > audio').evaluate((audio) => (audio as HTMLAudioElement).readyState)).toBeGreaterThanOrEqual(2);
  await page.locator('.lighting-clip').first().dblclick({ position: { x: 20, y: 30 } });
  await page.getByLabel('执行器', { exact: true }).fill('1.5');
  await page.getByLabel('执行器', { exact: true }).press('Tab');
  await page.getByLabel('序列', { exact: true }).fill('23');
  await page.getByLabel('序列', { exact: true }).press('Tab');
  await page.locator('.reference-timeline').press('Home');
  await page.getByRole('button', { name: '录制灯光', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('recording-start.png') });
  await expect(page.getByRole('button', { name: '结束录制', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '播放时间线', exact: true }).click();
  await expect.poll(() => page.locator('.timeline-toolbar > audio').evaluate((audio) => (audio as HTMLAudioElement).currentTime)).toBeGreaterThan(0.4);
  const recordedMs = await page.evaluate(() => {
    const input = Reflect.get(window, '__testLightingInput') as EventTarget;
    const audio = document.querySelector<HTMLAudioElement>('.timeline-toolbar > audio');
    if (!audio) throw new Error('播放音频不存在');
    const message = new Event('midimessage');
    Object.defineProperty(message, 'data', { value: new Uint8Array([0xb0, 7, 96]) });
    const ms = audio.currentTime * 1000;
    input.dispatchEvent(message);
    const cueMessage = new Event('midimessage');
    Object.defineProperty(cueMessage, 'data', { value: new Uint8Array([0xf0, 0x7f, 0x7f, 2, 1, 1, ...[...'37.200\0' + '5.1'].map((char) => char.charCodeAt(0)), 0xf7]) });
    input.dispatchEvent(cueMessage);
    const offMessage = new Event('midimessage');
    Object.defineProperty(offMessage, 'data', { value: new Uint8Array([0xf0, 0x7f, 0x7f, 2, 1, 0x0b, ...[...'0.000\0' + '5.1'].map((char) => char.charCodeAt(0)), 0xf7]) });
    input.dispatchEvent(offMessage);
    const noteMessage = new Event('midimessage');
    Object.defineProperty(noteMessage, 'data', { value: new Uint8Array([0x90, 60, 100]) });
    input.dispatchEvent(noteMessage);
    return ms;
  });
  await expect.poll(() => page.locator('.timeline-toolbar > audio').evaluate((audio) => (audio as HTMLAudioElement).currentTime * 1000)).toBeGreaterThan(recordedMs + 150);
  const releasedMs = await page.evaluate(() => {
    const input = Reflect.get(window, '__testLightingInput') as EventTarget;
    for (const bytes of [[0x80, 60, 72], [0x90, 62, 90]]) {
      const message = new Event('midimessage');
      Object.defineProperty(message, 'data', { value: new Uint8Array(bytes) }); input.dispatchEvent(message);
    }
    return (document.querySelector<HTMLAudioElement>('.timeline-toolbar > audio')?.currentTime ?? 0) * 1000;
  });
  await expect.poll(() => page.locator('.timeline-toolbar > audio').evaluate((audio) => (audio as HTMLAudioElement).currentTime * 1000)).toBeGreaterThan(releasedMs + 50);
  await page.evaluate(() => {
    Reflect.set(Reflect.get(window, '__testLightingInput') as EventTarget, 'state', 'disconnected');
    (Reflect.get(window, '__testLightingAccess') as EventTarget).dispatchEvent(new Event('statechange'));
  });
  await expect(page.getByRole('button', { name: '录制灯光', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '暂停时间线', exact: true }).click();
  await expect.poll(async () => {
    const project = JSON.parse(await readFile(linkPath, 'utf8')) as { rundown: Array<{ lighting?: { tracks: Array<{ clips: Array<{ events: Array<{ kind: string; at: number }> }> }> } }> };
    return project.rundown[0]?.lighting?.tracks[0]?.clips.flatMap((clip) => clip.events).find((event) => event.kind === 'cc')?.at;
  }).toBeCloseTo(recordedMs, 0);
  await expect.poll(async () => {
    const project = JSON.parse(await readFile(linkPath, 'utf8')) as { rundown: Array<{ lighting?: { tracks: Array<{ clips: Array<{ events: Array<{ kind: string; cue?: string; executor?: string; sequence?: number; at: number }> }> }> } }> };
    return project.rundown[0]?.lighting?.tracks[0]?.clips.flatMap((clip) => clip.events).find((event) => event.kind === 'ma2' && event.cue === '37.200');
  }).toMatchObject({ kind: 'ma2', cue: '37.200', executor: '1.5', sequence: 23, action: 'goto' });
  const recordedProject = parseLinkProject(JSON.parse(await readFile(linkPath, 'utf8')));
  const recordedNotes = recordedProject.rundown[0]?.lighting?.tracks[0]?.clips.flatMap((clip) => clip.events).filter((event) => event.kind === 'note');
  expect(recordedNotes?.find((event) => event.note === 60)).toMatchObject({ releaseVelocity: 72 });
  expect(recordedNotes?.find((event) => event.note === 62)?.duration).toBeGreaterThan(50);
  const recordedOff = recordedProject.rundown[0]?.lighting?.tracks[0]?.clips.flatMap((clip) => clip.events).find((event) => event.kind === 'ma2' && event.action === 'off');
  expect(recordedOff).toMatchObject({ kind: 'ma2', action: 'off', executor: '1.5' });
  expect(recordedOff).not.toHaveProperty('cue');
  expect(recordedOff).not.toHaveProperty('sequence');
  await expect.poll(async () => {
    const project = JSON.parse(await readFile(linkPath, 'utf8')) as { rundown: Array<{ lighting?: { tracks: Array<{ clips: Array<{ events: Array<{ kind: string; duration?: number }> }> }> } }> };
    return project.rundown[0]?.lighting?.tracks[0]?.clips.flatMap((clip) => clip.events).find((event) => event.kind === 'note')?.duration ?? 0;
  }).toBeGreaterThan(150);
  const notePoint = page.getByRole('button', { name: '灯光点 note', exact: true }).first();
  if (await notePoint.isVisible()) await notePoint.click();
  else {
    await page.getByRole('button', { name: '灯光点 cc', exact: true }).click({ button: 'right' });
    await page.getByRole('button', { name: '选中：音符 60', exact: true }).click();
  }
  const duration = page.getByLabel('持续（秒）', { exact: true });
  await expect(duration).toBeVisible();
  await duration.fill('2.5');
  await duration.press('Tab');
  await expect.poll(async () => {
    const project = JSON.parse(await readFile(linkPath, 'utf8')) as { rundown: Array<{ lighting?: { tracks: Array<{ clips: Array<{ events: Array<{ kind: string; duration?: number }> }> }> } }> };
    return project.rundown[0]?.lighting?.tracks[0]?.clips.flatMap((clip) => clip.events).find((event) => event.kind === 'note')?.duration;
  }).toBe(2500);
  const velocity = page.getByLabel('力度', { exact: true });
  await velocity.fill('128');
  await velocity.press('Tab');
  await expect(velocity).toHaveValue('100');
  await velocity.fill('75');
  await velocity.press('Tab');
  await expect(velocity).toHaveValue('75');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(velocity).toHaveValue('100');
  await expect(duration).toHaveValue('2.5');

});


test('MA2 预览与冲突显示主推杆百分比，合并结果不误报关闭执行器', async ({}, testInfo) => {
  await beginNewProject();
  await page.getByLabel('工程名称').fill('Master 同步预览');
  await page.getByRole('button', { name: '创建工程' }).click();
  await addEmptyProgram();
  const xml = await readFile(join(process.cwd(), 'src/main/link/fixtures/ma2-timecode-master-3.3.xml'), 'utf8');
  const seq = await readFile(join(process.cwd(), 'src/main/link/fixtures/ma2-sequence-fractional-3.3.xml'), 'utf8');
  const sequenceObject = seq.match(/<Sequ\s[\s\S]*?<\/Sequ>/)?.[0];
  if (!sequenceObject) throw new Error('测试序列缺失');
  const source = xml.replace('</MA>', `${sequenceObject}</MA>`);
  const preview = convertMa2Snapshot(source, 9902);
  await application.evaluate(({ ipcMain }, result) => { ipcMain.removeHandler('link:ma2-preview'); ipcMain.handle('link:ma2-preview', () => result); }, preview);
  const navigation = page.getByRole('navigation', { name: '主要工作区' });
  await closeLightingTools(); await navigation.getByRole('button', { name: '设置', exact: true }).click();
  const devices = page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true });
  await devices.click();
  await page.getByLabel('MA2 连接方式').selectOption('local');
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
  await page.getByLabel('MA2 onPC 数据目录').fill('C:\\MA2-Test');
  await openLightingTools('节目同步');
  await page.getByLabel('读取 MA2 Timecode 编号').fill('9902');
  await page.getByRole('button', { name: '读取灯光编排', exact: true }).click();
  const region = page.getByRole('region', { name: 'MA2 灯光读取预览' });
  await expect(region.getByRole('cell', { name: '主推杆 75.5%', exact: true })).toBeVisible();
  await expect(region).toContainText('4 个灯光点');
  await region.getByRole('button', { name: '加入当前节目', exact: true }).click();
  await closeLightingTools(); await navigation.getByRole('button', { name: '编辑器', exact: true }).click();
  await page.getByRole('button', { name: '灯光点 Master 75.5%', exact: true }).click();
  await page.getByLabel('主推杆 %', { exact: true }).fill('50');
  await page.getByLabel('主推杆 %', { exact: true }).press('Tab');
  const remote = convertMa2Snapshot(source.replace('fader_level="0.755"', 'fader_level="0.625"'), 9902);
  await application.evaluate(({ ipcMain }, result) => { ipcMain.removeHandler('link:ma2-preview'); ipcMain.handle('link:ma2-preview', () => result); }, remote);
  await closeLightingTools(); await navigation.getByRole('button', { name: '设置', exact: true }).click();
  await devices.click();
  await openLightingTools('节目同步');
  await page.getByLabel('读取 MA2 Timecode 编号').fill('9902');
  await page.getByRole('button', { name: '读取灯光编排', exact: true }).click();
  await region.getByRole('button', { name: '比较节目与控台修改', exact: true }).click();
  const difference = page.getByRole('region', { name: '节目与控台差异' });
  await expect(difference).toContainText('1 处冲突');
  for (const value of ['75.5%', '50%', '62.5%']) await expect(difference).toContainText(value);
  await page.getByLabel('冲突 1 保留版本').selectOption('remote');
  await expect(difference.getByRole('cell', { name: '主推杆 62.5%', exact: true })).toBeVisible();
  await expect(difference.getByRole('cell', { name: '关闭执行器', exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('master-sync-conflict.png') });
});

test('灯光时间线右键直接创建主推杆点，复用前值并支持撤销锁定和保存', async ({}, testInfo) => {
  await beginNewProject();
  await page.getByLabel('工程名称').fill('直接添加推杆');
  await page.getByRole('button', { name: '创建工程' }).click();
  await addEmptyProgram();
  const navigation = page.getByRole('navigation', { name: '主要工作区' });
  await closeLightingTools(); await navigation.getByRole('button', { name: '编辑器', exact: true }).click();
  const clip = page.locator('.lighting-clip').first();
  await clip.click({ button: 'right', position: { x: 100, y: 30 } });
  await page.getByRole('button', { name: '添加主推杆点', exact: true }).click();
  const level = page.getByLabel('主推杆 %', { exact: true });
  await expect(level).toHaveValue('100');
  await expect(page.getByLabel('执行器', { exact: true })).toHaveValue('1.1');
  await level.fill('62.5'); await level.press('Tab');
  await clip.click({ button: 'right', position: { x: 180, y: 30 } });
  await page.getByRole('button', { name: '添加主推杆点', exact: true }).click();
  await expect(level).toHaveValue('62.5');
  await expect(page.getByRole('button', { name: '灯光点 Master 62.5%', exact: true })).toHaveCount(2);
  const masterPoints = page.locator('.lighting-timeline-point');
  await level.fill('95'); await level.press('Tab');
  const curve = page.locator('.lighting-master-curve line');
  await expect(curve).toHaveCount(1);
  await expect(page.locator('.lighting-master-curve')).toHaveCSS('height', '56px');
  await expect(curve).toHaveAttribute('y1', '28');
  expect(Number(await curve.getAttribute('y2'))).toBeCloseTo(17.6);
  await page.screenshot({ path: testInfo.outputPath('master-curve-selected.png') });
  await masterPoints.first().click({ modifiers: ['Control'] });
  await expect(page.locator('.lighting-timeline-point.selected')).toHaveCount(2);
  const dragBounds = await masterPoints.first().boundingBox();
  if (!dragBounds) throw new Error('推杆多选位置不可用');
  const beforePositions = await masterPoints.evaluateAll((points) => points.map((point) => point.getBoundingClientRect().x));
  await page.keyboard.down('Alt');
  await page.mouse.move(dragBounds.x + 4, dragBounds.y + 8); await page.mouse.down();
  await page.mouse.move(dragBounds.x + 4, dragBounds.y - 92, { steps: 5 });
  await page.mouse.up(); await page.keyboard.up('Alt');
  await expect(masterPoints.first()).toContainText('Master 67.5%');
  await expect(masterPoints.last()).toContainText('Master 100%');
  expect(Number(await curve.getAttribute('y1'))).toBeCloseTo(26.4);
  await expect(curve).toHaveAttribute('y2', '16');
  expect(await masterPoints.evaluateAll((points) => points.map((point) => point.getBoundingClientRect().x))).toEqual(beforePositions);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(masterPoints.first()).toContainText('Master 62.5%');
  await expect(masterPoints.last()).toContainText('Master 95%');
  await expect(curve).toHaveAttribute('y1', '28');
  expect(Number(await curve.getAttribute('y2'))).toBeCloseTo(17.6);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByRole('button', { name: '灯光点 Master 62.5%', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await page.getByRole('button', { name: '灯光锁定', exact: true }).click();
  await clip.click({ button: 'right', position: { x: 220, y: 30 } });
  await expect(page.getByRole('button', { name: '添加主推杆点', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  const destination = testInfo.outputPath('created-master.tblink');
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath }); }, destination);
  await page.keyboard.press('Control+s');
  await expect.poll(() => existsSync(destination)).toBe(true);
  const saved = parseLinkProject(JSON.parse(await readFile(destination, 'utf8')));
  expect(saved.rundown[0]!.lighting!.tracks[0]!.clips[0]!.events.map((event) => event.kind)).toEqual(['ma2-fader', 'ma2-fader']);
  await page.reload();
  await closeLightingTools(); await navigation.getByRole('button', { name: '编辑器', exact: true }).click();
  await expect(page.getByRole('button', { name: '灯光点 Master 62.5%', exact: true })).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath('created-master-points.png') });
});

test('原生 Master 推杆可编辑百分比、撤销并保存重开', async ({}, testInfo) => {
  await beginNewProject();
  await page.getByLabel('工程名称').fill('Master 推杆编辑');
  await page.getByRole('button', { name: '创建工程' }).click();
  await addEmptyProgram();
  const main = page.getByRole('navigation', { name: '主要工作区' });
  await closeLightingTools(); await main.getByRole('button', { name: '设置', exact: true }).click();
  await openLightingTools('导入与导出');
  const lighting = createLightingDocument();
  lighting.tracks = [{ id: 'master-track', name: 'MA2 主推杆', kind: 'ma2', color: '#abcdef', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: 'master-clip', name: '主推杆', start: 0, duration: 2000, timeLock: 'time', muted: false, events: [{ id: 'master-event', kind: 'ma2-fader', at: 500, executor: '99.219', fader: 'Master', level: 0.755, label: '主推杆' }] }] }];
  await page.locator('.settings-lighting input[type="file"]').setInputFiles({ name: 'master.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(lighting)) });
  await page.getByRole('button', { name: '确认导入', exact: true }).click();
  await closeLightingTools(); await main.getByRole('button', { name: '编辑器', exact: true }).click();
  await page.locator('.lighting-timeline-point').filter({ hasText: 'Master 75.5%' }).click();
  const level = page.getByLabel('主推杆 %', { exact: true });
  await expect(level).toHaveValue('75.5');
  await expect(page.getByLabel('执行器', { exact: true })).toHaveValue('99.219');
  const masterPoint = page.locator('.lighting-timeline-point').filter({ hasText: 'Master' });
  const masterBounds = await masterPoint.boundingBox();
  if (!masterBounds) throw new Error('主推杆点不可见');
  const originalTime = await page.getByLabel('灯光点歌曲时间').inputValue();
  await page.keyboard.down('Alt');
  await page.mouse.move(masterBounds.x + 4, masterBounds.y + 8);
  await page.mouse.down();
  await page.mouse.move(masterBounds.x + 4, masterBounds.y - 42, { steps: 5 });
  await expect(masterPoint).toContainText('Master 80.5%');
  await page.keyboard.press('Escape');
  await page.mouse.up(); await page.keyboard.up('Alt');
  await expect(masterPoint).toContainText('Master 75.5%');
  await expect(level).toHaveValue('75.5');
  await page.keyboard.down('Alt');
  await page.mouse.move(masterBounds.x + 4, masterBounds.y + 8);
  await page.mouse.down();
  await page.mouse.move(masterBounds.x + 4, masterBounds.y - 42, { steps: 5 });
  await page.mouse.up(); await page.keyboard.up('Alt');
  await expect(level).toHaveValue('80.5');
  await expect(page.getByLabel('灯光点歌曲时间')).toHaveValue(originalTime);
  await page.getByTitle('撤销', { exact: true }).click();
  await expect(level).toHaveValue('75.5');
  await level.fill('33.333'); await level.press('Tab');
  await expect(level).toHaveValue('75.5');
  await level.fill('33.3'); await level.press('Tab');
  await expect(page.locator('.lighting-timeline-point')).toContainText('Master 33.3%');
  await page.getByTitle('撤销', { exact: true }).click();
  await expect(level).toHaveValue('75.5');
  await level.fill('62.5'); await level.press('Tab');
  await expect(page.locator('.lighting-timeline-point')).toContainText('Master 62.5%');
  await page.getByTitle('撤销', { exact: true }).click();
  await expect(level).toHaveValue('75.5');
  await level.fill('62.5'); await level.press('Tab');
  await level.fill('101'); await level.press('Tab');
  await expect(level).toHaveValue('62.5');
  const name = page.getByLabel('推杆点名称', { exact: true });
  await name.fill('副歌渐亮'); await name.press('Tab');
  await expect(name).toHaveValue('副歌渐亮');
  await page.getByTitle('撤销', { exact: true }).click();
  await expect(name).toHaveValue('主推杆');
  await page.getByTitle('重做', { exact: true }).click();
  await expect(name).toHaveValue('副歌渐亮');
  const savedPath = testInfo.outputPath('master.tblink');
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath }); }, savedPath);
  await page.keyboard.press('Control+s');
  await expect.poll(() => existsSync(savedPath)).toBe(true);
  const saved = parseLinkProject(JSON.parse(await readFile(savedPath, 'utf8')));
  const events = saved.rundown.flatMap((item) => item.lighting?.tracks.flatMap((track) => track.clips.flatMap((clip) => clip.events)) ?? []);
  expect(events).toContainEqual(expect.objectContaining({ kind: 'ma2-fader', level: 0.625, executor: '99.219', label: '副歌渐亮' }));
  await page.reload();
  await closeLightingTools(); await main.getByRole('button', { name: '编辑器', exact: true }).click();
  await page.locator('.lighting-timeline-point').filter({ hasText: 'Master 62.5%' }).click();
  await expect(level).toHaveValue('62.5');
  await expect(name).toHaveValue('副歌渐亮');
  await page.screenshot({ path: testInfo.outputPath('master-properties.png') });
});


test('MA2 网络设置通过真实 IPC 连接双端口，保存重启自动连接并导出完整插件', async ({}, testInfo) => {
  const sockets = new Set<Socket>(); let monitor: Socket | null = null; let logins = 0; let executions = 0;
  const monitorServer = createServer((socket) => { monitor = socket; sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const commandServer = createServer((socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.write("Logged in as User 'guest'\r\n [Channel]>Please login !\r\n");
    let buffer = ''; let authenticated = false;
    socket.on('data', (data: Buffer) => {
      buffer += data.toString();
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n'); const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (line.startsWith('Login ')) { authenticated = line === 'Login "tblink-test" "synthetic-e2e-password"'; if (authenticated) logins += 1; socket.write('\r\n [Channel]>'); continue; }
        const capability = /TBLINK_CAP_[a-f0-9]{32}/.exec(line)?.[0];
        if (capability && authenticated) { monitor?.write(`\r15h11m38.613s : ${capability}:Lua 5.3|true|true|true\r\n`); continue; }
        const auth = /TBLINK_AUTH_[a-f0-9]{32}/.exec(line)?.[0];
        if (auth && authenticated) { monitor?.write(`\r15h11m38.613s : ${auth}:3.3.4.3\r\n`); continue; }
        const call = /TBLINK_NET\('([a-f0-9]{32})','([a-z]+)','([a-f0-9]{32})'/.exec(line);
        if (call) {
          const response = `${call[3]}\nOK\n7\n3.3.4.3`;
          let result = 'ACK';
          if (call[2] === 'run') { executions += 1; result = `DONE:${response.length}`; }
          if (call[2] === 'read') result = `DATA:${Buffer.from(response).toString('hex')}`;
          monitor?.write(`\r15h11m38.613s : TBLINK_RPC_${call[1]}:${result}\r\n`);
        }
      }
    });
  });
  const listen = async (server: Server): Promise<number> => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test peer address unavailable'); return address.port;
  };
  const monitorPort = await listen(monitorServer); const port = await listen(commandServer);
  const navigate = async (): Promise<void> => {
    await closeLightingTools(); await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
    await page.getByLabel('MA2 连接方式').selectOption('network');
  };
  try {
    await navigate(); await expect(page.getByLabel('MA2 控台 IP')).toBeEnabled();
    await page.getByLabel('MA2 控台 IP').fill('127.0.0.1'); await page.getByLabel('MA2 登录用户').fill('tblink-test');
    await page.getByLabel('MA2 登录密码').fill('synthetic-e2e-password'); await page.getByLabel('启动时自动连接 MA2').check();
    await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
    await expect(page.getByLabel('MA2 登录密码')).toHaveValue('synthetic-e2e-password');
    await page.getByLabel('MA2 远程端口').fill(String(port)); await page.getByLabel('MA2 监视端口').fill(String(monitorPort));
    await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
    await page.getByRole('button', { name: '保存并连接', exact: true }).click();
    await expect(page.locator('.ma2-device-status')).toHaveText('已连接');
    await expect(page.locator('.toolbar-connections').getByText('网络已连接', { exact: true })).toBeVisible();
    await expect.poll(() => executions).toBe(1);
    await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
    await page.getByLabel('MA2 MSC 设备号').fill('5'); await page.getByLabel('MA2 MSC 设备号').press('Tab');
    await expect.poll(() => page.evaluate(() => window.tbLink.loadIntegrationProfile())).toMatchObject({ lighting: { mscDeviceId: 5 } });
    await page.getByRole('button', { name: '检测版本兼容性', exact: true }).click();
    await expect(page.getByText(/基础接口可用；请读取目标 Timecode/)).toBeVisible();
    const settingsPath = testInfo.outputPath('user-data', 'link-integrations', 'ma2-network.json');
    const saved = await readFile(settingsPath, 'utf8'); expect(saved).not.toContain('synthetic-e2e-password'); expect(JSON.parse(saved) as unknown).toMatchObject({ format: 1, active: { host: '127.0.0.1', port, monitorPort, autoConnect: true } });
    const destination = testInfo.outputPath('plugin-export'); await mkdir(destination, { recursive: true });
    await application.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [directory] }); }, destination);
    await page.getByRole('button', { name: '导出控台插件', exact: true }).click();
    await expect.poll(async () => (await readdir(destination)).length).toBe(1);
    const folder = (await readdir(destination))[0]!;
    await expect.poll(async () => (await readdir(join(destination, folder))).length).toBe(3);
    expect(await readFile(join(destination, folder, 'tblink_bridge.lua'), 'utf8')).toBe(await readFile(join(process.cwd(), '../../tools/ma2/tblink_bridge.lua'), 'utf8'));
    await page.screenshot({ path: testInfo.outputPath('ma2-maintenance.png') });
    await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath('ma2-network-settings.png') });
    await page.getByLabel('已保存 MA2 控台').selectOption('-1');
    await page.getByLabel('MA2 控台 IP').fill('192.168.77.8'); await page.getByLabel('MA2 登录用户').fill('other-console');
    await page.getByRole('button', { name: '仅保存', exact: true }).click();
    await expect(page.getByLabel('已保存 MA2 控台').locator('option')).toHaveCount(3);
    await page.getByLabel('已保存 MA2 控台').selectOption('0');
    await expect(page.getByLabel('MA2 控台 IP')).toHaveValue('127.0.0.1');
    await page.getByRole('button', { name: '仅保存', exact: true }).click();
    await application.close(); application = await electron.launch({ args: [`--user-data-dir=${testInfo.outputPath('user-data')}`, desktopEntry] }); page = await application.firstWindow();
    await expect.poll(() => logins).toBe(2); await navigate();
    await expect(page.getByLabel('已保存 MA2 控台').locator('option')).toHaveCount(3);
    await expect(page.getByLabel('MA2 控台 IP')).toHaveValue('127.0.0.1'); await expect(page.getByLabel('MA2 登录密码')).toHaveValue('');
    await expect(page.locator('.ma2-device-status')).toHaveText('已连接');
    await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
    await expect(page.getByLabel('MA2 MSC 设备号')).toHaveValue('5');
    await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
    await page.getByRole('button', { name: '断开', exact: true }).click();
    await expect(page.locator('.ma2-network-settings').getByRole('status')).toHaveText('未连接'); expect(logins).toBe(2);
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all([commandServer, monitorServer].map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  }
});


test('设备连接三种尺寸、跨页草稿与搜索目标隔离', async ({}, testInfo) => {
  await beginNewProject(); await page.getByLabel('工程名称').fill('设备页面验收'); await page.getByRole('button', { name: '创建工程' }).click(); await addEmptyProgram();
  await closeLightingTools(); await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
  const menu = page.getByRole('navigation', { name: '设置子菜单' });
  await menu.getByRole('button', { name: '播放', exact: true }).click(); await page.getByLabel('播放主控模式').selectOption('internal');
  await menu.getByRole('button', { name: '设备连接', exact: true }).click();
  await page.getByLabel('MA2 连接方式').selectOption('network');
  await page.getByLabel('MA2 控台 IP').fill('192.168.1.50'); await page.getByLabel('MA2 登录用户').fill('operator'); await page.getByLabel('MA2 登录密码').fill('draft-only');
  await page.getByLabel('WebSocket 地址').fill('ws://127.0.0.1:4460'); await page.getByLabel('OBS 密码', { exact: true }).fill('obs-draft');
  await menu.getByRole('button', { name: '设备连接', exact: true }).click();
  await expect(page.getByRole('button', { name: '导出控台插件', exact: true })).toBeVisible();
  await page.getByLabel('MA2 远程端口').fill('30002');
  await menu.getByRole('button', { name: '播放', exact: true }).click(); await menu.getByRole('button', { name: '设备连接', exact: true }).click();
  await expect(page.getByLabel('MA2 登录密码')).toHaveValue('draft-only'); await expect(page.getByLabel('OBS 密码', { exact: true })).toHaveValue('obs-draft');
  await expect(page.getByLabel('WebSocket 地址')).toHaveValue('ws://127.0.0.1:4460');
  await expect(page.locator('.device-maintenance-section').getByRole('button', { name: '导出控台插件', exact: true })).toHaveCount(1);
  await expect(page.getByLabel('读取 MA2 Timecode 编号')).toHaveCount(0);
  await expect(page.locator('.device-maintenance-section').getByLabel('MA2 远程端口')).toHaveCount(1);
  for (const [width, height] of [[1920, 1080], [1440, 900], [1200, 800]] as const) {
    await application.evaluate(({ BrowserWindow }, size) => { BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height); }, { width, height });
    await page.locator('.settings-page').evaluate((element) => { element.scrollTop = 0; });
    await expect.poll(() => page.locator('.settings-detail').evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    expect((await page.getByLabel('MA2 控台 IP').boundingBox())!.width).toBeLessThanOrEqual(240);
    expect((await page.getByLabel('MA2 登录用户').boundingBox())!.width).toBeLessThanOrEqual(300);
    expect((await page.getByLabel('灯光 MIDI 输出').boundingBox())!.width).toBeLessThanOrEqual(360);
    await expect(page.getByLabel('音乐监听设备')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`devices-${width}.png`) });
  }
  await application.evaluate(({ ipcMain }) => { ipcMain.removeHandler('link:ma2-discover'); ipcMain.handle('link:ma2-discover', () => ({ hosts: [{ host: '192.168.1.60', port: 30000, identity: 'ma2' }], ranges: ['192.168.1.0/24'], warnings: [] })); });
  await page.getByRole('button', { name: '搜索局域网控台', exact: true }).click();
  await expect(page.getByLabel('MA2 控台 IP')).toHaveValue('192.168.1.50');
  await page.getByRole('button', { name: '192.168.1.60:30000 · MA2 远程入口', exact: true }).click();
  await expect(page.getByLabel('MA2 控台 IP')).toHaveValue('192.168.1.60'); await expect(page.getByLabel('MA2 登录密码')).toHaveValue('');
  await expect(page.getByLabel('MA2 登录用户')).toHaveValue('');
  await openLightingTools('节目同步');
  await expect(page.getByRole('dialog', { name: '节目同步' })).toContainText('节目 1');
  await expect(page.getByLabel('MA2 节目同步')).toContainText('请先在设备连接中保存并连接控台');
});


test('无灯光轨道的节目可以从节目同步导入并撤销', async ({}, testInfo) => {
  const project = createEmptyLinkProject('无轨道导入'); project.schemaVersion = 2;
  project.rundown.push({ id: 'empty', title: '未编排节目', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting: createLightingDocument() });
  const destination = testInfo.outputPath('empty.tblink'); await writeFile(destination, JSON.stringify(project));
  const xml = await readFile(join(process.cwd(), 'src/main/link/fixtures/ma2-timecode-fractional-3.3.xml'), 'utf8');
  const sequenceXml = await readFile(join(process.cwd(), 'src/main/link/fixtures/ma2-sequence-fractional-3.3.xml'), 'utf8');
  const sequence = sequenceXml.match(/<Sequ\s[\s\S]*?<\/Sequ>/)?.[0]; if (!sequence) throw new Error('缺少测试序列');
  const preview = convertMa2Snapshot(xml.replace('</MA>', `${sequence}</MA>`), 9902);
  await application.evaluate(({ dialog, ipcMain }, value) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [value.path] }); ipcMain.removeHandler('link:ma2-preview'); ipcMain.handle('link:ma2-preview', () => value.preview); }, { path: destination, preview });
  await page.getByRole('button', { name: '打开工程', exact: true }).click();
  await closeLightingTools(); await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
  const menu = page.getByRole('navigation', { name: '设置子菜单' });
  await menu.getByRole('button', { name: '设备连接', exact: true }).click(); await page.getByLabel('MA2 连接方式').selectOption('local');
  await menu.getByRole('button', { name: '设备连接', exact: true }).click(); await page.getByLabel('MA2 onPC 数据目录').fill('C:/MA2-Test');
  await openLightingTools('节目同步');
  await expect(page.getByRole('dialog', { name: '节目同步' })).toContainText('未编排节目');
  await page.getByLabel('读取 MA2 Timecode 编号').fill('9902'); await page.getByRole('button', { name: '读取灯光编排', exact: true }).click(); await page.getByRole('button', { name: '加入当前节目', exact: true }).click();
  await expect.poll(async () => parseLinkProject(JSON.parse(await readFile(destination, 'utf8'))).rundown[0]!.lighting!.tracks.length).toBeGreaterThan(0);
  await closeLightingTools(); await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click(); await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => parseLinkProject(JSON.parse(await readFile(destination, 'utf8'))).rundown[0]!.lighting!.tracks.length).toBe(0);
});


test('灯光轨道无需选 Cue 即可编辑，工具按需打开且三种尺寸清晰', async ({}, testInfo) => {
  await beginNewProject(); await page.getByLabel('工程名称').fill('灯光属性验收');
  await page.getByRole('button', { name: '创建工程' }).click(); await addEmptyProgram();
  await openLightingTrack();
  await expect(page.locator('.lighting-timeline-point.selected')).toHaveCount(0);
  await page.getByLabel('灯光轨道名称').fill('主灯光'); await page.getByLabel('灯光轨道名称').press('Tab');
  await expect(page.locator('.lighting-track-name')).toContainText('主灯光');
  await page.getByLabel('灯光打点方式').selectOption('marker');
  await page.getByLabel('灯光打点方式').selectOption('sequence');
  for (const [width, height] of [[1920, 1080], [1440, 900], [1200, 800]] as const) {
    await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height), { width, height });
    await expect(page.getByLabel('灯光播放方式')).toBeVisible();
    await expect(page.getByRole('button', { name: '节目同步 / 绑定执行器', exact: true })).toBeVisible();
    await expect.poll(() => page.locator('.lighting-inspector-host').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    expect((await page.getByLabel('灯光播放方式').boundingBox())!.width).toBeLessThanOrEqual(320);
    await page.screenshot({ path: testInfo.outputPath(`track-properties-${width}.png`) });
  }
  await page.locator('.lighting-clip').first().dblclick({ position: { x: 96, y: 30 } });
  await expect(page.getByLabel('灯光点歌曲时间')).toBeEnabled();
  await expect(page.getByLabel('灯光播放方式')).toHaveCount(0);
  await page.getByRole('button', { name: '轨道属性', exact: true }).click();
  await expect(page.getByLabel('灯光轨道名称')).toHaveValue('主灯光');
  await page.getByRole('button', { name: '节目同步 / 绑定执行器', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '节目同步', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator('.lighting-track-more > summary').click();
  await page.getByLabel('MIDI 通道', { exact: true }).fill('12'); await page.getByLabel('MIDI 通道', { exact: true }).press('Tab');
  await expect(page.getByLabel('MIDI 通道', { exact: true })).toHaveValue('12');
  await page.getByLabel('MIDI 通道', { exact: true }).fill('17'); await page.getByLabel('MIDI 通道', { exact: true }).press('Tab');
  await expect(page.getByLabel('MIDI 通道', { exact: true })).toHaveValue('12');
  await openLightingTools('节拍与循环');
  const bpm = page.getByLabel('变速点 1 BPM'); await bpm.fill('90'); await bpm.press('Tab'); await expect(bpm).toHaveValue('90');
  await page.screenshot({ path: testInfo.outputPath('tempo-tools.png') });
  await closeLightingTools(); await openLightingTools('节拍与循环'); await expect(bpm).toHaveValue('90');
  await openLightingTools('导入与导出'); await page.screenshot({ path: testInfo.outputPath('file-tools.png') });
  await closeLightingTools();
  await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '灯光', exact: true })).toHaveCount(0);
});


test('维护合并设备连接，外观和更新同页，移除诊断日志入口', async ({}, testInfo) => {
  await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
  const menu = page.getByRole('navigation', { name: '设置子菜单' });
  await expect(menu.getByRole('button')).toHaveText(['设备连接', '播放', '画面与同步', '外观与更新']);
  await expect(page.locator('.device-maintenance-section')).toContainText('设备维护');
  await expect(page.locator('.device-maintenance-section').getByLabel('MA2 远程端口')).toHaveCount(1);
  await page.getByLabel('MA2 控台 IP').fill('192.168.1.50');
  await menu.getByRole('button', { name: '外观与更新', exact: true }).click();
  await expect(page.getByLabel('外观', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '软件更新', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('appearance-update.png') });
  await expect(page.getByRole('button', { name: /诊断.*日志/ })).toHaveCount(0);
  await page.getByRole('button', { name: '软件更新', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '软件更新', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await menu.getByRole('button', { name: '设备连接', exact: true }).click();
  await expect(page.getByLabel('MA2 控台 IP')).toHaveValue('192.168.1.50');
  await page.locator('.device-maintenance-section > h3').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('device-maintenance.png') });
  const p1 = page.locator('.p1-sync-panel');
  await p1.scrollIntoViewIfNeeded();
  expect((await p1.locator('p').boundingBox())!.width).toBeGreaterThan(300);
  expect((await p1.locator('p').boundingBox())!.height).toBeLessThan(100);
  await page.screenshot({ path: testInfo.outputPath('p1-maintenance.png') });
});


test('一键连接顶部和设备页共用动作，连接中禁止重复点击', async ({}, testInfo) => {
  await application.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('link:detect-local-integrations');
    Reflect.set(globalThis, '__quickConnectCalls', 0);
    ipcMain.handle('link:detect-local-integrations', () => {
      Reflect.set(globalThis, '__quickConnectCalls', Number(Reflect.get(globalThis, '__quickConnectCalls')) + 1);
      return new Promise((_resolve, reject) => Reflect.set(globalThis, '__releaseQuickConnect', () => reject(new Error('测试连接未完成'))));
    });
  });
  const top = page.getByRole('button', { name: '顶部一键连接', exact: true });
  await expect(top).toBeEnabled(); await top.click(); await expect(top).toBeDisabled();
  const main = page.getByRole('navigation', { name: '主要工作区' });
  await main.getByRole('button', { name: '设置', exact: true }).click();
  const device = page.getByRole('button', { name: '一键识别并连接', exact: true });
  await expect(device).toBeDisabled();
  await expect.poll(() => application.evaluate(() => Number(Reflect.get(globalThis, '__quickConnectCalls')))).toBe(1);
  await application.evaluate(() => { const release: unknown = Reflect.get(globalThis, '__releaseQuickConnect'); if (typeof release === 'function') (release as () => void)(); });
  await expect(device).toBeEnabled(); await expect(top).toBeEnabled();
  expect((await device.boundingBox())!.y).toBeLessThan((await page.getByLabel('MA2 连接设置').getByRole('heading', { name: 'MA2 控台', exact: true }).boundingBox())!.y);
  await expect(page.locator('.device-maintenance-section').getByRole('button', { name: '一键识别并连接', exact: true })).toHaveCount(0);
  await device.click(); await expect(top).toBeDisabled();
  await expect.poll(() => application.evaluate(() => Number(Reflect.get(globalThis, '__quickConnectCalls')))).toBe(2);
  await application.evaluate(() => { const release: unknown = Reflect.get(globalThis, '__releaseQuickConnect'); if (typeof release === 'function') (release as () => void)(); });
  await expect(top).toBeEnabled();
  for (const [width, height] of [[1920, 1080], [1440, 900], [1200, 800]] as const) {
    await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height), { width, height });
    await expect(top).toBeVisible();
    expect((await top.boundingBox())!.x + (await top.boundingBox())!.width).toBeLessThanOrEqual((await page.getByRole('button', { name: '最小化窗口' }).boundingBox())!.x);
    await page.screenshot({ path: testInfo.outputPath(`quick-connect-${width}.png`) });
  }
});


test('顶部连接状态切换主菜单位置固定且不遮挡操作', async ({}, testInfo) => {
  await beginNewProject(); await page.getByLabel('工程名称').fill('顶部固定位置');
  await page.getByRole('button', { name: '创建工程' }).click(); await addEmptyProgram();
  const main = page.getByRole('navigation', { name: '主要工作区' });
  for (const [width, height] of [[1920, 1080], [1440, 900], [1200, 800]] as const) {
    await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height), { width, height });
    const bounds: { x: number; y: number; width: number; height: number }[] = [];
    for (const name of ['节目单', '编辑器', '设置']) {
      await main.getByRole('button', { name, exact: true }).click();
      await expect(page.locator('.toolbar-connections')).toHaveCount(1);
      const box = await page.locator('.toolbar-connections').boundingBox(); if (!box) throw new Error('顶部连接状态不可见'); bounds.push(box);
      const connect = await page.getByRole('button', { name: '顶部一键连接' }).boundingBox();
      expect(box.x + box.width).toBeLessThan(connect!.x);
      await page.screenshot({ path: testInfo.outputPath(`fixed-status-${width}-${name}.png`) });
    }
    expect(bounds[1]).toEqual(bounds[0]); expect(bounds[2]).toEqual(bounds[0]);
  }
});
