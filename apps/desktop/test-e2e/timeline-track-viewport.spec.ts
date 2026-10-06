import { test, expect, _electron as electron } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';

test('纵向滚动显示真实轨道 Cue，选中项和撤销不因离开视口丢失', async ({}, info) => {
  const layers = Array.from({ length: 40 }, (_, index) => ({ id: `layer-${index}`, name: `图层 ${index}` }));
  const project = parseLinkProject({ ...createEmptyLinkProject('轨道视口'), rundown: [{ id: 'song', title: '歌曲', visualLayers: layers,
    cues: layers.map((layer, index) => ({ id: `cue-${index}`, layerId: layer.id, name: `步骤 ${index}`, durationMs: 5000,
      timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, actions: [{ id: `action-${index}`, label: '机位', kind: 'obs.setProgramScene', sceneName: `机位 ${index}` }] })) }] });
  const file = info.outputPath('tracks.tblink'); await writeFile(file, JSON.stringify(project));
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), process.env.TBLINK_MTC_SOAK_BUILD_DIR ?? 'out', 'main/index.cjs')] });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
    const top = page.locator('[data-visual-layer-id="layer-0"] .timeline-cue');
    const last = page.locator('[data-visual-layer-id="layer-39"] .timeline-cue');
    await expect(top).toBeVisible(); await expect(last).toHaveCount(0);
    const viewport = page.locator('.timeline-viewport');
    const bounds = await top.boundingBox(); if (!bounds) throw new Error('顶部 Cue 未绘制');
    await page.mouse.move(bounds.x + 60, bounds.y + bounds.height / 2); await page.mouse.down();
    await page.mouse.move(bounds.x + 80, bounds.y + bounds.height / 2);
    await expect(top).toHaveClass(/is-dragging/);
    await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(last).toBeVisible(); await expect(top).toHaveCount(1);
    await expect(page.locator('[data-visual-layer-id="layer-20"] .timeline-cue')).toHaveCount(0);
    await page.keyboard.press('Escape'); await page.mouse.up();
    await viewport.evaluate(element => { element.scrollTop = 0; });
    await expect(top).toBeVisible(); await expect(top).not.toHaveClass(/is-dragging/);
    await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(last).toBeVisible(); await last.click();
    await expect(last).toHaveAttribute('aria-pressed', 'true');
    await viewport.evaluate(element => { element.scrollTop = 0; });
    await expect(top).toBeVisible(); await expect(last).toHaveCount(1);
    await page.locator('.reference-timeline').focus(); await page.keyboard.press('Delete');
    await expect(last).toHaveCount(0); await page.keyboard.press('Control+z');
    await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(last).toBeVisible();
    await page.screenshot({ path: info.outputPath('tracks-bottom.png') });
    await page.evaluate(() => window.tbLink.setDocumentDirty(false));
  } finally { await app.close(); }
});
