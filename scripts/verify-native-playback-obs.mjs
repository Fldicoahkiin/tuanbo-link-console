import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { closeOwnedObsTest } from './close-owned-obs-test.mjs';

// A fresh portable OBS profile. Never connect to the user's running OBS, and
// never start/stop streaming or recording. The low-level tone lasts seconds.
if (process.platform !== 'win32') throw new Error('必须在 Windows 执行团播联动台·内部正式音频');
const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/verify-native-playback-obs.mjs <OBS installation directory>');
const measureMedia = process.env.TBLINK_MEASURE_MEDIA_START === '1';
const loadUi = process.env.TBLINK_VERIFY_LOAD_UI === '1' || measureMedia;
const loadSeconds = Number(process.env.TBLINK_NATIVE_OBS_LOAD_SECONDS ?? 120);
if (!Number.isInteger(loadSeconds) || loadSeconds < 120 || loadSeconds > 21600) throw new Error('OBS连续节目验收时长必须为120至21600秒');
if (loadUi && !process.env.TBLINK_STABILITY_FIXTURE) throw new Error('高负载正式按钮验收需要 TBLINK_STABILITY_FIXTURE');
const desktopBuild = resolve('apps/desktop', process.env.TBLINK_MTC_SOAK_BUILD_DIR ?? 'out');
const desktopBuildHashes = {};
if (loadUi || process.env.TBLINK_VERIFY_PROGRAM_UI === '1' || process.env.TBLINK_VERIFY_OBS_BACKGROUND === '1') {
  for (const file of ['main/index.cjs', 'preload/index.cjs', 'renderer/index.html']) {
    // A debugger handshake does not prove the application entry file exists.
    // Check the fixed build before launching portable OBS or Electron.
    const content = await readFile(join(desktopBuild, file));
    desktopBuildHashes[file] = createHash('sha256').update(content).digest('hex');
  }
}
const root = resolve(process.env.TBLINK_ACCEPTANCE_DIRECTORY ?? 'artifacts'); await mkdir(root, { recursive: true });
const directory = await mkdtemp(join(root, 'native-audio-obs-'));
const obsDirectory = join(directory, 'obs');
for (const name of ['bin', 'data', 'obs-plugins']) await cp(join(resolve(source), name), join(obsDirectory, name), { recursive: true });
const previewBridge = resolve(process.env.TBLINK_TEST_OBS_BRIDGE ?? 'tools/obs/native-preview/tblink-realtime-preview.dll');
const previewBridgeSha256 = createHash('sha256').update(await readFile(previewBridge)).digest('hex');
await cp(previewBridge, join(obsDirectory, 'obs-plugins/64bit/tblink-realtime-preview.dll'));
await cp(resolve('artifacts/beauty-prototype/plugin/tblink-beauty.dll'), join(obsDirectory, 'obs-plugins/64bit/tblink-beauty.dll'));
await mkdir(join(obsDirectory, 'data/obs-plugins/tblink-beauty'), { recursive: true });
await cp(resolve('artifacts/beauty-prototype/plugin/beauty.effect'), join(obsDirectory, 'data/obs-plugins/tblink-beauty/beauty.effect'));
let diagnosticMedia = null;
if (process.env.TBLINK_TEST_OBS_MEDIA_MODULE) {
  assert(process.env.TBLINK_MEASURE_FRAME_POSITION === '1' || process.env.TBLINK_MEASURE_AUDIO_PRIME === '1',
    '测试媒体模块仅限逐帧或静音定位诊断，不能用于正式性能或音频验收');
  const binary = resolve(process.env.TBLINK_TEST_OBS_MEDIA_MODULE);
  const manifest = JSON.parse(await readFile(join(resolve(binary, '..'), 'manifest.json'), 'utf8'));
  assert.equal(manifest.diagnosticOnly, true);
  assert.equal(manifest.version, '32.2.2');
  const sha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  assert.equal(sha256, manifest.sha256);
  diagnosticMedia = { binary, sha256, mode: manifest.mode, scope: manifest.scope };
  await cp(binary, join(obsDirectory, 'obs-plugins/64bit/tblink-seek-diagnostic.dll'));
}
const config = join(obsDirectory, 'config/obs-studio');
for (const name of ['basic/profiles/Audio', 'basic/scenes', 'plugin_config/obs-websocket']) await mkdir(join(config, name), { recursive: true });
const obsPriority = process.env.TBLINK_TEST_OBS_PRIORITY ?? 'Normal';
assert(['Normal', 'AboveNormal'].includes(obsPriority), '只允许隔离 OBS 的普通或高于普通优先级诊断');
const global = `[General]\nProcessPriority=${obsPriority}\nFirstRun=false\nLastVersion=537001986\nEnableAutoUpdates=false\n[Basic]\nProfile=Audio\nProfileDir=Audio\nSceneCollection=Audio\nSceneCollectionFile=Audio\n`;
await writeFile(join(config, 'global.ini'), global);
await writeFile(join(config, 'user.ini'), global + '[BasicWindow]\nPreviewEnabled=true\nSysTrayEnabled=false\n');
await writeFile(join(config, 'basic/profiles/Audio/basic.ini'), `[General]\nName=Audio\n[Video]\nBaseCX=${loadUi ? 2160 : 1080}\nBaseCY=${loadUi ? 3840 : 1920}\nOutputCX=${loadUi ? 2160 : 1080}\nOutputCY=${loadUi ? 3840 : 1920}\nFPSType=0\nFPSCommon=60\n[Audio]\nSampleRate=48000\nChannelSetup=Stereo\n[Output]\nMode=Simple\n`);
await writeFile(join(config, 'basic/scenes/Audio.json'), JSON.stringify({ name: 'Audio', current_scene: 'Audio', current_program_scene: 'Audio', sources: [{ name: 'Audio', id: 'scene', settings: { items: [] } }], scene_order: [{ name: 'Audio' }], version: 2 }));
const port = 30000 + Math.floor(Math.random() * 15000), password = randomUUID();
await writeFile(join(config, 'plugin_config/obs-websocket/config.json'), JSON.stringify({ alerts_enabled: false, auth_required: true, first_load: false, server_enabled: true, server_password: password, server_port: port }));
const require = createRequire(resolve('apps/desktop/package.json'));
const { OBSWebSocket, EventSubscription } = require('obs-websocket-js');
await build({ stdin: { contents: "export { NativePlayerService } from './apps/desktop/src/main/link/native-player-service'; export { NativeAudioCache } from './apps/desktop/src/main/link/native-audio-cache'; export { selectObsAudioWindow } from './apps/desktop/src/main/link/obs-audio-window'; export { ObsWebSocketAdapter } from './apps/desktop/src/main/link/obs-websocket-adapter'; export { WindowsMidiHealth, probeWindowsMidi, midiHealthMessage } from './apps/desktop/src/main/link/windows-midi-health';", resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'cjs', alias: { '@tb/schema': resolve('packages/schema/src/index.ts'), '@tb/core/link': resolve('packages/core/src/link-public.ts') }, outfile: join(directory, 'client.cjs') });
const { NativePlayerService, NativeAudioCache, selectObsAudioWindow, ObsWebSocketAdapter, WindowsMidiHealth, probeWindowsMidi, midiHealthMessage } = require(join(directory, 'client.cjs'));
const midiHealth = new WindowsMidiHealth(() => probeWindowsMidi(resolve('tools/midi-probe/bin/tblink-midi-probe.exe')));
const pcm = Buffer.alloc(48000 * 4 * 20);
for (let frame = 0; frame < pcm.length / 4; frame++) {
  const value = Math.round(512 * Math.sin(frame * 440 * 2 * Math.PI / 48000));
  pcm.writeInt16LE(value, frame * 4); pcm.writeInt16LE(value, frame * 4 + 2);
}
const wav = Buffer.alloc(44 + pcm.length);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(48000 * 4, 28);
wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
const wavPath = join(directory, 'tone-36db.wav'); await writeFile(wavPath, wav);
const quote = value => `'${value.replaceAll("'", "''")}'`;
const ps = script => promisify(execFile)('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);" + script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 30000 });
const executable = join(obsDirectory, 'bin/64bit/obs64.exe');
const launched = await ps(`$p=Start-Process -FilePath ${quote(executable)} -WorkingDirectory ${quote(join(obsDirectory, 'bin/64bit'))} -ArgumentList @('--portable','--multi','--disable-updater','--disable-missing-files-check') -WindowStyle Hidden -PassThru; @{pid=$p.Id;started=$p.StartTime.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress`);
const identity = JSON.parse(launched.stdout.replace(/^\uFEFF/, ''));
await writeFile(join(directory, 'owned-process.json'), JSON.stringify({ ...identity, executable }));
const socket = new OBSWebSocket(), failures = [], readings = [], engineReadings = [];
const adapter = new ObsWebSocketAdapter(join(directory, 'screenshots'));
let phase = 'initial', connected = false;
const enginePath = resolve(process.env.TBLINK_PLAYBACK_ENGINE_EXE ?? 'tools/playback-engine/bin/tblink-playback.exe');
const sessionId = randomUUID();
const envelope = { version: 1, sessionId };
const engine = new NativePlayerService({ executable: enginePath,
  checkDeviceHealth: async () => {
    const result = await midiHealth.check();
    if (result !== 'ready') throw new Error(midiHealthMessage(result));
  },
  cache: new NativeAudioCache(join(directory, 'cache'), require('ffmpeg-static')),
  resolveAudio: () => wavPath,
  changed: state => { engineReadings.push({ at: Date.now(), status: state.status, positionMs: state.positionMs, gain: state.gain, peaks: state.analysis?.peaks }); if (state.audioError || state.mtcError || state.underruns) failures.push(state); },
  error: message => failures.push(message) });
const report = { passed: false, directory, obsPriority, physicalOutputAcceptance: false, desktopBuild, desktopBuildHashes, previewBridge, previewBridgeSha256, diagnosticMedia, scope: 'Actual native PCM output captured by isolated OBS input meters; no recording/streaming or physical sound measurement', readings, engineReadings, failures };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const deadline = Date.now() + 30000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    const logs = await readdir(join(config, 'logs')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const name of logs) {
      const log = await readFile(join(config, 'logs', name), 'utf8');
      if (log.includes('==== Startup complete') && log.includes('Loaded scenes:')) ready = true;
    }
    if (!ready) await sleep(250);
  }
  assert(ready, '隔离 OBS 未完成启动');
  await socket.connect(`ws://127.0.0.1:${port}`, password, { eventSubscriptions: EventSubscription.All | EventSubscription.InputVolumeMeters }); connected = true;
  await adapter.connect(`ws://127.0.0.1:${port}`, password);
  await sleep(1500);
  report.version = await socket.call('GetVersion');
  if (diagnosticMedia) assert.equal(report.version.obsVersion, '32.2.2');
  assert.equal((await socket.call('GetStreamStatus')).outputActive, false);
  assert.equal((await socket.call('GetRecordStatus')).outputActive, false);
  if (process.env.TBLINK_MEASURE_FRAME_POSITION === '1') {
    const { measureFramePosition } = await import('./measure-obs-frame-position.mjs');
    report.scope = '独立OBS截图验证帧位置，不是正式播放或性能通过';
    await measureFramePosition({ socket, address: `ws://127.0.0.1:${port}`, directory,
      inputKind: diagnosticMedia ? 'tblink_seek_diagnostic' : 'ffmpeg_source' });
    report.measurementCompleted = true;
  } else if (process.env.TBLINK_MEASURE_AUDIO_PRIME === '1') {
    const { measureAudioPrime } = await import('./measure-obs-audio-prime.mjs');
    report.scope = '独立OBS纯音频来源预热检查，不是正式播放或性能通过';
    await measureAudioPrime({ socket, address: `ws://127.0.0.1:${port}`, directory, wavPath,
      inputKind: diagnosticMedia ? 'tblink_seek_diagnostic' : 'ffmpeg_source' });
    report.measurementCompleted = true;
  } else if (measureMedia) {
    const { measureMediaStart } = await import('./measure-obs-media-start.mjs');
    report.scope = '仅测量隔离 OBS 媒体预热与启动的逐请求时序，不作为正式播放器准入通过';
    await measureMediaStart({ socket, address: `ws://127.0.0.1:${port}`, directory, fixture: process.env.TBLINK_STABILITY_FIXTURE });
    report.measurementCompleted = true;
  } else if (loadUi || process.env.TBLINK_VERIFY_PROGRAM_UI === '1' || process.env.TBLINK_VERIFY_OBS_BACKGROUND === '1') {
    await socket.call('CreateScene', { sceneName: 'Audio B' });
    if (loadUi) for (let index = 1; index <= 16; index++) await socket.call('CreateScene', { sceneName: `TBLINK 验收机位 ${index}` });
    const background = process.env.TBLINK_VERIFY_OBS_BACKGROUND === '1';
    const spec = loadUi ? 'native-program-load.spec.ts' : background ? 'native-obs-background.spec.ts' : 'native-program-obs.spec.ts';
    const output = await promisify(execFile)(process.execPath, [require.resolve('@playwright/test/cli'), 'test', spec, `--output=${join(directory, 'desktop')}`], {
      cwd: resolve('apps/desktop'), windowsHide: true, timeout: loadUi ? loadSeconds * 1000 + 180000 : 120000, env: { ...process.env, TBLINK_PLAYBACK_ENGINE_EXE: enginePath,
        TBLINK_TEST_OBS_URL: `ws://127.0.0.1:${port}`, TBLINK_TEST_OBS_PASSWORD: password, TBLINK_TEST_OBS_AUDIO: wavPath }
    }).catch(async error => { await writeFile(join(directory, 'desktop-output.txt'), String(error.stdout ?? '') + String(error.stderr ?? '')); throw error; });
    await writeFile(join(directory, 'desktop-output.txt'), output.stdout + output.stderr);
    report.scope = loadUi ? `高负载工程正式按钮 → WASAPI → 隔离 4K/60 OBS，200节目/2000素材/5万Cue工程的${loadSeconds}秒；MIDI、实体MA2与灯具不参与，不代表六小时全链路`
      : background ? '真实 Electron 后台画面接口 → WASAPI → 隔离 OBS；渲染器阻塞故障测试，不代表正式按钮或完整长测'
      : '真实 Electron 正式播放按钮 → WASAPI → 隔离 OBS 音频采集和编排切场景；无实体声音、MIDI 或灯具';
    report.passed = true;
  } else {
  await engine.prepare({ ...envelope, generation: 1, projectPath: join(directory, 'audio.tblink'), audioDeviceId: 'default', midiPortName: null,
    snapshot: { version: 1, projectId: 'audio-obs', itemId: 'tone', revision: 1,
      audio: { relativePath: 'tone-36db.wav', sha256: createHash('sha256').update(wav).digest('hex'), durationMs: 20000 },
      sampleRate: 48000, frameRate: 30, positionMs: 0, startMs: 0, endMs: 20000, offsetMs: 480000, volume: 0 } });
  await socket.call('CreateScene', { sceneName: 'Audio B' });
  const target = engine.audioCaptureIdentity;
  await adapter.setInternalAudioCapture(true, target.executable, target.title, target.audioDeviceId, ['Audio', 'Audio B'], target.windowClass);
  const properties = await socket.call('GetInputPropertiesListPropertyItems', { inputName: '团播联动台·内部正式音频', propertyName: 'window' });
  report.identity = target;
  report.window = selectObsAudioWindow(properties.propertyItems, target.executable, target.title);
  assert.equal((await socket.call('GetInputSettings', { inputName: '团播联动台·内部正式音频' })).inputSettings.window, report.window);
  await socket.call('SetInputAudioMonitorType', { inputName: '团播联动台·内部正式音频', monitorType: 'OBS_MONITORING_TYPE_NONE' });
  await socket.call('SetInputAudioTracks', { inputName: '团播联动台·内部正式音频', inputAudioTracks: { '1': true } });
  await socket.call('SetInputMute', { inputName: '团播联动台·内部正式音频', inputMuted: false });
  await socket.call('SetInputVolume', { inputName: '团播联动台·内部正式音频', inputVolumeMul: 1 });
  const special = await socket.call('GetSpecialInputs');
  assert(!special.desktop1 && !special.desktop2, '验收环境意外启用桌面音频');
  socket.on('InputVolumeMeters', event => {
    for (const input of event.inputs) if (input.inputName === '团播联动台·内部正式音频') readings.push({ phase, at: Date.now(), levels: input.inputLevelsMul });
  });
  await engine.control({ ...envelope, generation: 2, kind: 'play' });
  phase = 'silent'; await sleep(1500);
  await engine.control({ ...envelope, generation: 2, kind: 'volume', volume: 1, durationMs: 1000 });
  phase = 'fade'; await sleep(1100);
  phase = 'tone'; await sleep(2000);
  const [inventory, screenshot] = await Promise.all([
    adapter.readInventory(), adapter.getSourceScreenshot('Audio', 270, 480),
    adapter.execute({ id: 'acceptance-scene', label: '隔离验收场景', kind: 'obs.setProgramScene', sceneName: 'Audio B' })
  ]);
  assert(inventory.scenes.includes('Audio B') && screenshot.startsWith('data:image/'));
  assert.equal((await socket.call('GetCurrentProgramScene')).currentProgramSceneName, 'Audio B');
  report.applicationObsAdapter = { inventory: true, preview: true, sceneSwitchConfirmed: true };
  phase = 'scene-switch'; await sleep(2000);
  await engine.control({ ...envelope, generation: 3, kind: 'pause' });
  await sleep(500); phase = 'paused'; await sleep(1000);
  const peak = label => Math.max(0, ...readings.filter(reading => reading.phase === label).flatMap(reading => reading.levels.flat()));
  report.peaks = Object.fromEntries(['silent', 'fade', 'tone', 'scene-switch', 'paused'].map(label => [label, peak(label)]));
  for (const label of ['silent', 'tone', 'scene-switch', 'paused']) assert(readings.some(reading => reading.phase === label && reading.levels.length), `缺少 ${label} OBS 采集数据（空数组不是静音）`);
  assert(peak('silent') < 0.0001 && peak('paused') < 0.0001, '静音或暂停后仍有采集信号');
  assert(peak('tone') > 0.005 && peak('scene-switch') > 0.005, 'OBS 没有收到原生音频');
  assert(readings.some(reading => reading.phase === 'fade' && reading.levels.flat().some(level => level > 0.001 && level < 0.01)), 'OBS 未收到淡入中间电平');
  report.productionAudioCaptureAdapter = true;
  assert.equal(failures.length, 0, '引擎通道发生错误');
  report.passed = true;
  }
} catch (error) { failures.push(String(error).replaceAll(password, '[redacted]')); process.exitCode = 1; }
finally {
  report.scenariosPassed = report.passed;
  report.passed = false;
  const cleanupFailures = [];
  const cleanup = async (label, operation) => {
    try { await operation(); }
    catch (error) { cleanupFailures.push(`${label}: ${String(error).replaceAll(password, '[redacted]')}`); }
  };
  await cleanup('原生播放器退出', () => engine.close());
  await cleanup('OBS 适配器断开', () => adapter.disconnect());
  let mayClose = false;
  if (connected) {
    await cleanup('核对隔离 OBS 输出', async () => {
      assert.equal((await socket.call('GetStreamStatus')).outputActive, false);
      assert.equal((await socket.call('GetRecordStatus')).outputActive, false);
      mayClose = true;
    });
    await cleanup('测试连接断开', () => socket.disconnect());
  }
  if (mayClose) await cleanup('隔离 OBS 正常退出', () => closeOwnedObsTest({ ...identity, executable }));
  else cleanupFailures.push('未能确认隔离 OBS 无推流和录像，保留进程');
  report.cleanupPassed = cleanupFailures.length === 0;
  failures.push(...cleanupFailures);
  report.passed = report.scenariosPassed && report.cleanupPassed && failures.length === 0;
  if (cleanupFailures.length) process.exitCode = 1;
  report.engineSha256 = createHash('sha256').update(await readFile(enginePath)).digest('hex');
  report.previewBridgeSha256 = createHash('sha256').update(await readFile(join(obsDirectory, 'obs-plugins/64bit/tblink-realtime-preview.dll'))).digest('hex');
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ directory, passed: report.passed, failures, peaks: report.peaks }, null, 2));
}
