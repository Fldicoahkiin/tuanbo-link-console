import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { cpus, freemem } from 'node:os';
import { launchPackagedDesktop } from './verify-packaged-desktop.mjs';

export async function verifyDesktop({ root, directory, fixture, faces, executable, desktopExecutable, port, password, call, screenshot, difference }) {
  const require = createRequire(join(root, 'apps/desktop/package.json'));
  const { _electron: electron, chromium, expect } = require('@playwright/test');
  const sourceName = 'Desktop fixture', filterName = '团播·人像美颜';
  await call('CreateInput', { sceneName: 'Beauty', inputName: sourceName, inputKind: 'image_source', inputSettings: { file: fixture }, sceneItemEnabled: true });
  await call('SetCurrentProgramScene', { sceneName: 'Beauty' });
  const baseline = await screenshot('desktop-original', sourceName);
  const app = desktopExecutable ? await launchPackagedDesktop({ executable: desktopExecutable, directory, chromium }) : await electron.launch({ cwd: join(root, 'apps/desktop'), env: { ...process.env, TBLINK_LOCAL_TEST_ACCESS: '1', ProgramData: join(directory, 'desktop-system-data') },
    args: [`--user-data-dir=${join(directory, 'desktop-profile')}`, join(root, 'apps/desktop/out/main/index.cjs')] });
  const report = { passed: false, errors: [], executable: desktopExecutable ?? null,
    scope: `Real ${desktopExecutable ? 'packaged' : 'development'} Electron UI, preload, main, OBS and worker; isolated profile, no beauty IPC replacements.` };
  let page, operationError;
  const cpuTotals = () => cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle,
    total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 });
  let previousCpu = cpuTotals(), previousAt = performance.now();
  const sampleHost = () => {
    const current = cpuTotals(), now = performance.now(), elapsed = current.total - previousCpu.total;
    const sample = { at: new Date().toISOString(), intervalMs: now - previousAt,
      cpuBusyPercent: elapsed > 0 ? 100 * (1 - (current.idle - previousCpu.idle) / elapsed) : null,
      freeMemoryBytes: freemem() };
    previousCpu = current; previousAt = now;
    return sample;
  };
  try {
    page = await app.firstWindow();
    page.on('pageerror', error => report.errors.push(String(error)));
    report.startupScreen = await Promise.race([
      page.getByRole('button', { name: '新建工程', exact: true }).waitFor().then(() => 'workspace'),
      page.getByRole('heading', { name: '激活团播联动台', exact: true }).waitFor().then(() => 'activation')
    ]);
    assert.equal(report.startupScreen, 'workspace', 'Packaged UI requires a valid test license; beauty controls were not reached');
    if (desktopExecutable) await page.evaluate(() => globalThis.window.tbLink.controlWindow('toggleMaximize'));
    else await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(1440, 960); window.show(); window.focus(); });
    const external = { executablePath: executable, workingDirectory: dirname(executable), arguments: [], startupTimeoutMs: 10000, shutdownTimeoutMs: 5000 };
    const profile = { schemaVersion: 1, profileId: 'beauty-desktop-test', name: '美颜真实桌面验收', updatedAt: new Date().toISOString(),
      obs: { ...external, autoConnectOnLaunch: false, webSocketUrl: `ws://127.0.0.1:${port}`, credentialId: 'isolated-obs' },
      p1: { ...external, mtcInputPortProfileId: 'in', controlOutputPortProfileId: 'out', expectedFrameRate: '25' },
      midiPortProfiles: [{ id: 'in', direction: 'input', portName: '' }, { id: 'out', direction: 'output', portName: '' }], acceptedVersions: { obs: '32.0.4', p1: 'not-used' } };
    await page.evaluate(async payload => {
      await globalThis.window.tbLink.saveIntegrationProfile(payload);
      await globalThis.window.tbLink.connectObs();
    }, { profile, obsPassword: password });
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '人像美颜', exact: true }).click();
    await page.getByText('画面来源与输出设置', { exact: true }).click();
    await expect(page.getByLabel('美颜画面来源').locator('option', { hasText: sourceName })).toHaveCount(1);
    await page.getByLabel('美颜画面来源').selectOption(sourceName);
    await page.getByRole('button', { name: '启动美颜', exact: true }).click();
    await expect.poll(async () => await page.evaluate(() => globalThis.window.tbLink.readBeautyRuntime()), { timeout: 25000 }).toMatchObject({ phase: 'tracking', faces: 2 });
    await page.getByRole('slider', { name: '磨皮', exact: true }).fill('65');
    await page.getByRole('slider', { name: '美白', exact: true }).fill('40');
    await expect.poll(async () => (await call('GetSourceFilter', { sourceName, filterName })).filterSettings.white).toBe(.4);
    report.filterAtCapture = (await call('GetSourceFilter', { sourceName, filterName })).filterSettings;
    report.runtimeBeforeCapture = await page.evaluate(() => globalThis.window.tbLink.readBeautyRuntime());
    const processed = await screenshot('desktop-processed', sourceName);
    report.runtimeAfterCapture = await page.evaluate(() => globalThis.window.tbLink.readBeautyRuntime());
    report.pixelDifference = difference(baseline, processed);
    assert(report.pixelDifference > .1, 'UI parameters reached OBS but did not change pixels');
    await page.getByText('画面来源与输出设置', { exact: true }).click();
    await page.getByRole('button', { name: '前后对比', exact: true }).click();
    await expect(page.getByRole('slider', { name: '美颜对比分割线' })).toBeVisible({ timeout: 15000 });
    report.comparison = await page.evaluate(() => {
      const canvases = ['美颜前画面', '美颜后画面'].map(label => globalThis.document.querySelector(`canvas[aria-label="${label}"]`));
      const pixels = canvases.map(canvas => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data);
      let changed = 0;
      for (let index = 0; index < pixels[0].length; index++) if (pixels[0][index] !== pixels[1][index]) changed++;
      return { width: canvases[0].width, height: canvases[0].height, changedChannels: changed };
    });
    assert(report.comparison.changedChannels > 0, 'Live comparison canvases are identical');
    await page.screenshot({ path: join(directory, 'desktop-real-comparison.png') });
    await page.getByRole('button', { name: '前后对比', exact: true }).click();
    await page.getByRole('button', { name: '原始参数', exact: true }).click();
    await expect.poll(async () => (await call('GetSourceFilter', { sourceName, filterName })).filterSettings).toMatchObject({ smooth: 0, white: 0 });
    report.resetDifference = difference(baseline, await screenshot('desktop-neutral', sourceName));
    assert.equal(report.resetDifference, 0, 'UI reset did not restore original pixels');
    report.controls = [];
    report.controlFailures = [];
    assert(faces.length === 2, 'Desktop fixture must supply both reference face regions');
    const faceDifferences = image => faces.map(face => {
      let total = 0, pixels = 0, changedPixels = 0;
      for (let y = 0; y < baseline.height; y++) for (let x = 0; x < baseline.width; x++) {
        if (((x / baseline.width - face.cx) / face.rx) ** 2 + ((y / baseline.height - face.cy) / face.ry) ** 2 > 1) continue;
        const offset = (y * baseline.width + x) * 4;
        let changed = false;
        for (let channel = 0; channel < 3; channel++) {
          const delta = Math.abs(image.data[offset + channel] - baseline.data[offset + channel]);
          total += delta; changed ||= delta > 0;
        }
        pixels++; changedPixels += Number(changed);
      }
      assert(pixels > 0, 'Empty face reference region');
      return { meanRgbDifference: total / (pixels * 3), changedPixels, pixels };
    });
    const controlCases = [
      ['美型', '瘦脸', 'slim', 50], ['美型', '大眼', 'eye', 50],
      ['美型', '下颌收窄', 'jaw', 50], ['美型', '颧骨收窄', 'cheek', 50],
      ['美型', '下巴', 'chin', 50], ['美型', '下巴', 'chin', -50],
      ['美型', '额头', 'forehead', 50], ['美型', '眼距', 'eyeDistance', -50],
      ['美型', '瘦鼻', 'nose', 50], ['美型', '鼻长', 'noseLength', -50],
      ['美型', '嘴型大小', 'mouth', -50], ['美妆', '口红', 'lipstick', 50],
      ['美妆', '腮红', 'blush', 50], ['美妆', '眉妆', 'brow', 50],
      ['美妆', '眼线', 'eyeliner', 50], ['调色', '对比度', 'contrast', -50],
      ['调色', '饱和度', 'saturation', -50], ['调色', '色温', 'temperature', -50],
      ['调色', '锐化', 'sharpen', 50], ['调色', '曝光', 'exposure', 50]
    ];
    for (const [category, label, key, value] of controlCases) {
      const captureKey = `${key}-${value < 0 ? 'negative' : 'positive'}`;
      await page.getByRole('navigation', { name: '美颜分类' }).getByRole('button', { name: category, exact: true }).click();
      await page.getByRole('slider', { name: label, exact: true }).fill(String(value));
      await expect.poll(async () => (await call('GetSourceFilter', { sourceName, filterName })).filterSettings[key]).toBe(value / 100);
      const pixelDifferences = [], perFaceDifferences = [], observations = [];
      sampleHost();
      for (let sample = 0; sample < 5; sample++) {
        const captureStartedAt = new Date().toISOString();
        const captured = await screenshot(`desktop-${captureKey}-${sample}`, sourceName);
        pixelDifferences.push(difference(baseline, captured));
        perFaceDifferences.push(faceDifferences(captured));
        observations.push({ captureStartedAt, host: sampleHost() });
      }
      const changed = pixelDifferences[0];
      const runtime = await page.evaluate(() => globalThis.window.tbLink.readBeautyRuntime());
      const criterion = category === '调色' ? 'full-frame RGB mean > 0.01' : 'each reference face RGB mean > 0.01';
      report.controls.push({ key, value: value / 100, criterion, pixelDifference: changed, pixelDifferences, perFaceDifferences, observations, runtime });
      const missingEffect = category === '调色' ? pixelDifferences.some(delta => !(delta > .01))
        : perFaceDifferences.some(regions => regions.some(region => !(region.meanRgbDifference > .01)));
      if (missingEffect) report.controlFailures.push(`${label} UI slider did not continuously affect all required sampled regions`);
      await page.getByRole('button', { name: `重置${label}`, exact: true }).click();
      await expect.poll(async () => (await call('GetSourceFilter', { sourceName, filterName })).filterSettings[key]).toBe(0);
      const resetDifference = difference(baseline, await screenshot(`desktop-${captureKey}-reset`, sourceName));
      report.controls.at(-1).resetDifference = resetDifference;
      if (resetDifference !== 0) report.controlFailures.push(`${label} UI reset did not restore original pixels`);
    }
    // A real OBS image source changes dimensions. Padding is a layout fixture,
    // not evidence of portrait capture or aesthetic quality.
    const { PNG } = require(join(root, 'node_modules/.pnpm/pngjs@5.0.0/node_modules/pngjs'));
    const portrait = new PNG({ width: baseline.width, height: Math.ceil(baseline.width * 16 / 9) });
    for (let offset = 0; offset < portrait.data.length; offset += 4) {
      portrait.data[offset] = 24; portrait.data[offset + 1] = 27; portrait.data[offset + 2] = 32; portrait.data[offset + 3] = 255;
    }
    const top = Math.floor((portrait.height - baseline.height) / 2);
    baseline.data.copy(portrait.data, top * baseline.width * 4);
    const portraitFile = join(directory, 'desktop-portrait-fixture.png');
    await writeFile(portraitFile, PNG.sync.write(portrait));
    await call('SetInputSettings', { inputName: sourceName, inputSettings: { file: portraitFile }, overlay: true });
    await page.getByRole('button', { name: '前后对比', exact: true }).click();
    await expect.poll(async () => page.locator('canvas[aria-label="美颜后画面"]').evaluate(canvas => canvas.width / canvas.height), { timeout: 15000 }).toBeLessThan(.57);
    await expect.poll(async () => page.locator('.beauty-comparison .obs-live-canvas').evaluate(element => {
      const bounds = element.getBoundingClientRect(); return bounds.width / bounds.height;
    })).toBeLessThan(.57);
    await expect(page.locator('.beauty-header')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '保存参数', exact: true })).toBeInViewport();
    await expect(page.getByRole('slider', { name: '曝光', exact: true })).toBeInViewport();
    const measurePortrait = () => page.evaluate(() => {
      const bounds = selector => {
        const { x, y, width, height } = globalThis.document.querySelector(selector).getBoundingClientRect();
        return { x, y, width, height };
      };
      return { frame: bounds('.beauty-comparison .obs-live-canvas'), viewer: bounds('.beauty-preview-viewer'),
        workspace: bounds('.beauty-workspace'), editor: bounds('.beauty-editor'),
        viewport: { width: globalThis.innerWidth, height: globalThis.innerHeight } };
    });
    report.portraitLayout = await measurePortrait();
    assert(report.portraitLayout.frame.height > report.portraitLayout.viewer.height * .9, 'Portrait preview wastes available height');
    assert(Math.abs(report.portraitLayout.frame.width / report.portraitLayout.frame.height - 9 / 16) < .005, 'Portrait preview is distorted');
    assert(report.portraitLayout.editor.x >= report.portraitLayout.frame.x + report.portraitLayout.frame.width, 'Controls overlap portrait');
    await page.screenshot({ path: join(directory, 'desktop-real-portrait.png') });
    await page.getByRole('button', { name: '放大预览', exact: true }).click();
    const zoomed = await measurePortrait();
    assert(Math.abs(zoomed.frame.height / report.portraitLayout.frame.height - 2) < .05, 'Preview zoom did not respond');
    await page.getByRole('button', { name: '适应画面', exact: true }).click();
    const fitted = await measurePortrait();
    assert(Math.abs(fitted.frame.height - report.portraitLayout.frame.height) < 1, 'Fit did not restore portrait preview');
    await page.getByRole('button', { name: '前后对比', exact: true }).click();
    await page.getByText('画面来源与输出设置', { exact: true }).click();
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await expect.poll(async () => await page.evaluate(() => globalThis.window.tbLink.readBeautyRuntime())).toMatchObject({ phase: 'idle' });
    assert.deepEqual(report.controlFailures, [], 'One or more slider pixel checks failed');
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } catch (error) { operationError = error; report.error = String(error); if (page) await page.screenshot({ path: join(directory, 'desktop-failure.png') }); }
  finally {
    try {
      try { if (page) await page.evaluate(() => globalThis.window.tbLink.stopBeautyRuntime()); }
      finally { await app.close(); }
    } catch (error) { report.passed = false; report.cleanupError = String(error); operationError = new AggregateError(operationError ? [operationError, error] : [error], 'Desktop verification cleanup failed'); }
    finally { await writeFile(join(directory, 'desktop.json'), JSON.stringify(report, null, 2)); }
  }
  if (operationError) throw operationError;
  return report;
}
