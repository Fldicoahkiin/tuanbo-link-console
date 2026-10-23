import { test, expect, _electron as electron } from '@playwright/test';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { parseLinkProject } from '@tb/schema';

test('高负载工程真实打开、检索与切页，素材只挂载视口范围', async ({}, info) => {
  test.skip(!process.env.TBLINK_STABILITY_FIXTURE, '需先生成独立高负载验收工程');
  const original = resolve(process.env.TBLINK_STABILITY_FIXTURE!);
  const file = join(dirname(original), `ui-acceptance-${randomUUID()}.tblink`);
  await copyFile(original, file);
  const project = parseLinkProject(JSON.parse(await readFile(file, 'utf8')));
  expect(project.rundown).toHaveLength(200);
  expect(project.mediaAssets).toHaveLength(2000);
  expect(project.rundown.reduce((sum, item) => sum + item.cues.length + (item.lighting?.tracks.reduce((count, track) => count + track.clips.reduce((events, clip) => events + clip.events.length, 0), 0) ?? 0), 0)).toBe(50000);
  const phases: { name: string; elapsedMs: number; rendererAt: number; rows: number; metrics: unknown }[] = [];
  const errors: string[] = [];
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), process.env.TBLINK_MTC_SOAK_BUILD_DIR ?? 'out', 'main/index.cjs')] });
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  const profileStartedAt = await page.evaluate(() => performance.now());
  if (process.env.TBLINK_STABILITY_PROFILE === '1') await app.evaluate(async ({ BrowserWindow }) => {
    const debug = BrowserWindow.getAllWindows()[0]!.webContents.debugger;
    debug.attach('1.3'); await debug.sendCommand('Profiler.enable'); await debug.sendCommand('Profiler.start');
    await debug.sendCommand('Tracing.start', { categories: 'devtools.timeline,v8,disabled-by-default-v8.gc', transferMode: 'ReturnAsStream' });
  });
  await page.evaluate(() => {
    const measurements = { gaps: [] as { at: number; elapsedMs: number }[], interactions: [] as { at: number; event: string; label: string; elapsedMs: number }[] };
    Reflect.set(window, '__stabilityResponsiveness', measurements);
    let previous = performance.now();
    setInterval(() => {
      const now = performance.now();
      if (now - previous > 20 && measurements.gaps.length < 2000) measurements.gaps.push({ at: now, elapsedMs: now - previous });
      previous = now;
    }, 5);
    for (const type of ['click', 'input', 'keydown', 'pointerup']) document.addEventListener(type, event => {
      const start = performance.now(), target = event.target instanceof Element ? event.target.closest('button,input,[role="slider"],.timeline-cue') : null;
      if (!target) return;
      const label = target.getAttribute('aria-label') ?? target.textContent?.slice(0, 40) ?? target.tagName;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (measurements.interactions.length < 2000) measurements.interactions.push({ at: start, event: type, label, elapsedMs: performance.now() - start });
      }));
    }, true);
  });
  const record = async (name: string, start: number): Promise<void> => {
    phases.push({ name, elapsedMs: performance.now() - start, rendererAt: await page.evaluate(() => performance.now()), rows: await page.locator('.media-table-row').count(),
      metrics: await app.evaluate(({ app }) => app.getAppMetrics()) });
    await writeFile(info.outputPath('measurements.json'), JSON.stringify({ synthetic: true, physicalAcceptance: false, file, phases, errors }, null, 2));
  };
  try {
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, file);
    let start = performance.now();
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await expect(page.locator('[data-total-programs]')).toHaveAttribute('data-total-programs', '200');
    await expect(page.locator('[data-program-id]').first()).toBeVisible();
    expect(await page.locator('[data-program-id]').count()).toBeLessThan(80);
    await page.locator('[data-program-id]').first().focus();
    await page.keyboard.press('End');
    await expect(page.locator('[data-program-index="199"] > article')).toBeFocused();
    await expect(page.locator('[data-program-index="199"] > article')).toBeInViewport();
    await record('open', start);
    start = performance.now();
    await page.getByRole('textbox', { name: '搜索节目', exact: true }).fill('合成验收节目 200');
    await expect(page.locator('[data-program-id]')).toHaveCount(1);
    await record('program-search', start);
    await page.getByRole('textbox', { name: '搜索节目', exact: true }).fill('');
    start = performance.now();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '搜索素材', exact: true })).toBeVisible();
    await expect(page.locator('.asset-row').first()).toBeVisible();
    expect(await page.locator('.timeline-cue').count()).toBeLessThan(project.rundown[0]!.cues.length);
    await record('editor', start);
    await page.screenshot({ path: info.outputPath('editor.png') });
    await record('editor-screenshot', performance.now());
    const mounted = await page.locator('.asset-row').count();
    expect(await page.locator('.resource-library video').count()).toBe(0);
    await page.locator('.asset-row').first().focus();
    await page.keyboard.press('End');
    await expect(page.locator('[data-resource-index="1999"] > .asset-row')).toBeFocused();
    await expect(page.locator('[data-resource-index="1999"] > .asset-row')).toBeInViewport();
    const target = project.mediaAssets.at(-1)!;
    start = performance.now();
    await page.getByRole('textbox', { name: '搜索素材', exact: true }).fill(target.name);
    await expect(page.locator('.asset-row strong', { hasText: target.name }).first()).toBeVisible();
    await record('asset-search', start);
    await page.getByRole('textbox', { name: '搜索素材', exact: true }).fill('');
    await page.locator('.asset-row').first().focus();
    await page.keyboard.press('Home');
    await expect(page.locator('[data-resource-index="0"] > .asset-row')).toBeFocused();
    const switchCount = process.env.TBLINK_STABILITY_INTERACTIVE === '1' ? 30 : 3;
    for (let index = 0; index < switchCount; index++) {
      start = performance.now();
      await page.evaluate(() => Reflect.set(window, '__detachedPreviews', [...document.querySelectorAll<HTMLMediaElement>('.stage-media-layer video,.timeline-audio-engine')]));
      await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '节目单', exact: true }).click();
      await expect.poll(() => page.evaluate(() => (Reflect.get(window, '__detachedPreviews') as HTMLMediaElement[]).every(element => !element.isConnected && !element.hasAttribute('src') && element.paused))).toBe(true);
      await page.evaluate(() => Reflect.deleteProperty(window, '__detachedPreviews'));
      await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
      await expect(page.locator('.asset-row').first()).toBeVisible();
      await record(`switch-${index}`, start);
    }
    const cue = page.locator('.timeline-cue').first();
    await cue.scrollIntoViewIfNeeded();
    const before = await cue.getAttribute('style');
    const bounds = await cue.boundingBox();
    if (!bounds) throw new Error('高负载工程未显示画面 Cue');
    start = performance.now();
    await page.mouse.move(bounds.x + Math.min(3, bounds.width / 2), bounds.y + 8);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 12, bounds.y + 8, { steps: 6 });
    await page.mouse.up();
    await expect(cue).not.toHaveAttribute('style', before!);
    await record('cue-drag', start);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(cue).toHaveAttribute('style', before!);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await expect(cue).not.toHaveAttribute('style', before!);
    await page.keyboard.press('Control+s');
    await expect.poll(async () => parseLinkProject(JSON.parse(await readFile(file, 'utf8'))).rundown[0]!.cues[0]!.timecode).not.toEqual(project.rundown[0]!.cues[0]!.timecode);
    const saved = parseLinkProject(JSON.parse(await readFile(file, 'utf8')));
    expect(saved.rundown[199]).toEqual(project.rundown[199]);
    expect(saved.rundown[0]!.lighting).toEqual(project.rundown[0]!.lighting);
    expect(saved.mediaAssets).toEqual(project.mediaAssets);
    expect(errors).toEqual([]);
    expect(mounted).toBeLessThan(80);
  } finally {
    await record('final', performance.now());
    if (process.env.TBLINK_STABILITY_PROFILE === '1') {
      const profile = await app.evaluate(async ({ BrowserWindow }) => {
        const debug = BrowserWindow.getAllWindows()[0]!.webContents.debugger;
        const profile: unknown = await debug.sendCommand('Profiler.stop'); return profile;
      });
      await writeFile(info.outputPath('renderer-cpu.json'), JSON.stringify({ profileStartedAt, ...(profile as Record<string, unknown>) }));
      const trace = await app.evaluate(async ({ BrowserWindow }) => {
        const debug = BrowserWindow.getAllWindows()[0]!.webContents.debugger;
        const complete = new Promise<string>(resolve => {
          debug.on('message', (_event, method, params: { stream?: string }) => { if (method === 'Tracing.tracingComplete' && params.stream) resolve(params.stream); });
        });
        await debug.sendCommand('Tracing.end'); const handle = await complete;
        let content = '', eof = false;
        while (!eof) { const part = await debug.sendCommand('IO.read', { handle }) as { data: string; eof: boolean }; content += part.data; eof = part.eof; }
        await debug.sendCommand('IO.close', { handle }); debug.detach(); return content;
      });
      await writeFile(info.outputPath('renderer-trace.json'), trace);
    }
    const responsiveness = await page.evaluate(() => Reflect.get(window, '__stabilityResponsiveness') as {
      gaps: { at: number; elapsedMs: number }[]; interactions: { event: string; label: string; elapsedMs: number }[];
    });
    const sorted = responsiveness.interactions.map(value => value.elapsedMs).sort((a, b) => a - b);
    const p95Ms = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
    await writeFile(info.outputPath('responsiveness.json'), JSON.stringify({ ...responsiveness, p95Ms,
      maximumGapMs: Math.max(0, ...responsiveness.gaps.map(value => value.elapsedMs)), synthetic: true, physicalOutputAcceptance: false }, null, 2));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript('window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null })'));
    await app.close();
    expect.soft(p95Ms, '真实输入到绘制的 P95 超过 100ms').toBeLessThanOrEqual(100);
    expect.soft(Math.max(0, ...responsiveness.gaps.map(value => value.elapsedMs)), '界面线程存在超过 100ms 的阻塞').toBeLessThanOrEqual(100);
  }
});
