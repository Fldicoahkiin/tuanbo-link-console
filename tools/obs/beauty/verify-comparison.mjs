import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function equalPixels(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: byte length`);
  let changed = 0, maximum = 0;
  for (let i = 0; i < actual.length; i++) {
    const delta = Math.abs(actual[i] - expected[i]);
    if (delta) changed++;
    maximum = Math.max(maximum, delta);
  }
  assert.equal(changed, 0, `${label}: ${changed} changed channels, max difference ${maximum}`);
}

export async function verifyComparison({ root, call, screenshot, directory, PNG, packet }) {
  const sourceName = 'Comparison fixture', filterName = 'Comparison probe', target = { sourceName, filterName };
  const original = new PNG({ width: 320, height: 480 });
  for (let y = 0; y < original.height; y++) for (let x = 0; x < original.width; x++)
    original.data.set([70 + x % 100, 60 + y % 90, 100, 255], (y * original.width + x) * 4);
  const file = join(directory, 'comparison-input.png'); await writeFile(file, PNG.sync.write(original));
  await call('CreateInput', { sceneName: 'Beauty', inputName: sourceName, inputKind: 'image_source', inputSettings: { file }, sceneItemEnabled: true });
  const baseline = await screenshot('comparison-original', sourceName);
  await call('CreateSourceFilter', { ...target, filterKind: 'tblink_beauty_prototype', filterSettings: {
    fixture_json: JSON.stringify(packet), uniform_controls: true, smooth: 0, white: 0, slim: 0, eye: 0, exposure: .5 } });
  const before = await screenshot('comparison-output-before', sourceName);
  const settings = (await call('GetSourceFilter', target)).filterSettings;
  assert.match(settings.comparison_pipe, /^\\\\\.\\pipe\\tblink-beauty-compare-\d+-\d+$/);
  const require = createRequire(join(root, 'apps/desktop/package.json'));
  const { build } = require('esbuild');
  const modulePath = join(directory, 'comparison-client.mjs');
  await build({ entryPoints: [join(root, 'apps/desktop/src/main/link/beauty-comparison.ts')], outfile: modulePath, bundle: true, platform: 'node', format: 'esm', target: 'node22' });
  const { BeautyComparison } = await import(pathToFileURL(modulePath).href);
  const client = new BeautyComparison(() => Promise.resolve(settings.comparison_pipe));
  try {
    const first = await client.next(target), second = await client.next(target);
    await writeFile(join(directory, 'comparison-pair-original.png'), PNG.sync.write({ width: first.width, height: first.height, data: first.original }));
    await writeFile(join(directory, 'comparison-pair-processed.png'), PNG.sync.write({ width: first.width, height: first.height, data: first.processed }));
    assert(second.sequence > first.sequence); assert(second.timestampMs > first.timestampMs);
    assert.equal(first.width, baseline.width); assert.equal(first.height, baseline.height);
    equalPixels(first.original, baseline.data, 'Original comparison is not pre-beauty input');
    equalPixels(first.processed, before.data, 'Processed comparison differs from formal output');
    assert(!first.original.equals(first.processed), 'Comparison did not exercise an effect');
    const during = await screenshot('comparison-output-during', sourceName);
    equalPixels(during.data, before.data, 'Viewing comparison changed formal output');
    assert.deepEqual((await call('GetSourceFilter', target)).filterSettings, settings, 'Viewing comparison changed settings');
    const landscape = new PNG({ width: 640, height: 320 });
    for (let i = 0; i < landscape.data.length; i += 4) landscape.data.set([90, 110, 140, 255], i);
    const resizedFile = join(directory, 'comparison-resized-input.png'); await writeFile(resizedFile, PNG.sync.write(landscape));
    await call('SetSourceFilterSettings', { ...target, filterSettings: { exposure: 0 } });
    await call('SetInputSettings', { inputName: sourceName, inputSettings: { file: resizedFile } });
    await screenshot('comparison-resized', sourceName);
    const resized = await client.next(target);
    assert.equal(resized.width, 640); assert.equal(resized.height, 320);
    equalPixels(resized.original, resized.processed, 'Neutral comparison does not match after source resize');
    equalPixels(resized.original, landscape.data, 'Resized comparison contains old pixels');
    return { passed: true, width: first.width, height: first.height, originalExact: true, processedExact: true, outputUnchanged: true, resizeCoherent: true };
  } finally { client.close(); await call('RemoveInput', { inputName: sourceName }); }
}
