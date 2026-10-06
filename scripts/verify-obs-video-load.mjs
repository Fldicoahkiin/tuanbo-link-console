import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { closeOwnedObsTest } from './close-owned-obs-test.mjs';

// Isolated OBS GPU/decoder baseline, NOT the application's six-hour acceptance.
// Scene switches are synthetic. No camera hardware, stream or recording is used.
const [installation, fixture, durationText = '1800'] = process.argv.slice(2);
const seconds = Number(durationText);
const hardwareStreams = Number(process.env.TBLINK_OBS_HARDWARE_STREAMS ?? 4);
if (!Number.isInteger(hardwareStreams) || hardwareStreams < 0 || hardwareStreams > 4) throw new Error('硬件解码路数必须为 0..4，其余视频仍以原分辨率软件解码');
if (process.platform !== 'win32' || !installation || !fixture || !Number.isInteger(seconds) || seconds < 30 || seconds > 21600) throw new Error('用法：node scripts/verify-obs-video-load.mjs <OBS 目录> <合成 tblink> <30..21600 秒>');
const projectFile = resolve(fixture), project = JSON.parse(await readFile(projectFile, 'utf8'));
assert.equal(project.rundown.length, 200); assert.equal(project.mediaAssets.length, 2000);
const assets = project.mediaAssets.slice(0, 8);
assert.equal(assets.filter(asset => asset.kind === 'video').length, 4);
const root = resolve('artifacts'); await mkdir(root, { recursive: true });
const directory = await mkdtemp(join(root, 'obs-video-load-')), obsDirectory = join(directory, 'obs');
for (const name of ['bin', 'data', 'obs-plugins']) await cp(join(resolve(installation), name), join(obsDirectory, name), { recursive: true });
const config = join(obsDirectory, 'config/obs-studio');
for (const name of ['basic/profiles/Load', 'basic/scenes', 'plugin_config/obs-websocket']) await mkdir(join(config, name), { recursive: true });
const global = '[General]\nFirstRun=false\nPre19Defaults=false\nLastVersion=537001986\nEnableAutoUpdates=false\n[Basic]\nProfile=Load\nProfileDir=Load\nSceneCollection=Load\nSceneCollectionFile=Load\n';
await writeFile(join(config, 'global.ini'), global);
await writeFile(join(config, 'user.ini'), global + '[BasicWindow]\nPreviewEnabled=true\nSysTrayEnabled=false\n');
await writeFile(join(config, 'basic/profiles/Load/basic.ini'), '[General]\nName=Load\n[Video]\nBaseCX=2160\nBaseCY=3840\nOutputCX=2160\nOutputCY=3840\nFPSType=0\nFPSCommon=60\n[Audio]\nSampleRate=48000\nChannelSetup=Stereo\n[Output]\nMode=Simple\n');
const scenes = Array.from({ length: 16 }, (_, index) => `TBLINK 压力场景 ${index + 1}`);
await writeFile(join(config, 'basic/scenes/Load.json'), JSON.stringify({ name: 'Load', current_scene: scenes[0], current_program_scene: scenes[0], sources: [{ name: scenes[0], id: 'scene', settings: { items: [] } }], scene_order: [{ name: scenes[0] }], version: 2 }));
const port = 30000 + Math.floor(Math.random() * 15000), password = randomUUID();
await writeFile(join(config, 'plugin_config/obs-websocket/config.json'), JSON.stringify({ alerts_enabled: false, auth_required: true, first_load: false, server_enabled: true, server_password: password, server_port: port }));
const require = createRequire(resolve('apps/desktop/package.json'));
const { OBSWebSocket } = require('obs-websocket-js');
const ps = script => promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);" + script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000 });
const quote = value => `'${value.replaceAll("'", "''")}'`;
const executable = join(obsDirectory, 'bin/64bit/obs64.exe');
const launched = await ps(`$p=Start-Process -FilePath ${quote(executable)} -WorkingDirectory ${quote(dirname(executable))} -ArgumentList @('--portable','--multi','--disable-updater','--disable-missing-files-check') -WindowStyle Hidden -PassThru; @{pid=$p.Id;started=$p.StartTime.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress`);
const identity = { ...JSON.parse(launched.stdout.replace(/^\uFEFF/, '')), executable };
await writeFile(join(directory, 'owned-process.json'), JSON.stringify(identity));
console.log(JSON.stringify({ event: 'started', directory, identityFile: join(directory, 'owned-process.json') }));
const socket = new OBSWebSocket(), failures = [], hashes = new Set();
const report = { passed: false, seconds, hardwareDecodeStreams: hardwareStreams, softwareDecodeStreams: 4 - hardwareStreams, applicationAcceptance: false, hardwareAcceptance: false,
  scope: 'Isolated OBS render/decoder baseline; 16 synthetic scenes reuse 4 video + 4 image inputs. No application event scheduler, cameras, physical output or six-hour approval.',
  maximumFrameStallMeasured: false, assets, failures, samples: 0, switches: 0 };
const trace = createWriteStream(join(directory, 'samples.ndjson'));
trace.on('error', error => failures.push(String(error)));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let connected = false;
async function call(type, data) {
  let timer;
  try { return await Promise.race([socket.call(type, data), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`OBS ${type} 超过 2 秒；停止测试，不自动重试`)), 2000); })]); }
  finally { clearTimeout(timer); }
}
try {
  const deadline = Date.now() + 30000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    const logs = await readdir(join(config, 'logs')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const file of logs) {
      const log = await readFile(join(config, 'logs', file), 'utf8');
      if (log.includes('==== Startup complete') && log.includes('Loaded scenes:')) ready = true;
    }
    if (!ready) await sleep(250);
  }
  assert(ready, '验收 OBS 没有启动');
  await socket.connect(`ws://127.0.0.1:${port}`, password); connected = true;
  report.version = await call('GetVersion'); report.video = await call('GetVideoSettings');
  assert.equal(report.video.baseWidth, 2160); assert.equal(report.video.baseHeight, 3840);
  assert.equal(report.video.fpsNumerator / report.video.fpsDenominator, 60);
  assert.equal((await call('GetStreamStatus')).outputActive, false); assert.equal((await call('GetRecordStatus')).outputActive, false);
  for (const sceneName of scenes.slice(1)) await call('CreateScene', { sceneName });
  for (const [index, asset] of assets.entries()) {
    const inputName = `TBLINK 压力素材 ${index + 1}`, path = resolve(dirname(projectFile), asset.relativePath);
    assert(path.startsWith(dirname(projectFile) + '\\'), '素材路径必须处于独立验收工程中');
    await call('CreateInput', { sceneName: scenes[0], inputName, inputKind: asset.kind === 'video' ? 'ffmpeg_source' : 'image_source',
      inputSettings: asset.kind === 'video' ? { local_file: path, is_local_file: true, looping: true, hw_decode: index < hardwareStreams, close_when_inactive: false, restart_on_activate: false, clear_on_media_end: false } : { file: path, unload: false }, sceneItemEnabled: true });
    if (asset.kind === 'video') await call('SetInputMute', { inputName, inputMuted: true });
    for (const [sceneIndex, sceneName] of scenes.entries()) {
      const { sceneItemId } = sceneIndex ? await call('CreateSceneItem', { sceneName, sourceName: inputName, sceneItemEnabled: true }) : await call('GetSceneItemId', { sceneName, sourceName: inputName });
      await call('SetSceneItemTransform', { sceneName, sceneItemId, sceneItemTransform: { positionX: index % 2 * 1080, positionY: Math.floor(index % 4 / 2) * 1920,
        boundsType: 'OBS_BOUNDS_STRETCH', boundsWidth: 1080, boundsHeight: 1920, alignment: 5 } });
    }
  }
  await sleep(10000); // Explicit decoder warmup, excluded from normal-load denominator.
  const initial = await call('GetStats'); report.initial = initial;
  const started = performance.now(), end = started + seconds * 1000;
  report.startedAt = new Date().toISOString();
  let nextSwitch = 0, nextResource = 0, nextImage = 0, nextProgress = 0;
  while (performance.now() < end && !failures.length) {
    const elapsed = performance.now() - started;
    if (elapsed >= nextSwitch) { await call('SetCurrentProgramScene', { sceneName: scenes[report.switches++ % scenes.length] }); nextSwitch = elapsed + 2000; }
    const sample = { elapsedMs: elapsed, stats: await call('GetStats') };
    if (elapsed >= nextResource) {
      sample.resources = JSON.parse((await ps(`$p=Get-Process -Id ${identity.pid}; $os=Get-CimInstance Win32_OperatingSystem; @{privateBytes=$p.PrivateMemorySize64;workingSet=$p.WorkingSet64;availableKb=$os.FreePhysicalMemory;totalKb=$os.TotalVisibleMemorySize}|ConvertTo-Json -Compress`)).stdout.replace(/^\uFEFF/, ''));
      nextResource = elapsed + 5000;
    }
    if (elapsed >= nextImage) {
      const screenshot = await call('GetSourceScreenshot', { sourceName: scenes[(report.switches - 1) % scenes.length], imageFormat: 'jpg', imageWidth: 216, imageHeight: 384 });
      hashes.add(createHash('sha256').update(screenshot.imageData).digest('hex'));
      if (!report.samples) await writeFile(join(directory, 'output.jpg'), Buffer.from(screenshot.imageData.split(',')[1], 'base64'));
      nextImage = elapsed + 7000;
    }
    trace.write(JSON.stringify(sample) + '\n'); report.samples++;
    if (elapsed >= nextProgress) {
      const renderFrames = sample.stats.renderTotalFrames - initial.renderTotalFrames;
      const renderSkipped = sample.stats.renderSkippedFrames - initial.renderSkippedFrames;
      await writeFile(join(directory, 'progress.json'), JSON.stringify({ status: 'running', seconds, elapsedMs: elapsed,
        applicationAcceptance: false, hardwareAcceptance: false, samples: report.samples, switches: report.switches,
        renderFrames, renderSkipped, renderSkipRatio: renderSkipped / Math.max(1, renderFrames) }, null, 2));
      nextProgress = elapsed + 10000;
    }
    await sleep(500);
  }
  const last = await call('GetStats'); report.final = last;
  report.renderFrames = last.renderTotalFrames - initial.renderTotalFrames;
  report.renderSkipped = last.renderSkippedFrames - initial.renderSkippedFrames;
  report.renderSkipRatio = report.renderSkipped / Math.max(1, report.renderFrames);
  report.distinctOutputImages = hashes.size;
  assert(report.renderFrames > seconds * 55, '实际渲染帧数不足');
  assert(report.renderSkipRatio <= 0.001, '渲染掉帧超过 0.1%');
  assert(hashes.size > 2, '输出截图未持续变化');
  assert.equal(failures.length, 0);
  report.passed = true;
} catch (error) { failures.push(String(error).replaceAll(password, '[redacted]')); process.exitCode = 1; }
finally {
  report.finishedAt = new Date().toISOString();
  trace.end(); await once(trace, 'close');
  if (connected) await socket.disconnect();
  try { await closeOwnedObsTest(identity); } catch (error) { report.passed = false; failures.push(String(error)); process.exitCode = 1; }
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ directory, passed: report.passed, failures, samples: report.samples, renderSkipRatio: report.renderSkipRatio }, null, 2));
}
