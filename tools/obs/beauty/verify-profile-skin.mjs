import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { verifyBeautyDistribution } from './distribution.mjs';

export async function verifyProfileSkin({ work, directory, call, screenshot, difference, PNG }) {
  await verifyBeautyDistribution(dirname(fileURLToPath(import.meta.url)), work);
  const annotations = JSON.parse(await readFile(new URL('./semantic-regions.json', import.meta.url), 'utf8'));
  const reports = [], failures = [];
  for (const sample of annotations.samples) {
    try { reports.push(await verifyFrame({ work, directory, call, screenshot, difference, PNG, sample })); }
    catch (error) { failures.push(error); }
  }
  await writeFile(join(directory, 'profile-real-regions.json'), JSON.stringify({ passed: failures.length === 0,
    qualityAccepted: false, scope: 'Sparse reviewed regions only; no dense or temporal quality acceptance',
    attribution: annotations.attribution, reports, errors: failures.map(String) }, null, 2));
  if (failures.length) throw new AggregateError(failures, 'Real face region verification failed');
  return reports;
}

async function verifyFrame({ work, directory, call, screenshot, difference, PNG, sample }) {
  const prefix = sample.timestampMs === 12000 ? 'profile-real' : `profile-real-${sample.timestampMs}`;
  const fixture = join(work, `face-segmentation-clc958q0/${sample.timestampMs}-source.png`);
  const input = PNG.sync.read(await readFile(fixture));
  const rgb = Buffer.alloc(input.width * input.height * 3);
  for (let pixel = 0; pixel < input.width * input.height; pixel++) input.data.copy(rgb, pixel * 3, pixel * 4, pixel * 4 + 3);
  assert.equal(createHash('sha256').update(rgb).digest('hex'), sample.rawSha256);
  const sourceName = `Profile skin real frame ${sample.timestampMs}`, filterName = 'Profile skin diagnostic';
  await call('CreateInput', { sceneName: 'Beauty', inputName: sourceName, inputKind: 'image_source', inputSettings: { file: fixture, unload: false }, sceneItemEnabled: true });
  const original = await screenshot(`${prefix}-original`, sourceName);
  await call('CreateSourceFilter', { sourceName, filterName, filterKind: 'tblink_beauty_prototype', filterSettings: { live_mode: true, uniform_controls: true, smooth: .8, white: .8 } });
  const { filterSettings } = await call('GetSourceFilter', { sourceName, filterName });
  assert.equal(filterSettings.transport_version, 7);
  const reportPath = join(directory, `${prefix}-worker.json`);
  const child = spawn(join(work, 'runtime/tblink-beauty-worker/tblink-beauty-worker.exe'), [
    '--channel', filterSettings.transport_name, '--model', join(work, 'face_landmarker.task'),
    '--proposal-model', join(work, 'face_detection_yunet_2023mar.onnx'), '--proposal-backend', 'directml',
    '--semantic-model', join(work, 'selfie_multiclass_256x256.onnx'), '--semantic-backend', 'directml',
    '--profile-skin', '--managed', '--diagnostic-history', '1000', '--report', reportPath
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let packet, error, stderr = '', ended = false;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { try { const value = JSON.parse(line); if ('sequence' in value) packet = value; } catch (failure) { error = failure; } });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const exit = new Promise(resolve => { child.once('error', failure => { error = failure; ended = true; resolve(null); }); child.once('exit', code => { ended = true; resolve(code); }); });
  const report = { passed: false, qualityAccepted: false, timestampMs: sample.timestampMs, rawSha256: sample.rawSha256,
    scope: 'Reviewed sparse real face/exclusion regions, actual frozen models and OBS rendering.' };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    const deadline = Date.now() + 20000;
    while (!(packet?.face_status === 1 && packet.accepted > 0 && packet.accepted_age_ms <= 250 &&
      (sample.timestampMs !== 12000 || packet.profiles > 0))) {
      if (error) throw error;
      assert(!ended && Date.now() < deadline, `No accepted profile result: ${stderr}`);
      await sleep(25);
    }
    report.packet = packet;
    const processed = await screenshot(`${prefix}-processed`, sourceName);
    report.regions = sample.regions.map(({ kind, circle: [cx, cy, radius] }) => ({ kind, circle: [cx, cy, radius],
      difference: difference(original, processed, (x, y) => (x * input.width - cx) ** 2 + (y * input.height - cy) ** 2 <= radius ** 2) }));
    const region = (x, y) => (x * input.width - 448) ** 2 + (y * input.height - 91) ** 2 <= 9;
    report.sideFaceDifference = difference(original, processed, region);
    await call('SetSourceFilterSettings', { sourceName, filterName, filterSettings: { smooth: 0, white: 0 } });
    assert.deepEqual((await screenshot(`${prefix}-reset`, sourceName)).data, original.data, 'Profile controls did not reset');
    child.stdin.end();
    assert.equal(await exit, 0, stderr);
    await call('RemoveInput', { inputName: sourceName });
    const trace = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(trace.profile_skin, true);
    const accepted = trace.samples.find(sample => sample.sequence === report.packet.accepted);
    assert(accepted, 'Acknowledged sample is absent');
    if (sample.timestampMs === 12000) {
      assert(accepted.profiles > 0);
      assert(accepted.centers.every(([x]) => x < .4), 'Reviewed side-face unexpectedly has a dense mesh; test no longer isolates profile skin');
      assert(report.sideFaceDifference > .01, 'Reviewed side-face skin still receives no effect');
    }
    report.accepted = accepted;
    for (const region of report.regions) {
      if (region.kind === 'face') assert(region.difference > .01, `Face region receives no effect: ${JSON.stringify(region)}`);
      else assert.equal(region.difference, 0, `Excluded region changed: ${JSON.stringify(region)}`);
    }
    report.passed = true;
  } catch (failure) {
    report.error = String(failure);
    throw failure;
  } finally {
    child.stdin.end();
    let timer;
    try { await Promise.race([exit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Profile worker did not stop; process retained')), 8000); })]); }
    finally { clearTimeout(timer); lines.close(); await writeFile(join(directory, `${prefix}.json`), JSON.stringify(report, null, 2)); await writeFile(join(directory, `${prefix}-stderr.txt`), stderr); }
  }
  return report;
}
