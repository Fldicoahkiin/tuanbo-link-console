import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { verifyBeautyDistribution } from './distribution.mjs';

export async function verifyBodyReal({ work, directory, call, screenshot, difference, PNG, instanceProtection = false, instanceHybrid = false, instanceRtmdet = false, bodyOnDemand = false }) {
  assert(!instanceHybrid || instanceProtection, 'Hybrid test requires instance protection');
  assert(!instanceRtmdet || (instanceProtection && !instanceHybrid), 'RTMDet requires exclusive instance protection');
  const frozen = !instanceProtection || instanceRtmdet;
  const source = dirname(fileURLToPath(import.meta.url));
  if (frozen) await verifyBeautyDistribution(source, work);
  const annotations = JSON.parse(await readFile(new URL('./semantic-regions.json', import.meta.url), 'utf8'));
  const sample = annotations.samples.find(item => item.timestampMs === 12000);
  assert(sample, 'Pinned real frame missing');
  const fixture = join(work, 'face-segmentation-clc958q0/12000-source.png');
  const input = PNG.sync.read(await readFile(fixture));
  const rgb = Buffer.alloc(input.width * input.height * 3);
  for (let pixel = 0; pixel < input.width * input.height; pixel++) input.data.copy(rgb, pixel * 3, pixel * 4, pixel * 4 + 3);
  assert.equal(createHash('sha256').update(rgb).digest('hex'), sample.rawSha256);
  const sourceName = 'Body real occlusion fixture', filterName = 'Body real diagnostic';
  await call('CreateInput', { sceneName: 'Beauty', inputName: sourceName, inputKind: 'image_source', inputSettings: { file: fixture, unload: false }, sceneItemEnabled: true });
  const original = await screenshot('body-real-original', sourceName);
  await call('CreateSourceFilter', { sourceName, filterName, filterKind: 'tblink_beauty_prototype', filterSettings: { live_mode: true, uniform_controls: true } });
  const { filterSettings } = await call('GetSourceFilter', { sourceName, filterName });
  assert.equal(filterSettings.transport_version, 7);
  const child = spawn(join(work, frozen ? 'runtime/tblink-beauty-worker/tblink-beauty-worker.exe' : 'python/Scripts/python.exe'), [
    ...(!frozen ? [join(source,'worker.py'),'--instance-model-dir',join(work,'person-instance')] : []),
    ...(instanceRtmdet ? ['--instance-rtmdet-dir', join(work, 'rtmdet-ins-tiny'), '--semantic-probability'] : []),
    ...(bodyOnDemand ? ['--body-on-demand'] : []),
    ...(instanceHybrid ? ['--instance-hybrid-dir',join(work,'instance-split-5ykffe_z')] : []),
    '--channel', filterSettings.transport_name, '--model', join(work, 'face_landmarker.task'),
    '--body-model', join(work, 'pose_landmarker_lite.task'),
    '--proposal-model', join(work, 'face_detection_yunet_2023mar.onnx'), '--proposal-backend', 'directml',
    '--semantic-model', join(work, instanceRtmdet ? 'selfie_skin_probability.onnx' : 'selfie_multiclass_256x256.onnx'), '--semantic-backend', 'directml',
    '--profile-skin', '--managed', '--diagnostic-history', '1000', '--report', join(directory, 'body-real-worker.json')
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let packet, protocolError, cleanupError, stderr = '', ended = false;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { try { const value = JSON.parse(line); if ('sequence' in value) packet = value; } catch (error) { protocolError = error; } });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const exit = new Promise(resolve => {
    child.once('error', error => { protocolError = error; ended = true; resolve(null); });
    child.once('exit', code => { ended = true; resolve(code); });
  });
  const report = { passed: false, qualityAccepted: false, instanceProtection, instanceHybrid, instanceRtmdet, frozen, bodyOnDemand, attribution: annotations.attribution, rawSha256: sample.rawSha256,
    scope: 'Actual combined worker and OBS pixels on one reviewed real occlusion frame; not broad quality acceptance.', effects: [], failures: [] };
  try {
    if (bodyOnDemand) {
      const idleDeadline = Date.now() + 20000;
      while (!(packet?.face_status === 1 && packet.body_status === 2 && packet.bodies === 0)) {
        if (protocolError) throw protocolError;
        assert(!ended && Date.now() < idleDeadline, `No initial idle body state: ${stderr}`);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      report.initialIdle = packet;
      await call('SetSourceFilterSettings', { sourceName, filterName, filterSettings: { bodySlim: .5 } });
    }
    const deadline = Date.now() + 20000;
    while (!(packet?.body_status === 1 && packet.bodies === 2 && packet.body_accepted > 0 && packet.body_accepted_age_ms <= 250)) {
      if (protocolError) throw protocolError;
      assert(!ended && Date.now() < deadline, `No accepted real body result: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    for (const [key, value] of [['bodySlim', .5], ['waist', .5], ['shoulder', -.5]]) {
      await call('SetSourceFilterSettings', { sourceName, filterName, filterSettings: { bodySlim: 0, waist: 0, shoulder: 0, [key]: value } });
      for (let index = 0; index < 3; index++) {
        const processed = await screenshot(`body-real-${key}-${index}`, sourceName);
        const regions = [[180,250,5],[230,245,5],[265,230,5],[350,30,5]].map(circle => {
          const [cx,cy,radius] = circle;
          return { circle, difference: difference(original, processed, (x,y) => (x*input.width-cx)**2+(y*input.height-cy)**2 <= radius**2) };
        });
        const wholeDifference = difference(original, processed);
        const rearVisibleDifference = difference(original, processed, (x,y) => (x*input.width-120)**2+(y*input.height-190)**2 <= 25);
        report.effects.push({ key, value, index, wholeDifference, rearVisibleDifference, regions, packet });
        if (!(wholeDifference > .001)) report.failures.push(`${key}/${index}: no effective output`);
        if (key !== 'shoulder' && !(rearVisibleDifference > .001)) report.failures.push(`${key}/${index}: visible rear body has no effect`);
        for (const region of regions) if (region.difference !== 0) report.failures.push(`${key}/${index}: protected circle ${region.circle} changed by ${region.difference}`);
      }
    }
    await call('SetSourceFilterSettings', { sourceName, filterName, filterSettings: { bodySlim: 0, waist: 0, shoulder: 0 } });
    if (bodyOnDemand) {
      const resetSequence = packet.sequence, idleDeadline = Date.now() + 5000;
      while (!(packet.sequence > resetSequence && packet.bodies === 0 && packet.body_status === 2)) {
        if (protocolError) throw protocolError;
        assert(!ended && Date.now() < idleDeadline, `Body analysis did not return to idle: ${stderr}`);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      report.resetIdle = packet;
    }
    report.resetDifference = difference(original, await screenshot('body-real-reset', sourceName));
    if (report.resetDifference !== 0) report.failures.push('Reset did not restore original');
    assert.deepEqual(report.failures, [], 'Real body occlusion protection failed');
    report.passed = true;
  } catch (error) { report.error = String(error); throw error; }
  finally {
    child.stdin.end();
    let timer;
    try {
      const code = await Promise.race([exit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Body worker did not stop; process retained')), 8000); })]);
      assert.equal(code, 0, stderr);
      const worker = JSON.parse(await readFile(join(directory, 'body-real-worker.json'), 'utf8'));
      assert.equal(worker.instance_rtmdet, instanceRtmdet);
      assert.equal(worker.semantic_probability, instanceRtmdet);
      assert.equal(worker.body_on_demand, bodyOnDemand);
      report.workerConfigurationVerified = true;
    } catch (error) {
      report.passed = false; report.cleanupError = String(error); cleanupError = error;
    } finally {
      clearTimeout(timer); lines.close();
      await writeFile(join(directory, 'body-real.json'), JSON.stringify(report, null, 2));
      await writeFile(join(directory, 'body-real-stderr.txt'), stderr);
    }
  }
  if (cleanupError) throw cleanupError;
  return report;
}
