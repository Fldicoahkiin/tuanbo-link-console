import { test, expect, _electron as electron } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject } from '@tb/schema';

test('40 个来源只显示一条灯光轨，跨来源选点、移动和撤销不改变绑定', async ({}, info) => {
  const lighting = createLightingDocument();
  lighting.tracks = Array.from({ length: 40 }, (_, index) => ({ id: `track-${index}`, name: `来源 ${index}`, kind: 'ma2', color: '#68c9ed', group: 'effect-canvas', muted: false, solo: false, locked: false, channel: 1, controller: 7, portProfileId: '', noteNames: {}, clips: [{ id: `clip-${index}`, name: '灯光', start: 0, duration: 60000, timeLock: 'time', muted: false, events: [{ id: `cue-${index}`, kind: 'ma2', at: (index + 1) * 1000, sequence: index + 1, cue: '1.000', executor: '', action: 'goto', label: `灯光 ${index}` }] }] }));
  const project = parseLinkProject({ ...createEmptyLinkProject('单条灯光轨验收'), schemaVersion: 2, rundown: [{ id: 'song', title: '40 个灯光点', cues: [], lighting }] });
  const file = info.outputPath('single-lane.tblink'); await writeFile(file, JSON.stringify(project));
  const saved = async () => parseLinkProject(JSON.parse(await readFile(file, 'utf8'))).rundown[0]!.lighting!;
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')], env: { ...process.env, TBLINK_LOCAL_TEST_ACCESS: '1' } });
  try {
    const page = await app.firstWindow(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ dialog, BrowserWindow }, file) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [file] }); BrowserWindow.getAllWindows()[0]?.setSize(1540, 960); }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    const nav = page.getByRole('navigation', { name: '主要工作区' });
    await nav.getByRole('button', { name: '灯光工作台', exact: true }).click();
    await nav.getByRole('button', { name: '编辑器', exact: true }).click();
    const lane = page.getByLabel('灯光时间线', { exact: true });
    await expect(lane).toBeVisible(); await expect(page.locator('.lighting-lane:visible')).toHaveCount(1);
    await expect(page.locator('.lighting-heading:visible')).toHaveCount(1);
    expect((await lane.boundingBox())!.height).toBe(72);
    const target = lane.getByRole('button', { name: '灯光点 灯光 20', exact: true });
    await target.click();
    await expect(page.getByLabel('Cue 名称', { exact: true })).toHaveValue('灯光 20');
    await page.keyboard.press('Control+s'); expect((await saved()).tracks).toEqual(lighting.tracks);
    const point = (await target.boundingBox())!;
    await expect(page.locator('.toast.info').filter({ hasText: '工程已保存' }).last()).toHaveCSS('pointer-events', 'none');
    await page.mouse.move(point.x + point.width / 2, point.y + 18); await page.mouse.down();
    await page.mouse.move(point.x + point.width / 2 + 20, point.y + 18, { steps: 5 }); await page.mouse.up();
    await page.keyboard.press('Control+s');
    await expect.poll(async () => (await saved()).tracks[20]!.clips[0]!.events[0]!.at).not.toBe(21000);
    const changed = await saved();
    expect(changed.tracks.filter((_, index) => index !== 20)).toEqual(lighting.tracks.filter((_, index) => index !== 20));
    expect(changed.tracks[20]!.clips[0]!.events[0]).toMatchObject({ sequence: 21, cue: '1.000', id: 'cue-20' });
    await page.getByRole('button', { name: '撤销', exact: true }).click(); await page.keyboard.press('Control+s');
    await expect.poll(async () => (await saved()).tracks).toEqual(lighting.tracks);
    await page.screenshot({ path: info.outputPath('single-lighting-lane.png') });
    expect(errors).toEqual([]);
  } catch (error) { const page = await app.firstWindow(); await page.screenshot({ path: info.outputPath('failure.png') }); await writeFile(info.outputPath('failure.txt'), await page.locator('body').innerText()); throw error; } finally { await app.close(); }
});
