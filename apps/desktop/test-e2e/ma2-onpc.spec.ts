import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject } from '@tb/schema';
import { Ma2OnpcBridge } from '../src/main/link/ma2-onpc-bridge';
import { inspectMa2TimecodeXml, patchMa2EventTimes } from '../src/main/link/ma2-timecode-xml';

async function openSync(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
  await page.locator('.timeline-lighting-tools > summary').click();
  await page.locator('.timeline-lighting-tools').getByRole('button', { name: '节目同步', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '节目同步', exact: true })).toBeVisible();
}

test('真实 onPC 经界面导入、修改、同步、冲突选择与保存重开，最后还原专属对象', async ({}, info) => {
  const directory = process.env.MA2_ONPC_DATA_DIRECTORY;
  test.skip(!process.env.TBLINK_MA2_ONPC_E2E || !directory, '需要明确启用真实 onPC 专属对象验收');
  if (!directory) throw new Error('缺少 onPC 数据目录');
  test.setTimeout(180_000);
  const bridge = new Ma2OnpcBridge(directory, () => false);
  const original = await bridge.request('READ', 9902);
  const baseline = inspectMa2TimecodeXml(original);
  expect(baseline.timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
  await writeFile(info.outputPath('before.xml'), original);
  const project = createEmptyLinkProject('MA2 onPC 实际界面验收');
  project.schemaVersion = 2;
  project.rundown.push({ id: 'acceptance', title: 'onPC 验收节目', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting: createLightingDocument() });
  const destination = info.outputPath('onpc.tblink');
  await writeFile(destination, JSON.stringify(project));
  const application = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')] });
  const page = await application.firstWindow();
  try {
    await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, destination);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    // Configure the isolated profile; all MA2 IPC handlers and adapters remain real.
    await page.evaluate((path) => {
      localStorage.setItem('tblink.ma2-connection-method.v1', 'local');
      localStorage.setItem('tblink.ma2-onpc-data-directory.v1', path);
    }, directory);
    await page.reload();
    await openSync(page);
    const read = async (): Promise<void> => {
      await page.getByLabel('读取 MA2 Timecode 编号').fill('9902');
      await page.getByRole('button', { name: '读取灯光编排', exact: true }).click();
      await expect(page.getByRole('region', { name: 'MA2 灯光读取预览' })).toBeVisible();
    };
    const saved = async () => parseLinkProject(JSON.parse(await readFile(destination, 'utf8'))).rundown[0]!.lighting!;
    const times = async () => (await saved()).tracks.flatMap(track => track.clips.flatMap(clip => clip.events.map(event => clip.start + event.at)));
    await read();
    await page.getByRole('button', { name: '加入当前节目', exact: true }).click();
    await expect.poll(times).toEqual([0, 1500]);
    await page.getByRole('button', { name: '关闭灯光工具', exact: true }).click();
    await page.locator('.lighting-timeline-point').last().click();
    await page.getByLabel('灯光点歌曲时间').fill('1.2');
    await page.getByLabel('灯光点歌曲时间').press('Tab');
    await expect.poll(times).toEqual([0, 1200]);
    await openSync(page); await read();
    await page.getByRole('button', { name: '比较节目与控台修改', exact: true }).click();
    await expect(page.getByLabel('节目与控台差异')).toContainText('没有冲突');
    await page.getByRole('button', { name: '同步节目与 MA2', exact: true }).click();
    await expect(page.getByLabel('MA2 节目同步')).toContainText('已同步并核对');
    const written = await bridge.request('READ', 9902);
    await writeFile(info.outputPath('written.xml'), written);
    expect(inspectMa2TimecodeXml(written).timecodes[0]?.tracks[0]?.subtracks[0]?.events[1]?.attributes.time).toBe('36');
    await page.getByRole('button', { name: '关闭灯光工具', exact: true }).click();
    await page.locator('.lighting-timeline-point').last().click();
    await page.getByLabel('灯光点歌曲时间').fill('1'); await page.getByLabel('灯光点歌曲时间').press('Tab');
    await expect.poll(times).toEqual([0, 1000]);
    const report = inspectMa2TimecodeXml(written);
    const event = report.timecodes[0]!.tracks[0]!.subtracks[0]!.events[1]!;
    await bridge.request('APPLY', 9902, written, patchMa2EventTimes(written, report.sha256, [{ path: event.path, rawTime: '42' }]));
    await openSync(page); await read();
    await page.getByRole('button', { name: '比较节目与控台修改', exact: true }).click();
    await expect(page.getByLabel('节目与控台差异')).toContainText('1 处冲突');
    await page.getByLabel('冲突 1 保留版本').selectOption('remote');
    await page.screenshot({ path: info.outputPath('conflict.png') });
    await page.getByRole('button', { name: '同步节目与 MA2', exact: true }).click();
    await expect(page.getByLabel('MA2 节目同步')).toContainText('已同步并核对');
    await expect.poll(times).toEqual([0, 1400]);
    await page.getByRole('button', { name: '关闭灯光工具', exact: true }).click();
    await page.reload();
    await expect.poll(times).toEqual([0, 1400]);
    await openSync(page); await read();
    await page.getByRole('button', { name: '比较节目与控台修改', exact: true }).click();
    await expect(page.getByLabel('节目与控台差异')).toContainText('没有冲突');
    await page.screenshot({ path: info.outputPath('reopened.png') });
  } finally {
    try {
      const current = await bridge.request('READ', 9902);
      expect(inspectMa2TimecodeXml(current).timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
      const restored = await bridge.request('APPLY', 9902, current, original);
      await writeFile(info.outputPath('restored.xml'), restored);
      expect(inspectMa2TimecodeXml(restored).timecodes).toEqual(baseline.timecodes);
    } finally {
      await page.evaluate(() => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null }));
      await application.close();
    }
  }
});
