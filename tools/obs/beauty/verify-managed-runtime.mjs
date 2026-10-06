import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, readdir, writeFile } from 'node:fs/promises';

export async function verifyManagedRuntime({ root, work, directory, call }) {
  const require = createRequire(join(root, 'apps/desktop/package.json'));
  const { build } = require('esbuild');
  const modulePath = join(directory, 'managed-runtime.mjs');
  await build({ entryPoints: [join(root, 'apps/desktop/src/main/link/beauty-runtime.ts')], outfile: modulePath,
    bundle: true, platform: 'node', format: 'esm', target: 'node22' });
  const { BeautyRuntime } = await import(pathToFileURL(modulePath).href);
  const sourceName = 'Motion fixture', filterName = 'Beauty probe';
  const filter = await call('GetSourceFilter', { sourceName, filterName });
  const channel = filter.filterSettings.transport_name;
  assert.match(channel, /^Local\\tblink-beauty-\d+-\d+$/);
  const messages = [], errors = [], observations = [];
  const runtime = new BeautyRuntime(work, join(directory, 'managed-runtime-reports'), {
    prepare: async selected => { assert.equal(selected, sourceName); return { sourceName, filterName, channel }; }
  }, message => errors.push(message));
  runtime.subscribe(state => messages.push(state));
  try {
    await runtime.start(sourceName);
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && runtime.status().phase !== 'tracking' && runtime.status().phase !== 'error')
      await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(runtime.status().phase, 'tracking', runtime.status().message);
    for (let index = 0; index < 24; index++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      observations.push(runtime.status());
    }
    assert.equal(runtime.status().phase, 'tracking', runtime.status().message);
    assert(messages.filter(message => message.phase === 'tracking').length >= 2);
    assert.deepEqual(errors, []);
  } finally {
    const finalState = runtime.status();
    try { await runtime.stop(); }
    finally { await writeFile(join(directory, 'managed-observations.json'), JSON.stringify({
      scope: 'Raw manager observations, retained on both success and failure; not an acceptance result',
      messages, observations, finalState, errors
    }, null, 2)); }
  }
  assert.equal(runtime.status().phase, 'idle');
  assert.deepEqual(errors, []);
  const reports = join(directory, 'managed-runtime-reports');
  const files = (await readdir(reports)).filter(file => file.endsWith('.json'));
  assert.equal(files.length, 1, 'Expected one managed worker report');
  const trace = JSON.parse(await readFile(join(reports, files[0]), 'utf8'));
  assert.equal(trace.proposal_backend, 'directml', 'Default manager did not use GPU proposals');
  assert.equal(trace.semantic_backend, 'directml', 'Default manager did not use GPU segmentation');
  assert.equal(trace.semantic_face_protection, true, 'Default manager omitted semantic protection');
  assert.equal(trace.profile_skin, true, 'Default manager omitted protected profile skin');
  return { passed: true, messages, observations, proposalBackend: trace.proposal_backend, semanticBackend: trace.semantic_backend,
    profileSkin: trace.profile_skin,
    scope: 'Production manager with real frozen worker and OBS transport; fixture source preparation supplied by verifier' };
}
