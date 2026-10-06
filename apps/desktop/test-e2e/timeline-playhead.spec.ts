import { test, expect, _electron as electron } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';

test('播放头合并高频移动，松手保留最后位置且旧帧不能拉回', async ({}, info) => {
  const project = parseLinkProject({ ...createEmptyLinkProject('播放头响应验收'), rundown: [{ id: 'song', title: '测试节目', cues: [] }] });
  const file = info.outputPath('playhead.tblink');
  await writeFile(file, JSON.stringify(project));
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), process.env.TBLINK_MTC_SOAK_BUILD_DIR ?? 'out', 'main/index.cjs')] });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
    const ruler = page.locator('.timeline-ruler');
    const bounds = await ruler.boundingBox();
    if (!bounds) throw new Error('时间尺不可见');
    await page.mouse.move(bounds.x + 120, bounds.y + 10); await page.mouse.down();
    const result = await ruler.evaluate(async element => {
      const line = document.querySelector<HTMLElement>('.timeline-playhead');
      if (!line) throw new Error('播放头不存在');
      const bounds = element.getBoundingClientRect();
      let writes = 0, frames = 0, measuring = true;
      const countFrame = (): void => { frames++; if (measuring) requestAnimationFrame(countFrame); };
      requestAnimationFrame(countFrame);
      const observer = new MutationObserver(records => { writes += records.length; });
      observer.observe(line, { attributes: true, attributeFilter: ['style'] });
      for (let i = 0; i < 80; i++) {
        element.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: bounds.left + 120 + i * 2, clientY: bounds.top + 10 }));
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      await new Promise<void>(resolve => requestAnimationFrame(() => { resolve(); }));
      const during = parseFloat(line.style.left);
      element.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: bounds.left + 350, clientY: bounds.top + 10 }));
      element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: bounds.left + 420, clientY: bounds.top + 10 }));
      await new Promise(resolve => setTimeout(resolve, 60));
      observer.disconnect();
      measuring = false;
      return { writes, frames, during, final: parseFloat(line.style.left) };
    });
    await page.mouse.up();
    expect(result.during).toBeGreaterThan(250);
    expect(result.final).toBeGreaterThan(410);
    expect(result.final).toBeLessThan(430);
    expect(result.writes).toBeLessThanOrEqual(result.frames + 3);
    await writeFile(info.outputPath('pointer-metrics.json'), JSON.stringify(result, null, 2));
    await info.attach('pointer-metrics', { body: JSON.stringify(result), contentType: 'application/json' });
  } finally { await app.close(); }
});
