import { test, expect, _electron as electron } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { createHash } from 'node:crypto';

test('预览最小化释放帧连接，恢复重建，低功率停止拉帧并记录资源', async ({}, info) => {
  const project = createEmptyLinkProject('资源占用验收');
  project.rundown.push({ id: 'song', title: '预览测试', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [] });
  const file = info.outputPath('resource.tblink');
  await writeFile(file, JSON.stringify(project));
  const application = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')] });
  const page = await application.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await application.evaluate(({ ipcMain, dialog }, path) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] });
      const status = { status: 'connected', obsVersion: '32.2.2', webSocketVersion: '5.6.3', error: null };
      ipcMain.removeHandler('link:obs-snapshot'); ipcMain.handle('link:obs-snapshot', () => status);
      ipcMain.removeHandler('link:obs-live-scene');
      ipcMain.handle('link:obs-live-scene', () => ({ sceneName: '隔离预览', width: 1920, height: 1080, items: [] }));
      const counts = { frames: 0, closed: 0 }; Reflect.set(globalThis, '__resourceCounts', counts);
      // Offset deliberately exercises a non-zero byteOffset without a pixel copy.
      const bytes = new Uint8Array(960 * 540 * 4 + 32).subarray(32); bytes.fill(255);
      ipcMain.removeHandler('link:obs-live-frame');
      ipcMain.handle('link:obs-live-frame', async () => {
        await new Promise(resolve => setTimeout(resolve, 33));
        counts.frames++;
        return { width: 960, height: 540, sequence: counts.frames, timestampNs: '0', rgba: bytes };
      });
      ipcMain.removeHandler('link:obs-live-close'); ipcMain.handle('link:obs-live-close', () => { counts.closed++; });
    }, file);
    await page.reload();
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
    const counts = () => application.evaluate(() => Reflect.get(globalThis, '__resourceCounts') as { frames: number; closed: number });
    const metrics = (phase: string) => application.evaluate(({ app }, phase) => ({ phase, at: Date.now(), processes: app.getAppMetrics().map(({ type, cpu, memory }) => ({ type, cpu, memory })) }), phase);
    await expect.poll(async () => (await counts()).frames).toBeGreaterThan(10);
    expect(await page.locator('canvas[aria-label="OBS 实时画面"]').evaluate(canvas => [...(canvas as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 1, 1).data])).toEqual([255, 255, 255, 255]);
    const measurements = [await metrics('preview')];
    for (let cycle = 0; cycle < 3; cycle++) {
      const before = await counts();
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.minimize());
      await expect.poll(async () => (await counts()).closed).toBeGreaterThan(before.closed);
      await page.waitForTimeout(100);
      const hidden = await counts();
      await page.waitForTimeout(500);
      expect((await counts()).frames).toBe(hidden.frames);
      measurements.push(await metrics(`minimized-${cycle}`));
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.restore());
      await expect.poll(async () => (await counts()).frames).toBeGreaterThan(hidden.frames + 5);
    }
    await application.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('link:obs-live-frame');
      ipcMain.handle('link:obs-live-frame', () => {
        const counts = Reflect.get(globalThis, '__resourceCounts') as { frames: number };
        counts.frames++; throw new Error('测试预览连接失败');
      });
    });
    await expect(page.locator('.stage-error')).toContainText('测试预览连接失败');
    const failed = await counts();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.minimize());
    await page.waitForTimeout(100);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.restore());
    await page.waitForTimeout(300);
    expect((await counts()).frames).toBe(failed.frames);
    await page.getByRole('button', { name: '重新连接预览', exact: true }).click();
    await expect.poll(async () => (await counts()).frames).toBe(failed.frames + 1);
    await page.evaluate(() => localStorage.setItem('tblink.low-power', 'true'));
    await page.reload();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
    await expect(page.locator('.reference-stage')).toHaveCount(0);
    const lowPower = await counts(); await page.waitForTimeout(1000);
    expect((await counts()).frames).toBe(lowPower.frames);
    measurements.push(await metrics('low-power'));
    await writeFile(info.outputPath('resource-metrics.json'), JSON.stringify({ syntheticObs: true, measurements, errors }, null, 2));
    expect(errors).toEqual([]);
  } finally { await page.evaluate(() => window.tbLink.setDocumentDirty(false)); await application.close(); }
});

test('五百音频片段仅为视口内片段创建波形', async ({}, info) => {
  const wav = Buffer.alloc(44 + 16000, 128);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34);
  wav.write('data', 36); wav.writeUInt32LE(16000, 40);
  await writeFile(info.outputPath('source.wav'), wav);
  const source = { assetId: 'audio', relativePath: 'source.wav', durationMs: 2000, sha256: createHash('sha256').update(wav).digest('hex') };
  const segments = Array.from({ length: 500 }, (_, i) => ({ id: `clip-${i}`, startMs: i * 2000, durationMs: 2000, sourceOffsetMs: 0 }));
  const project = parseLinkProject({ ...createEmptyLinkProject('波形视口验收'), rundown: [{ id: 'song', title: '片段测试', cues: [],
    referenceAudio: { ...source, durationMs: 1000000, timeline: { source, segments } } }] });
  const file = info.outputPath('waveform.tblink'); await writeFile(file, JSON.stringify(project));
  const application = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), process.env.TBLINK_RESOURCE_BUILD_DIR ?? 'out', 'main/index.cjs')] });
  const page = await application.firstWindow();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await application.evaluate(({ ipcMain, dialog }, file) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [file] });
      ipcMain.removeHandler('link:generate-waveform');
      ipcMain.handle('link:generate-waveform', () => Array.from({ length: 4800 }, (_, i) => (i % 7 + 1) / 8));
    }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
    await expect(page.locator('.audio-timeline-segment')).toHaveCount(500);
    const waves = page.locator('[data-waveform-engine="wavesurfer"]');
    await expect.poll(() => waves.count()).toBeGreaterThan(0);
    const initial = await waves.count();
    await page.locator('.timeline-viewport').evaluate(element => { element.scrollLeft = 16000; });
    await expect.poll(() => waves.count()).toBeGreaterThan(0);
    const scrolled = await waves.count();
    const processes = await application.evaluate(({ app }) => app.getAppMetrics());
    await writeFile(info.outputPath('waveform-resource-metrics.json'), JSON.stringify({ initial, scrolled, processes, errors }, null, 2));
    expect(initial).toBeLessThan(30); expect(scrolled).toBeLessThan(30);
    expect(errors).toEqual([]);
  } finally { await page.evaluate(() => window.tbLink.setDocumentDirty(false)); await application.close(); }
});
