import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function verifyPerformance({ root, resources, directory, fixture, call, screenshot }) {
  const fpsArgument = process.argv.find(argument => argument.startsWith('--performance-fps='));
  const fps = fpsArgument ? Number(fpsArgument.slice('--performance-fps='.length)) : 60;
  assert(fps === 30 || fps === 60, 'Performance frame rate must be 30 or 60');
  const sourceName = 'Performance canvas', filterName = 'Performance beauty';
  await call('SetVideoSettings', { baseWidth: 1080, baseHeight: 1920, outputWidth: 1080, outputHeight: 1920, fpsNumerator: fps, fpsDenominator: 1 });
  await call('CreateScene', { sceneName: sourceName });
  await call('CreateScene', { sceneName: 'Performance output' });
  const photo = await call('CreateInput', { sceneName: sourceName, inputName: 'Performance photo', inputKind: 'image_source', inputSettings: { file: fixture }, sceneItemEnabled: true });
  await call('SetSceneItemTransform', { sceneName: sourceName, sceneItemId: photo.sceneItemId,
    sceneItemTransform: { boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: 1080, boundsHeight: 1920, positionX: 0, positionY: 0, alignment: 5 } });
  await call('CreateSceneItem', { sceneName: 'Performance output', sourceName, sceneItemEnabled: true });
  await call('CreateSourceFilter', { sourceName, filterName, filterKind: 'tblink_beauty_prototype', filterSettings: {
    live_mode: true, uniform_controls: true, smooth: .5, white: .2, slim: .25, eye: .2, texture: .3,
    lipstick: .4, blush: .2, blemish: .4, darkCircles: .3, nasolabial: .3
  } });
  await call('SetCurrentProgramScene', { sceneName: 'Performance output' });
  const image = await screenshot('performance-full-frame', sourceName);
  assert.equal(image.width, 1080); assert.equal(image.height, 1920);
  const { filterSettings } = await call('GetSourceFilter', { sourceName, filterName });
  const channel = filterSettings.transport_name;
  assert.match(channel, /^Local\\tblink-beauty-\d+-\d+$/);
  const require = createRequire(join(root, 'apps/desktop/package.json'));
  const modulePath = join(directory, 'performance-runtime.mjs');
  await require('esbuild').build({ entryPoints: [join(root, 'apps/desktop/src/main/link/beauty-runtime.ts')], outfile: modulePath, bundle: true, platform: 'node', format: 'esm', target: 'node22' });
  const { BeautyRuntime } = await import(pathToFileURL(modulePath).href);
  const errors = [], samples = [];
  const runtime = new BeautyRuntime(resources, join(directory, 'performance-worker'), {
    prepare: async selected => { assert.equal(selected, sourceName); return { sourceName, filterName, channel }; }
  }, message => errors.push(message));
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const report = { passed: false, video: await call('GetVideoSettings'), samples, errors,
    scope: `60-second 1080x1920 ${fps}fps OBS preview with two static faces; no encoding, streaming, recording or real group motion.` };
  try {
    await runtime.start(sourceName);
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && runtime.status().phase !== 'tracking' && runtime.status().phase !== 'error') await sleep(100);
    assert.equal(runtime.status().phase, 'tracking', runtime.status().message);
    await sleep(5000);
    const initial = await call('GetStats'), started = Date.now();
    for (let index = 0; index < 60; index++) {
      await sleep(1000);
      samples.push({ elapsedMs: Date.now() - started, stats: await call('GetStats'), beauty: runtime.status() });
    }
    const last = samples.at(-1).stats;
    const skipped = last.renderSkippedFrames - initial.renderSkippedFrames, total = last.renderTotalFrames - initial.renderTotalFrames;
    const renderTimes = samples.map(sample => sample.stats.averageFrameRenderTime).sort((a, b) => a - b);
    report.summary = { totalFrames: total, skippedFrames: skipped, skippedRatio: skipped / total,
      renderTimeP95Ms: renderTimes[Math.ceil(renderTimes.length * .95) - 1],
      trackingRatio: samples.filter(sample => sample.beauty.phase === 'tracking' && sample.beauty.faces >= 2).length / samples.length,
      obsMemoryStartMB: initial.memoryUsage, obsMemoryEndMB: last.memoryUsage };
    assert(total >= fps * 55, `Rendered too few frames: ${total}`);
    assert(report.summary.skippedRatio < .01, `Render skip ratio: ${report.summary.skippedRatio}`);
    assert(report.summary.renderTimeP95Ms < 1000 / fps, `Render time exceeds frame budget: ${report.summary.renderTimeP95Ms}`);
    assert(report.summary.trackingRatio >= .95, `Two-face tracking ratio: ${report.summary.trackingRatio}`);
    assert.deepEqual(errors, []);
    report.passed = true;
    return report;
  } catch (error) {
    report.error = String(error);
    throw error;
  } finally {
    try { await runtime.stop().catch(error => { report.passed = false; report.stopError = String(error); throw error; }); }
    finally { await writeFile(join(directory, 'performance.json'), JSON.stringify(report, null, 2)); }
  }
}
