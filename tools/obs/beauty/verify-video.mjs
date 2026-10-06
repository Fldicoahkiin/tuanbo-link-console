import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function verifyVideo({ root, resources, directory, video, call, PNG }) {
  const require = createRequire(join(root, 'apps/desktop/package.json'));
  const clientRoot = join(directory, 'video-client');
  await require('esbuild').build({ entryPoints: [join(root, 'apps/desktop/src/main/link/beauty-runtime.ts'), join(root, 'apps/desktop/src/main/link/beauty-comparison.ts')],
    outdir: clientRoot, outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', target: 'node22' });
  const { BeautyRuntime } = await import(pathToFileURL(join(clientRoot, 'beauty-runtime.mjs')).href);
  const { BeautyComparison } = await import(pathToFileURL(join(clientRoot, 'beauty-comparison.mjs')).href);
  const sha256 = createHash('sha256').update(await readFile(video)).digest('hex');
  const assets = JSON.parse(await readFile(join(root, 'tools/obs/beauty/motion-assets.json'), 'utf8'));
  const attribution = assets.videos.find(asset => asset.sha256 === sha256) ?? null;
  const sourceName = 'Real motion fixture', filterName = 'Real motion beauty', target = { sourceName, filterName };
  await call('CreateInput', { sceneName: 'Beauty', inputName: sourceName, inputKind: 'ffmpeg_source',
    inputSettings: { local_file: video, is_local_file: true, looping: false, close_when_inactive: false }, sceneItemEnabled: true });
  await call('SetInputMute', { inputName: sourceName, inputMuted: true });
  await call('SetCurrentProgramScene', { sceneName: 'Beauty' });
  await call('CreateSourceFilter', { ...target, filterKind: 'tblink_beauty_prototype', filterSettings: {
    live_mode: true, uniform_controls: true, smooth: .4, white: .15, slim: .2, eye: .15, bodySlim: .25, waist: .2, legSlim: .15 } });
  const settings = (await call('GetSourceFilter', target)).filterSettings;
  const errors = [], samples = [];
  const runtime = new BeautyRuntime(resources, join(directory, 'video-worker'), {
    prepare: async selected => { assert.equal(selected, sourceName); return { ...target, channel: settings.transport_name }; }
  }, message => errors.push(message));
  const comparison = new BeautyComparison(() => Promise.resolve(settings.comparison_pipe));
  const report = { passed: false, qualityAccepted: false, video, sha256, attribution, samples, errors,
    scope: 'Real video through OBS and production worker, same-frame before/after samples; not ground-truth detection accuracy or aesthetic acceptance.' };
  let failure;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    await runtime.start(sourceName);
    const readyBy = Date.now() + 20000;
    while (Date.now() < readyBy && runtime.status().phase !== 'tracking' && runtime.status().phase !== 'error') await sleep(100);
    assert.equal(runtime.status().phase, 'tracking', runtime.status().message);
    await call('TriggerMediaInputAction', { inputName: sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' });
    const started = Date.now();
    while (Date.now() - started < 30000) {
      const pair = await comparison.next(target);
      let changed = 0, delta = 0;
      for (let index = 0; index < pair.original.length; index++) {
        const amount = Math.abs(pair.original[index] - pair.processed[index]);
        if (amount) changed++;
        delta += amount;
      }
      const sample = { elapsedMs: Date.now() - started, sequence: pair.sequence, width: pair.width, height: pair.height,
        rawHash: createHash('sha256').update(pair.original).digest('hex'), changedChannels: changed, meanChannelDifference: delta / pair.original.length,
        beauty: runtime.status(), media: await call('GetMediaInputStatus', { inputName: sourceName }) };
      samples.push(sample);
      if (samples.length % 10 === 1) {
        for (const [kind, data] of [['original', pair.original], ['processed', pair.processed]])
          await writeFile(join(directory, `video-${samples.length}-${kind}.png`), PNG.sync.write({ width: pair.width, height: pair.height, data }));
      }
      assert.notEqual(sample.beauty.phase, 'error', sample.beauty.message);
      await sleep(300);
    }
    report.summary = { samples: samples.length, movingFrames: new Set(samples.map(sample => sample.rawHash)).size,
      changedSamples: samples.filter(sample => sample.changedChannels > 0).length,
      trackingSamples: samples.filter(sample => sample.beauty.phase === 'tracking').length,
      twoFaceSamples: samples.filter(sample => sample.beauty.faces >= 2).length };
    assert(samples.length >= 40, 'Insufficient real video samples');
    assert(report.summary.movingFrames >= 30, 'Video did not continue advancing');
    assert(report.summary.changedSamples >= 10, 'Effects did not reach real video pixels');
    assert.deepEqual(errors, []);
    report.passed = true;
  } catch (error) { failure = error; report.error = String(error); }
  finally {
    comparison.close();
    try { await runtime.stop(); await call('RemoveInput', { inputName: sourceName }); }
    catch (error) { report.passed = false; report.cleanupError = String(error); failure = new AggregateError(failure ? [failure, error] : [error], 'Video verification cleanup failed'); }
    await writeFile(join(directory, 'video.json'), JSON.stringify(report, null, 2));
  }
  if (failure) throw failure;
  return report;
}
