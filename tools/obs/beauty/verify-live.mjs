import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function verifyLive({ work, root, directory, call, screenshot, difference, baseline, moving = false, inputName = 'Fixture' }) {
  const filter = { sourceName: inputName, filterName: 'Beauty probe' };
  await call('SetSourceFilterSettings', { ...filter, filterSettings: { live_mode: true, exposure: .2, contrast: .1, saturation: -.15, temperature: .2, sharpen: .2,
    nose: .3, noseLength: -.2, mouth: .2, eyeDistance: .2, lipstick: .5, brow: .3, eyeliner: .3, blush: .3,
    jaw: .3, cheek: .3, chin: -.2, forehead: .2, darkCircles: .5, nasolabial: .5 } });
  const settings = await call('GetSourceFilter', filter);
  const channel = settings.filterSettings.transport_name;
  assert.match(channel, /^Local\\tblink-beauty-\d+-\d+$/);
  const output = join(directory, moving ? 'motion-worker.json' : 'worker.json'), stop = join(directory, moving ? 'stop-motion-worker' : 'stop-worker');
  const frozen = process.argv.includes('--frozen');
  const managed = process.argv.includes('--managed-test');
  const child = spawn(join(work, frozen ? 'runtime/tblink-beauty-worker/tblink-beauty-worker.exe' : 'python/Scripts/python.exe'), [...(frozen ? [] : [join(root, 'tools/obs/beauty/worker.py')]),
    '--channel', channel, '--model', join(work, 'face_landmarker.task'), '--seconds', '8', '--report', output, '--stop-file', stop,
    ...(managed ? ['--managed'] : [])], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '', stdout = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
  let timeout, ownerStop;
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        child.stdout.on('data', () => { if (stdout.includes('"ready": true')) resolve(); });
        child.once('error', reject);
        child.once('exit', () => reject(new Error(`Worker ended before detection: ${stderr}`)));
      }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`Live inference not ready: ${stderr}`)), 12000); })
    ]);
    clearTimeout(timeout);
    if (managed) ownerStop = setTimeout(() => child.stdin.end(), 8000);
    const processed = await screenshot(moving ? 'motion-live' : 'live');
    const changed = moving ? null : difference(baseline, processed);
    if (!moving) assert(changed > 0.1, `Live analysis did not affect video: ${changed}`);
    assert.equal(await exit, 0, `Worker failed: ${stderr}`);
    const trace = JSON.parse(await readFile(output, 'utf8'));
    assert(trace.samples.length >= 20, 'Insufficient live frames');
    assert(trace.samples.some(sample => sample.faces >= 2 && sample.accepted_sequence > 0), 'Two-face results never accepted');
    const hashes = new Set(trace.samples.map(sample => sample.raw_sha256));
    let movement = 0;
    if (moving) {
      assert(hashes.size > 10, 'Moving input frames did not change');
      const lefts = trace.samples.filter(s => s.centers.length >= 2).map(s => Math.min(...s.centers.map(c => c[0])));
      movement = Math.max(...lefts) - Math.min(...lefts);
      assert(movement > 0.08, `Face coordinates did not follow motion: ${movement}`);
    } else assert.equal(hashes.size, 1, 'Static input changed in analysis channel: possible filtered-image feedback');
    // screenshot waits 200 ms itself; add 200 so the 250 ms expiry has elapsed.
    await new Promise(resolve => setTimeout(resolve, 200));
    const expired = moving ? null : difference(baseline, await screenshot('live-expired'));
    if (!moving) assert.equal(expired, 0, 'Old face warp survived worker shutdown');
    const timings = trace.samples.map(sample => sample.inference_ms).sort((a, b) => a - b);
    const ages = trace.samples.map(sample => sample.result_age_ms).sort((a, b) => a - b);
    return { channel, frozen, managed, frames: trace.samples.length, changed, expired, rawHashes: hashes.size,
      movement, inferenceP50Ms: timings[Math.floor(timings.length * 0.5)], inferenceP95Ms: timings[Math.floor(timings.length * 0.95)],
      resultAgeP95Ms: ages[Math.floor(ages.length * 0.95)] };
  } finally {
    clearTimeout(timeout);
    clearTimeout(ownerStop);
    child.stdin.end();
    await writeFile(stop, 'stop');
    await writeFile(join(directory, moving ? 'motion-worker-stderr.txt' : 'worker-stderr.txt'), stderr);
    // Cooperative stop only; a hung worker remains visible as a failed test.
    let stopTimeout;
    try { await Promise.race([exit, new Promise((_, reject) => { stopTimeout = setTimeout(() => reject(new Error('Worker did not stop; retained')), 5000); })]); }
    finally { clearTimeout(stopTimeout); }
  }
}
