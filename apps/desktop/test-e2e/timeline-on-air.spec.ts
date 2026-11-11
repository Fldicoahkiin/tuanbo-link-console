import { test, expect, _electron as electron } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { closeDiscarding } from './save-questions';

const at = (seconds: number) => ({ hours: 0, minutes: 0, seconds, frames: 0 });
const camera = (id: string, start: number, durationMs: number) => ({ id, name: id, layerId: 'cameras', timecode: at(start), durationMs,
  actions: [{ id: `${id}-scene`, label: id, kind: 'obs.setProgramScene' as const, sceneName: `机位 ${id}` }] });

test('被上层机位挡住的部分变暗；修剪停在旁边的片段；拖到被占的位置提示放到上方新轨道', async ({}, info) => {
  const project = parseLinkProject({ ...createEmptyLinkProject('播出标记'),
    mediaAssets: [{ id: 'video', name: '舞蹈', kind: 'video', relativePath: 'assets/dance.mp4', sha256: 'a'.repeat(64), byteLength: 1, durationMs: 20_000, width: 1080, height: 1920 }],
    rundown: [{ id: 'song', title: '播出标记', visualLayers: [{ id: 'cameras', name: '机位' }, { id: 'videos', name: '视频' }],
      referenceMediaClips: [{ id: 'clip', assetId: 'video', label: '舞蹈', layerId: 'videos', startTimecode: at(0), durationMs: 10_000 }],
      cues: [camera('a', 4, 2_000), camera('b', 8, 1_000)] }] });
  const file = info.outputPath('on-air.tblink'); await writeFile(file, JSON.stringify(project));
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')] });
  const page = await app.firstWindow();
  try {
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();

    const clip = page.locator('.timeline-clip.video');
    await expect(clip).toHaveAttribute('data-off-air', 'part');
    await expect(clip).toHaveAttribute('title', /变暗的部分被上面的机位挡住，不会播出/);
    // 4–6 s and 8–9 s of a 10 s clip.
    expect(await clip.locator('.timeline-off-air').evaluateAll(parts => parts.map(part => [(part as HTMLElement).style.left, (part as HTMLElement).style.width])))
      .toEqual([['40%', '20%'], ['80%', '10%']]);
    const first = page.locator('.timeline-cue.visual-obs-clip', { hasText: '机位 a' });
    const second = page.locator('.timeline-cue.visual-obs-clip', { hasText: '机位 b' });
    await expect(first).not.toHaveAttribute('data-off-air', /.+/);

    // Trimming camera a's end toward camera b stops at b while the mouse is still down.
    const secondBox = await second.boundingBox(); const firstBox = await first.boundingBox();
    if (!secondBox || !firstBox) throw new Error('机位没有画出来');
    await first.hover();
    const handle = await first.locator('.timeline-trim-handle.end').boundingBox(); if (!handle) throw new Error('机位尾部不可见');
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
    await page.mouse.move(secondBox.x + secondBox.width + 40, handle.y + handle.height / 2, { steps: 8 });
    const gapToSecond = async (): Promise<number> => { const box = await first.boundingBox(); if (!box) throw new Error('机位不见了'); return Math.abs(box.x + box.width - secondBox.x); };
    await expect.poll(gapToSecond).toBeLessThanOrEqual(1);
    await page.mouse.up();
    await expect.poll(gapToSecond).toBeLessThanOrEqual(1);

    // Dragging camera b onto a's place on the same track says it goes on a new track above.
    await expect(page.locator('[data-visual-layer-id]')).toHaveCount(2);
    await page.mouse.move(secondBox.x + secondBox.width / 2, secondBox.y + secondBox.height / 2); await page.mouse.down();
    await page.mouse.move(firstBox.x + 20, secondBox.y + secondBox.height / 2, { steps: 8 });
    await expect(page.locator('.cue-lane.is-drop-above')).toHaveCount(1);
    await expect(page.locator('.visual-layer-drop-state > em')).toHaveText('放到新轨道');
    await page.mouse.up();
    await expect(page.locator('[data-visual-layer-id]')).toHaveCount(3);
    await expect(page.locator('.cue-lane.is-drop-above')).toHaveCount(0);
  } finally { await closeDiscarding(app); }
});
