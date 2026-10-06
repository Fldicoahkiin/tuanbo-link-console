import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cpus, freemem, totalmem } from 'node:os';
import { verifyBeautyDistribution } from './distribution.mjs';
import { nativeStatus } from './native-status.mjs';

export async function verifyProposals({ root, work, directory, video, call, PNG, frozen = false, seconds = 30, portrait = false, semantic = false, directml = false, semanticDirectml = false, semanticProbability = false, combined = false, profileSkin = false, instanceProtection = false, instanceHybrid = false, instanceRtmdet = false, gpuFifo = false, warmupModels = false, bodyOnDemand = false }) {
  assert(Number.isInteger(seconds) && seconds >= 30 && seconds <= 600, 'Proposal duration must be 30..600 seconds');
  assert(!semanticDirectml || semantic, 'GPU segmentation requires a semantic test');
  if (frozen) await verifyBeautyDistribution(join(root, 'tools/obs/beauty'), work);
  const require = createRequire(join(root, 'apps/desktop/package.json'));
  const client = join(directory, 'proposal-client/beauty-comparison.mjs');
  await require('esbuild').build({ entryPoints: [join(root, 'apps/desktop/src/main/link/beauty-comparison.ts')],
    outfile: client, bundle: true, platform: 'node', format: 'esm', target: 'node22' });
  const { BeautyComparison } = await import(pathToFileURL(client).href);
  const mediaName = 'Proposal motion fixture';
  const canvasName = 'Proposal portrait canvas';
  const target = { sourceName: portrait ? canvasName : mediaName, filterName: 'Proposal beauty' };
  const sha256 = createHash('sha256').update(await readFile(video)).digest('hex');
  const assets = JSON.parse(await readFile(join(root, 'tools/obs/beauty/motion-assets.json'), 'utf8'));
  const report = { passed: false, qualityAccepted: false, frozen, semantic, scope: 'Explicit experimental worker with face proposals, real OBS pixels and concurrent body analysis; not packaged UI or quality acceptance',
    video, sha256, seconds, attribution: assets.videos.find(asset => asset.sha256 === sha256) ?? null, samples: [] };
  report.directml = directml;
  report.semanticDirectml = semanticDirectml;
  report.semanticProbability = semanticProbability;
  assert(!semanticProbability || semanticDirectml, 'GPU probability test requires DirectML semantics');
  report.combined = combined;
  report.profileSkin = profileSkin;
  report.instanceProtection = instanceProtection;
  report.instanceHybrid = instanceHybrid;
  report.instanceRtmdet = instanceRtmdet;
  assert(!instanceRtmdet || (instanceProtection && !instanceHybrid), 'RTMDet requires exclusive instance protection');
  report.gpuFifo = gpuFifo;
  report.warmupModels = warmupModels;
  assert(!instanceHybrid || instanceProtection, 'Hybrid test requires instance protection');
  assert(!instanceProtection || combined, 'Instance protection test requires combined processing');
  assert(!instanceProtection || !frozen || instanceRtmdet, 'Only RTMDet instance protection is included in the frozen candidate');
  assert(!profileSkin || semantic, "Profile skin requires semantic protection");
  assert(!combined || semantic, 'Combined verification requires semantic protection');
  report.host = { logicalProcessors: cpus().length, totalMemoryBytes: totalmem() };
  const cpuTotals = () => cpus().reduce((sum, cpu) => ({
    idle: sum.idle + cpu.times.idle,
    total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0)
  }), { idle: 0, total: 0 });
  let previousCpu = cpuTotals();
  let previousHostAt = performance.now();
  const hostSample = () => {
    const currentCpu = cpuTotals(), now = performance.now();
    const elapsedCpu = currentCpu.total - previousCpu.total;
    const sample = { at: new Date().toISOString(), intervalMs: now - previousHostAt,
      freeMemoryBytes: freemem(), cpuBusyPercent: elapsedCpu > 0
        ? 100 * (1 - (currentCpu.idle - previousCpu.idle) / elapsedCpu) : null };
    previousCpu = currentCpu; previousHostAt = now;
    return sample;
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const failures = [];
  let child, exit, comparison, owned = false, canvasOwned = false, ended = false, stderr = '', pending = '', packet, packetAt = 0, protocolError;
  try {
    if (portrait) {
      await call('SetVideoSettings', { baseWidth: 1080, baseHeight: 1920, outputWidth: 1080, outputHeight: 1920, fpsNumerator: 60, fpsDenominator: 1 });
      await call('CreateScene', { sceneName: canvasName });
      canvasOwned = true;
    }
    report.videoSettings = await call('GetVideoSettings');
    const media = await call('CreateInput', { sceneName: portrait ? canvasName : 'Beauty', inputName: mediaName, inputKind: 'ffmpeg_source',
      inputSettings: { local_file: video, is_local_file: true, looping: seconds > 30, close_when_inactive: false }, sceneItemEnabled: true });
    owned = true;
    await call('SetInputMute', { inputName: mediaName, inputMuted: true });
    if (portrait) {
      await call('SetSceneItemTransform', { sceneName: canvasName, sceneItemId: media.sceneItemId,
        sceneItemTransform: { boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: 1080, boundsHeight: 1920, positionX: 0, positionY: 0, alignment: 5 } });
      await call('CreateSceneItem', { sceneName: 'Beauty', sourceName: canvasName, sceneItemEnabled: true });
    }
    await call('SetCurrentProgramScene', { sceneName: 'Beauty' });
    await call('CreateSourceFilter', { ...target, filterKind: 'tblink_beauty_prototype', filterSettings: {
      live_mode: true, uniform_controls: true, smooth: .4, white: .15, lipstick: semantic ? .5 : 0,
      slim: semantic && !combined ? 0 : .2, eye: semantic && !combined ? 0 : .15, bodySlim: semantic && !combined ? 0 : .25, waist: semantic && !combined ? 0 : .2, legSlim: semantic && !combined ? 0 : .15 } });
    const settings = (await call('GetSourceFilter', target)).filterSettings;
    report.nativeChannel = settings.transport_name;
    comparison = new BeautyComparison(() => Promise.resolve(settings.comparison_pipe));
    child = spawn(join(work, frozen ? 'runtime/tblink-beauty-worker/tblink-beauty-worker.exe' : 'python/Scripts/python.exe'),
      [...(frozen ? [] : ['-X', 'faulthandler', join(root, 'tools/obs/beauty/worker.py')]),
      '--channel', settings.transport_name, '--model', join(work, 'face_landmarker.task'),
      '--body-model', join(work, 'pose_landmarker_lite.task'), '--proposal-model', join(work, 'face_detection_yunet_2023mar.onnx'),
      ...(semantic ? ['--semantic-model', join(work, semanticProbability ? 'selfie_skin_probability.onnx' : semanticDirectml ? 'selfie_multiclass_256x256.onnx' : 'selfie_multiclass_256x256.tflite')] : []),
      ...(semanticProbability ? ['--semantic-probability'] : []),
      ...(semanticDirectml ? ['--semantic-backend', 'directml'] : []),
      ...(profileSkin ? ['--profile-skin'] : []),
      ...(instanceProtection && !instanceRtmdet ? ['--instance-model-dir', join(work,'person-instance')] : []),
      ...(instanceRtmdet ? ['--instance-rtmdet-dir', join(work,'rtmdet-ins-tiny')] : []),
      ...(instanceHybrid ? ['--instance-hybrid-dir', join(work,'instance-split-5ykffe_z')] : []),
      ...(gpuFifo ? ['--gpu-fifo'] : []),
      ...(warmupModels ? ['--warmup-models'] : []),
      ...(bodyOnDemand ? ['--body-on-demand'] : []),
      ...(directml ? ['--proposal-backend', 'directml'] : []),
      '--managed', '--diagnostic-history', '10000', '--report', join(directory, 'proposal-worker.json')],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...(!frozen && (directml || semanticDirectml) ? { env: { ...process.env, PYTHONPATH: join(work, 'gpu-probe-deps') } } : {}) });
    report.pid = child.pid;
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-64000); });
    child.stdin.on('error', error => { protocolError = String(error); });
    child.stdout.on('data', chunk => {
      pending += chunk.toString();
      if (pending.length > 64000) { protocolError = 'Worker packet exceeds diagnostic bounds'; child.stdin.end(); return; }
      const lines = pending.split('\n'); pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try { const value = JSON.parse(line); if ('sequence' in value) { packet = value; packetAt = Date.now(); } }
        catch (error) { protocolError = String(error); child.stdin.end(); }
      }
    });
    exit = new Promise(resolve => {
      child.once('error', error => { protocolError = String(error); ended = true; resolve(null); });
      child.once('exit', code => { ended = true; resolve(code); });
    });
    const readyBy = Date.now() + 20000;
    while (!packet && !ended && !protocolError && Date.now() < readyBy) await sleep(100);
    assert(packet && !ended && !protocolError, `Experimental worker did not become ready: ${protocolError ?? stderr}`);
    await call('TriggerMediaInputAction', { inputName: mediaName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' });
    const initialStats = await call('GetStats');
    const started = Date.now();
    report.measurementStartedAt = new Date(started).toISOString();
    while (Date.now() - started < seconds*1000) {
      assert(!ended && !protocolError, `Experimental worker failed: ${protocolError ?? stderr}`);
      const pair = await comparison.next(target);
      if (portrait) {
        assert.equal(pair.width, 360, 'Portrait comparison must preserve the full 9:16 canvas');
        assert.equal(pair.height, 640, 'Portrait comparison must preserve the full 9:16 canvas');
      }
      let changed = 0;
      for (let index = 0; index < pair.original.length; index++) if (pair.original[index] !== pair.processed[index]) changed++;
      report.samples.push({ elapsedMs: Date.now() - started, sequence: pair.sequence, width: pair.width, height: pair.height,
        rawHash: createHash('sha256').update(pair.original).digest('hex'), changedChannels: changed, accepted: packet, packetAgeMs: Date.now() - packetAt,
        media: await call('GetMediaInputStatus', { inputName: mediaName }), stats: await call('GetStats'), host: hostSample() });
      if (report.samples.length % 10 === 1) {
        for (const [kind, data] of [['original', pair.original], ['processed', pair.processed]])
          await writeFile(join(directory, `proposal-${report.samples.length}-${kind}.png`), PNG.sync.write({ width: pair.width, height: pair.height, data }));
      }
      await sleep(300);
    }
    report.measurementEndedAt = new Date().toISOString();
    const acceptedFaces = report.samples.filter(sample => sample.packetAgeMs <= 750 && sample.accepted.faces >= 2 && sample.accepted.face_status === 1 &&
      sample.accepted.accepted > 0 && sample.accepted.sequence >= sample.accepted.accepted && sample.accepted.sequence - sample.accepted.accepted < 32 &&
      sample.accepted.accepted_age_ms !== null && sample.accepted.accepted_age_ms <= 250);
    report.summary = { samples: report.samples.length, movingFrames: new Set(report.samples.map(sample => sample.rawHash)).size,
      changedSamples: report.samples.filter(sample => sample.changedChannels > 0).length,
      acceptedTwoFaces: acceptedFaces.length, acceptedTwoFaceResults: new Set(acceptedFaces.map(sample => sample.accepted.accepted)).size };
    const finalStats = report.samples.at(-1).stats;
    const totalFrames = finalStats.renderTotalFrames - initialStats.renderTotalFrames;
    const skippedFrames = finalStats.renderSkippedFrames - initialStats.renderSkippedFrames;
    const renderTimes = report.samples.map(sample => sample.stats.averageFrameRenderTime).sort((a, b) => a-b);
    report.performance = { totalFrames, skippedFrames, skippedRatio: totalFrames > 0 ? skippedFrames / totalFrames : null,
      renderTimeP95Ms: renderTimes[Math.ceil(renderTimes.length*.95)-1],
      obsMemoryStartMB: initialStats.memoryUsage, obsMemoryEndMB: finalStats.memoryUsage,
      scope: 'OBS preview rendering and real video decode; no encoding, streaming or recording' };
    if (portrait) {
      assert(totalFrames >= seconds*60*.9, 'Portrait OBS render cadence fell below 90% of 60fps');
      assert(report.performance.skippedRatio < .01, 'Portrait OBS skipped at least 1% of render frames');
      assert(report.performance.renderTimeP95Ms < 1000/60, 'Portrait OBS render time exceeds 60fps budget');
    }
    assert(report.summary.movingFrames >= 30, 'Real input did not keep advancing');
    assert(report.summary.changedSamples >= 10, 'Experimental effects did not reach video pixels');
    assert(report.summary.acceptedTwoFaceResults >= 3, 'Supplementary pipeline never yielded multiple distinct accepted two-face results');
    report.passed = true;
  } catch (error) { failures.push(error); report.error = String(error); }
  finally {
    comparison?.close();
    if (child && exit) {
      child.stdin.end();
      let timer;
      try {
        const code = await Promise.race([exit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Experimental worker did not stop; process retained')), 8000); })]);
        assert.equal(code, 0, `Experimental worker exited abnormally: ${stderr}`);
        const trace = JSON.parse(await readFile(join(directory, 'proposal-worker.json'), 'utf8'));
        if (warmupModels) {
          assert.equal(trace.warmup.cancelled, false);
          assert(trace.warmup.stages.length >= 3);
          assert(trace.samples[0].sequence > trace.warmup.sequence, 'Warmup frame must not be published');
          report.warmup = trace.warmup;
        }
        if (bodyOnDemand) assert.equal(trace.body_on_demand, true);
        report.bodyOnDemand = bodyOnDemand;
        if (directml) assert.equal(trace.proposal_backend, 'directml', 'Requested GPU proposal backend was not used');
        if (semantic) assert.equal(trace.semantic_face_protection, true, 'Requested semantic protection was not enabled');
        if (semanticDirectml) assert.equal(trace.semantic_backend, 'directml', 'Requested GPU segmentation was not used');
        if (semanticProbability) assert.equal(trace.semantic_probability, true, 'Requested GPU probability model was not used');
        if (instanceProtection) {
          assert.equal(trace.instance_protection, true);
          assert.equal(trace.instance_rtmdet, instanceRtmdet);
          if (instanceHybrid) assert.equal(trace.instance_hybrid, true);
          if (gpuFifo) assert.equal(trace.gpu_fifo, true);
          report.instanceSamples = trace.body_samples.filter(sample => Array.isArray(sample.instance_assignments) && sample.instance_assignments.some(index => index !== null)).length;
          assert(report.instanceSamples > 3, 'Instance protection branch was not exercised');
        }
        if (profileSkin) {
          assert.equal(trace.profile_skin, true);
          report.profileSamples = trace.samples.filter(sample => sample.profiles > 0).length;
          assert(report.profileSamples > 3, 'Profile branch was not exercised');
        }
        const firstAccepted = trace.samples.findIndex(sample => sample.accepted_sequence > 0);
        assert(firstAccepted >= 0, 'OBS never acknowledged a face result');
        const settled = trace.samples.slice(firstAccepted);
        const percentile = (key, samples = trace.samples) => {
          const values = samples.map(sample => sample[key]).filter(value => value !== null && Number.isFinite(value)).sort((a, b) => a-b);
          return values[Math.floor((values.length-1)*.95)] ?? null;
        };
        report.timings = { frames: trace.samples.length, settledFrames: settled.length,
          expiredFrames: settled.filter(sample => sample.face_status === 3).length,
          invalidFrames: settled.filter(sample => sample.face_status === 4).length,
          inferenceP95Ms: percentile('inference_ms'), baselineP95Ms: percentile('baseline_ms'),
          semanticP95Ms: percentile('semantic_ms'),
          locateP95Ms: percentile('proposal_locate_ms'), refineP95Ms: percentile('proposal_refine_ms'),
          resultAgeP95Ms: percentile('result_age_ms'), acceptedAgeP95Ms: percentile('accepted_age_ms') };
        const firstBodyAccepted = trace.samples.findIndex(sample => sample.body_accepted_sequence > 0);
        assert(firstBodyAccepted >= 0, 'OBS never acknowledged a body result');
        const bodies = trace.samples.slice(firstBodyAccepted);
        report.bodyTimings = { settledFrames: bodies.length,
          expiredFrames: bodies.filter(sample => sample.body_status === 3).length,
          invalidFrames: bodies.filter(sample => sample.body_status === 4).length,
          processingP95Ms: percentile('processing_ms', trace.body_samples),
          inferenceP95Ms: percentile('inference_ms', trace.body_samples),
          masksP95Ms: percentile('masks_ms', trace.body_samples),
          instanceP95Ms: percentile('instance_ms', trace.body_samples),
          instanceWaitP95Ms: percentile('instance_wait_ms', trace.body_samples),
          instanceProtectionP95Ms: percentile('instance_protection_ms', trace.body_samples),
          resultAgeP95Ms: percentile('result_age_ms', trace.body_samples) };
        assert.equal(report.timings.invalidFrames, 0, 'OBS rejected invalid face geometry');
        assert.equal(report.timings.expiredFrames, 0, 'Face geometry expired after initial acknowledgement');
        assert.equal(report.bodyTimings.invalidFrames, 0, 'OBS rejected invalid body geometry');
        assert.equal(report.bodyTimings.expiredFrames, 0, 'Body geometry expired after initial acknowledgement');
      } catch (error) { failures.push(error); }
      finally { clearTimeout(timer); }
    }
    if (report.measurementEndedAt) {
      try {
        const logDirectory = join(directory, 'obs/config/obs-studio/logs');
        const names = (await readdir(logDirectory)).filter(name => name.endsWith('.txt'));
        const logs = await Promise.all(names.map(async name => ({ name, text: await readFile(join(logDirectory, name), 'utf8') })));
        report.nativeContinuity = nativeStatus(logs, report.nativeChannel, report.measurementStartedAt, report.measurementEndedAt);
        assert.equal(report.nativeContinuity.complete, true, 'Native transition log is filtered or incomplete');
        assert.equal(report.nativeContinuity.expiredTransitions, 0, 'Native renderer reverted to original during measurement');
      } catch (error) { failures.push(error); }
    }
    if (owned) {
      try { await call('RemoveInput', { inputName: mediaName }); }
      catch (error) { failures.push(error); }
    }
    if (canvasOwned) {
      try { await call('RemoveScene', { sceneName: canvasName }); }
      catch (error) { failures.push(error); }
    }
    report.passed = report.passed && failures.length === 0;
    report.failures = failures.map(String);
    await writeFile(join(directory, 'proposal-worker-stderr.txt'), stderr);
    await writeFile(join(directory, 'proposals.json'), JSON.stringify(report, null, 2));
  }
  if (failures.length) throw new AggregateError(failures, 'Experimental face proposal verification failed');
  return report;
}
