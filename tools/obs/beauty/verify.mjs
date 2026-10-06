import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { closeOwnedObsTest } from '../../../scripts/close-owned-obs-test.mjs';
import { verifyLive } from './verify-live.mjs';
import { verifyBodyLive } from './verify-body-live.mjs';
import { verifyBodyDirection } from './verify-body-direction.mjs';
import { verifyShaping } from './verify-shaping.mjs';
import { verifyShapeDirection } from './verify-shape-direction.mjs';
import { fixtureMesh } from './fixture-mesh.mjs';
import { verifyManagedRuntime } from './verify-managed-runtime.mjs';
import { verifyComparison } from './verify-comparison.mjs';
import { verifyBeautyDistribution } from './distribution.mjs';
import { verifyPerformance } from './verify-performance.mjs';
import { verifyDesktop } from './verify-desktop.mjs';
import { verifyVideo } from './verify-video.mjs';
import { verifyProposals } from './verify-proposals.mjs';
import { verifyProfileSkin } from './verify-profile-skin.mjs';
import { verifyBodyReal } from './verify-body-real.mjs';
import { verifyGlobalOutput } from './verify-global-output.mjs';
import { verifySemantic } from './verify-semantic.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(join(root, 'apps/desktop/package.json'));
const { OBSWebSocket } = require('obs-websocket-js');
// Reuse the lockfile-pinned test dependency without modifying the application.
const { PNG } = require(join(root, 'node_modules/.pnpm/pngjs@5.0.0/node_modules/pngjs'));
const [installation, imageFile, regionsFile, mode] = process.argv.slice(2);
if (process.platform !== 'win32' || !installation || Boolean(imageFile) !== Boolean(regionsFile)) {
  throw new Error('Usage: node tools/obs/beauty/verify.mjs <OBS directory> [static image] [regions JSON]');
}
const work = join(root, 'artifacts/beauty-prototype');
const resourcesArgument = process.argv.find(argument => argument.startsWith('--resources='));
const resources = resourcesArgument ? resolve(resourcesArgument.slice('--resources='.length)) : work;
const desktopArgument = process.argv.find(argument => argument.startsWith('--desktop-executable='));
const desktopExecutable = desktopArgument ? resolve(desktopArgument.slice('--desktop-executable='.length)) : undefined;
const videoArgument = process.argv.find(argument => argument.startsWith('--motion-video='));
const motionVideo = videoArgument ? resolve(videoArgument.slice('--motion-video='.length)) : undefined;
if (process.argv.includes('--proposal-test') && !motionVideo) throw new Error('Experimental proposal test requires --motion-video');
if (process.argv.includes('--proposal-frozen') && !process.argv.includes('--proposal-test')) throw new Error('--proposal-frozen requires --proposal-test');
if (process.argv.includes('--proposal-portrait') && !process.argv.includes('--proposal-test')) throw new Error('--proposal-portrait requires --proposal-test');
if (process.argv.includes('--proposal-semantic') && !process.argv.includes('--proposal-test')) throw new Error('--proposal-semantic requires --proposal-test');
if (process.argv.includes('--proposal-directml') && !process.argv.includes('--proposal-test')) throw new Error('--proposal-directml requires a proposal test');
if (process.argv.includes('--proposal-profile-skin') && !process.argv.includes('--proposal-semantic')) throw new Error('--proposal-profile-skin requires --proposal-semantic');
if (process.argv.includes('--proposal-combined') && !process.argv.includes('--proposal-semantic')) throw new Error('--proposal-combined requires --proposal-semantic');
if (process.argv.includes('--semantic-directml') && !process.argv.includes('--proposal-semantic')) throw new Error('--semantic-directml requires a semantic proposal test');
const proposalSecondsArgument = process.argv.find(argument => argument.startsWith('--proposal-seconds='));
const proposalSeconds = proposalSecondsArgument ? Number(proposalSecondsArgument.slice('--proposal-seconds='.length)) : 30;
if (proposalSecondsArgument && !process.argv.includes('--proposal-test')) throw new Error('--proposal-seconds requires --proposal-test');
if (!Number.isInteger(proposalSeconds) || proposalSeconds < 30 || proposalSeconds > 600) throw new Error('Proposal duration must be 30..600 seconds');
if (desktopExecutable && (!resourcesArgument || !process.argv.includes('--desktop-test'))) throw new Error('Packaged desktop verification requires --resources and --desktop-test');
if (desktopExecutable && resources.toLowerCase() !== resolve(dirname(desktopExecutable), 'resources/beauty').toLowerCase()) throw new Error('Packaged desktop and beauty resources must come from the same application directory');
if (resourcesArgument) {
  if (!process.argv.includes('--frozen')) throw new Error('安装包资源验证必须使用 --frozen');
  await verifyBeautyDistribution(join(root, 'tools/obs/beauty'), work, resources);
}
const directory = await mkdtemp(join(work, 'acceptance-'));
const obsDirectory = join(directory, 'obs');
const plugin = join(resources, 'plugin');
for (const folder of ['bin', 'data', 'obs-plugins']) {
  await cp(join(resolve(installation), folder), join(obsDirectory, folder), { recursive: true });
}
await cp(join(plugin, 'tblink-beauty.dll'), join(obsDirectory, 'obs-plugins/64bit/tblink-beauty.dll'));
if (process.argv.includes('--desktop-test')) {
  const bridge = desktopExecutable ? join(dirname(desktopExecutable), 'resources/obs/tblink-realtime-preview.dll') : join(root, 'tools/obs/native-preview/tblink-realtime-preview.dll');
  await cp(bridge, join(obsDirectory, 'obs-plugins/64bit/tblink-realtime-preview.dll'));
  const installed = join(directory, 'desktop-system-data/obs-studio/plugins/tblink-realtime-preview/bin/64bit');
  await mkdir(installed, { recursive: true });
  await cp(bridge, join(installed, 'tblink-realtime-preview.dll'));
}
await mkdir(join(obsDirectory, 'data/obs-plugins/tblink-beauty'), { recursive: true });
await cp(join(plugin, 'beauty.effect'), join(obsDirectory, 'data/obs-plugins/tblink-beauty/beauty.effect'));
const config = join(obsDirectory, 'config/obs-studio');
for (const folder of ['basic/profiles/Beauty', 'basic/scenes', 'plugin_config/obs-websocket']) await mkdir(join(config, folder), { recursive: true });
const global = '[General]\nFirstRun=false\nPre19Defaults=false\nLastVersion=537001986\nEnableAutoUpdates=false\n[Basic]\nProfile=Beauty\nProfileDir=Beauty\nSceneCollection=Beauty\nSceneCollectionFile=Beauty\n';
await writeFile(join(config, 'global.ini'), global);
await writeFile(join(config, 'user.ini'), global + '[BasicWindow]\nPreviewEnabled=true\nSysTrayEnabled=false\n');
await writeFile(join(config, 'basic/profiles/Beauty/basic.ini'), '[General]\nName=Beauty\n[Video]\nBaseCX=640\nBaseCY=360\nOutputCX=640\nOutputCY=360\nFPSType=0\nFPSCommon=30\n[Output]\nMode=Simple\n');
await writeFile(join(config, 'basic/scenes/Beauty.json'), JSON.stringify({ name: 'Beauty', current_scene: 'Beauty', current_program_scene: 'Beauty', sources: [{ name: 'Beauty', id: 'scene', settings: { items: [] } }], scene_order: [{ name: 'Beauty' }], version: 2 }));
const port = 30000 + Math.floor(Math.random() * 15000), password = randomUUID();
await writeFile(join(config, 'plugin_config/obs-websocket/config.json'), JSON.stringify({ alerts_enabled: false, auth_required: true, first_load: false, server_enabled: true, server_password: password, server_port: port }));
const ps = script => promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);" + script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000 });
const quote = value => `'${value.replaceAll("'", "''")}'`;
const executable = join(obsDirectory, 'bin/64bit/obs64.exe');
const launch = await ps(`$p=Start-Process -FilePath ${quote(executable)} -WorkingDirectory ${quote(dirname(executable))} -ArgumentList @('--portable','--multi','--unfiltered_log','--disable-updater','--disable-missing-files-check') -WindowStyle Hidden -PassThru; @{pid=$p.Id;started=$p.StartTime.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress`);
const identity = { ...JSON.parse(launch.stdout.replace(/^\uFEFF/, '')), executable };
await writeFile(join(directory, 'owned-process.json'), JSON.stringify(identity));
const socket = new OBSWebSocket();
let connected = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function call(type, data) {
  let timeout;
  try {
    return await Promise.race([socket.call(type, data), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`${type}: 2s timeout`)), 2000); })]);
  } finally { clearTimeout(timeout); }
}
async function screenshot(name, sourceName = 'Fixture') {
  await sleep(200);
  const response = await call('GetSourceScreenshot', { sourceName, imageFormat: 'png' });
  const buffer = Buffer.from(response.imageData.split(',')[1], 'base64');
  await writeFile(join(directory, `${name}.png`), buffer);
  return PNG.sync.read(buffer);
}
function difference(a, b, inside = () => true) {
  assert.equal(a.width, b.width); assert.equal(a.height, b.height);
  let sum = 0, pixels = 0;
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    if (!inside(x / a.width, y / a.height)) continue;
    const offset = (y * a.width + x) * 4;
    for (let c = 0; c < 3; c++) sum += Math.abs(a.data[offset+c] - b.data[offset+c]);
    pixels++;
  }
  return pixels ? sum / (pixels * 3) : 0;
}
let report = { passed: false, scope: 'Static GPU prototype; NOT live tracking, body, production performance or app acceptance' };
const failures = [];
try {
  const deadline = Date.now() + 30000;
  let started = false;
  while (Date.now() < deadline && !started) {
    const files = await readdir(join(config, 'logs')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const file of files) {
      const log = await readFile(join(config, 'logs', file), 'utf8');
      if (log.includes('Startup complete') && log.includes("- scene 'Beauty':")) started = true;
    }
    if (!started) await sleep(250);
  }
  assert(started, 'Isolated OBS did not start');
  await socket.connect(`ws://127.0.0.1:${port}`, password); connected = true;
  let packet, fixture;
  if (imageFile) {
    fixture = resolve(imageFile); packet = JSON.parse(await readFile(resolve(regionsFile), 'utf8'));
  } else {
    packet = { version: 3, mode: 'static-fixture', faces: [0.28, 0.72].map(cx => ({ cx, cy: 0.5, rx: 0.16, ry: 0.36,
      lx: cx - 0.055, ly: 0.42, ex: cx + 0.055, ey: 0.42, smooth: 0.8, white: 0.8, slim: 0.8, eye: 0.8,
      ...fixtureMesh({ 1: [cx, .51], 98: [cx-.025, .52], 327: [cx+.025, .52],
        61: [cx-.05, .64], 291: [cx+.05, .64], 0: [cx, .625], 17: [cx, .655], 13: [cx, .635], 14: [cx, .645],
        152: [cx, .78], 10: [cx, .2] }, [cx, .5], [cx-.055, .42, cx+.055, .42]) })) };
    const png = new PNG({ width: 640, height: 360 });
    for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
      let rgb = [30 + (x % 32 < 2 ? 30 : 0), 45, 65];
      for (const face of packet.faces) {
        const u = x/png.width, v = y/png.height;
        if (((u-face.cx)/(face.rx*0.82))**2 + ((v-face.cy)/(face.ry*0.90))**2 < 1) {
          const grain = ((x*17 + y*13) % 19) - 9;
          rgb = [200+grain, 150+grain, 115+grain];
          if (((u-face.lx)/0.028)**2 + ((v-face.ly)/0.025)**2 < 1 || ((u-face.ex)/0.028)**2 + ((v-face.ey)/0.025)**2 < 1) rgb = [30, 25, 20];
          if (Math.abs(u-face.cx) < 0.05 && Math.abs(v-0.64) < 0.01) rgb = [120, 45, 50];
        }
      }
      const offset = (y*png.width+x)*4;
      png.data.set([...rgb, 255], offset);
    }
    fixture = join(directory, 'fixture.png'); await writeFile(fixture, PNG.sync.write(png));
  }
  assert(packet.faces.length >= 2, 'Multi-region verification requires two faces');
  await call('CreateInput', { sceneName: 'Beauty', inputName: 'Fixture', inputKind: 'image_source', inputSettings: { file: fixture, unload: false }, sceneItemEnabled: true });
  const baseline = await screenshot('original');
  await call('CreateSourceFilter', { sourceName: 'Fixture', filterName: 'Beauty probe', filterKind: 'tblink_beauty_prototype', filterSettings: { fixture_json: JSON.stringify(packet) } });
  const processed = await screenshot('processed');
  const changed = difference(baseline, processed);
  assert(changed > 0.1, `GPU filter did not change pixels (${changed})`);
  const outside = (x, y) => packet.faces.every(f => ((x-f.cx)/f.rx)**2 + ((y-f.cy)/f.ry)**2 > 1.05);
  const background = difference(baseline, processed, outside);
  assert(background < 0.05, `Background changed outside face regions: ${background}`);
  const individualEffects = {};
  for (const key of ['smooth', 'white', 'slim', 'eye']) {
    const only = structuredClone(packet);
    for (const face of only.faces) for (const control of ['smooth', 'white', 'slim', 'eye']) face[control] = control === key ? 1 : 0;
    await call('SetSourceFilterSettings', { sourceName: 'Fixture', filterName: 'Beauty probe', filterSettings: { fixture_json: JSON.stringify(only) } });
    individualEffects[key] = difference(baseline, await screenshot(`only-${key}`));
    assert(individualEffects[key] > 0.01, `${key} did not independently affect pixels`);
  }
  const single = structuredClone(packet);
  for (const f of single.faces.slice(1)) for (const key of ['smooth', 'white', 'slim', 'eye']) f[key] = 0;
  await call('SetSourceFilterSettings', { sourceName: 'Fixture', filterName: 'Beauty probe', filterSettings: { fixture_json: JSON.stringify(single) } });
  const independent = await screenshot('independent');
  const second = packet.faces[1];
  const secondDifference = difference(baseline, independent, (x, y) => ((x-second.cx)/second.rx)**2 + ((y-second.cy)/second.ry)**2 < 0.5);
  assert(secondDifference < 0.05, `Unselected person changed: ${secondDifference}`);
  const uniformTarget = { sourceName: 'Fixture', filterName: 'Beauty probe' };
  const contract = await call('GetSourceFilter', uniformTarget);
  assert.equal(contract.filterSettings.controls_version, 14, 'Uniform UI contract missing');
  await call('SetSourceFilterSettings', { ...uniformTarget, filterSettings: { uniform_controls: true, smooth: 0, white: 0, slim: 0, eye: 0 } });
  assert.equal(difference(baseline, await screenshot('uniform-zero')), 0, 'Zero uniform controls must restore original pixels');
  await call('SetSourceFilterSettings', { ...uniformTarget, filterSettings: { uniform_controls: true, smooth: .5, white: .4, slim: .3, eye: .2 } });
  const uniformImage = await screenshot('uniform-all-faces');
  const uniformDifferences = packet.faces.map(face => difference(baseline, uniformImage, (x, y) => ((x-face.cx)/face.rx)**2 + ((y-face.cy)/face.ry)**2 < .5));
  assert(uniformDifferences.every(value => value > .01), 'Uniform controls must apply to every detected face');
  const colorEffects = {};
  for (const key of ['exposure', 'contrast', 'saturation', 'temperature', 'sharpen']) {
    for (const strength of (key === 'sharpen' ? [1] : [-1, 1])) {
      await call('SetSourceFilterSettings', { ...uniformTarget, filterSettings: {
        uniform_controls: true, smooth: 0, white: 0, slim: 0, eye: 0,
        exposure: 0, contrast: 0, saturation: 0, temperature: 0, sharpen: 0, [key]: strength } });
      colorEffects[`${key}:${strength}`] = difference(baseline, await screenshot(`color-${key}-${strength}`));
      assert(colorEffects[`${key}:${strength}`] > .01, `${key} ${strength} did not affect pixels`);
    }
  }
  await call('SetSourceFilterSettings', { ...uniformTarget, filterSettings: { exposure: 0, contrast: 0, saturation: 0, temperature: 0, sharpen: 0 } });
  assert.equal(difference(baseline, await screenshot('color-reset')), 0, 'Color reset must restore original pixels');
  const skinEffects = {};
  for (const key of ['evenSkin', 'shine']) {
    await call('SetSourceFilterSettings', { ...uniformTarget, filterSettings: { texture: 0, evenSkin: 0, shine: 0, [key]: 1 } });
    const image = await screenshot(`skin-${key}`);
    skinEffects[key] = difference(baseline, image);
    assert(skinEffects[key] > .001, `${key} did not affect pixels`);
    assert.equal(difference(baseline, image, outside), 0, `${key} changed background`);
  }
  await call('SetSourceFilterSettings', { ...uniformTarget, filterSettings: { smooth: 1, texture: 0, evenSkin: 0, shine: 0 } });
  skinEffects.smoothed = difference(baseline, await screenshot('texture-zero'));
  await call('SetSourceFilterSettings', { ...uniformTarget, filterSettings: { texture: 1 } });
  skinEffects.preserved = difference(baseline, await screenshot('texture-one'));
  assert(skinEffects.preserved < skinEffects.smoothed * .5, 'Texture retention must preserve more original detail');
  await call('SetSourceFilterSettings', { ...uniformTarget, filterSettings: { smooth: 0, texture: 0, evenSkin: 0, shine: 0 } });
  assert.equal(difference(baseline, await screenshot('skin-reset')), 0, 'Skin reset must restore original pixels');
  await call('SetSourceFilterSettings', { ...uniformTarget, filterSettings: { smooth: 1, white: 1, evenSkin: 1, shine: 1 } });
  const protectedImage = await screenshot('protected-lips');
  let lipPixels = 0;
  const protectedLips = difference(baseline, protectedImage, (x, y) => {
    const inside = packet.faces.some(f => {
      const cx = (f.p61x + f.p291x + f.p0x + f.p17x) / 4;
      const cy = (f.p61y + f.p291y + f.p0y + f.p17y) / 4;
      const rx = Math.max(Math.abs(f.p291x - f.p61x) * .62 + Math.abs(f.p17x - f.p0x) * .7, 2 / baseline.width);
      const ry = Math.max(Math.abs(f.p291y - f.p61y) * .62 + Math.abs(f.p17y - f.p0y) * .7, 2 / baseline.height);
      return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 < .04;
    });
    if (inside) lipPixels++;
    return inside;
  });
  assert(lipPixels > 0, 'Lip protection test did not sample any pixels');
  assert.equal(protectedLips, 0, 'Skin processing changed the core lip region');
  await call('SetSourceFilterSettings', { ...uniformTarget, filterSettings: { smooth: 0, white: 0, evenSkin: 0, shine: 0 } });
  const shapingEffects = await verifyShaping({ call, target: uniformTarget, packet, baseline, screenshot, difference });
  const shapingDirections = await verifyShapeDirection({ call, screenshot, directory, PNG });
  await call('SetSourceFilterSettings', { ...uniformTarget, filterSettings: { uniform_controls: false } });
  await call('SetSourceFilterEnabled', { sourceName: 'Fixture', filterName: 'Beauty probe', filterEnabled: false });
  const disabled = difference(baseline, await screenshot('disabled'));
  assert.equal(disabled, 0, 'Disabling must restore original pixels');
  await call('SetSourceFilterEnabled', { sourceName: 'Fixture', filterName: 'Beauty probe', filterEnabled: true });
  const invalidPackets = ['{broken', JSON.stringify({ ...packet, mode: 'live' }), JSON.stringify({ ...packet, faces: Array(7).fill(packet.faces[0]) }),
    JSON.stringify({ ...packet, faces: [{ ...packet.faces[0], slim: '0.5' }] })];
  for (const [index, invalid] of invalidPackets.entries()) {
    await call('SetSourceFilterSettings', { sourceName: 'Fixture', filterName: 'Beauty probe', filterSettings: { fixture_json: invalid } });
    assert.equal(difference(baseline, await screenshot(`invalid-${index}`)), 0, 'Invalid fixture must clear prior warp');
  }
  const modules = (await ps(`(Get-Process -Id ${identity.pid}).Modules | Where-Object {$_.ModuleName -eq 'tblink-beauty.dll'} | ForEach-Object {$_.FileName}`)).stdout.trim();
  assert.equal(modules.toLowerCase(), join(obsDirectory, 'obs-plugins/64bit/tblink-beauty.dll').toLowerCase());
  if (process.argv.includes('--desktop-test')) {
    const bridge = (await ps(`(Get-Process -Id ${identity.pid}).Modules | Where-Object {$_.ModuleName -eq 'tblink-realtime-preview.dll'} | ForEach-Object {$_.FileName}`)).stdout.trim();
    assert.equal(bridge.toLowerCase(), join(obsDirectory, 'obs-plugins/64bit/tblink-realtime-preview.dll').toLowerCase(), 'Desktop test must use its isolated preview bridge');
  }
  const live = mode === '--live' ? await verifyLive({ work: resources, root, directory, call, screenshot, difference, baseline }) : null;
  let motion = null;
  if (mode === '--live') {
    const ffmpeg = require('ffmpeg-static');
    const video = join(directory, 'motion.mp4');
    await promisify(execFile)(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-threads', '2', '-filter_complex_threads', '1', '-n',
      '-f', 'lavfi', '-i', 'color=c=0x202f40:s=640x360:r=30', '-loop', '1', '-i', fixture,
      '-filter_complex', '[1:v]scale=480:-2[faces];[0:v][faces]overlay=x=80+60*sin(2*PI*t/3):y=80:shortest=1',
      '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video], { windowsHide: true, timeout: 30000 });
    await call('RemoveInput', { inputName: 'Fixture' });
    await call('CreateInput', { sceneName: 'Beauty', inputName: 'Motion fixture', inputKind: 'ffmpeg_source',
      inputSettings: { local_file: video, is_local_file: true, looping: true, close_when_inactive: false }, sceneItemEnabled: true });
    await call('CreateSourceFilter', { sourceName: 'Motion fixture', filterName: 'Beauty probe', filterKind: 'tblink_beauty_prototype', filterSettings: { live_mode: true } });
    motion = await verifyLive({ work: resources, root, directory, call, screenshot: name => screenshot(name, 'Motion fixture'), difference, baseline, moving: true, inputName: 'Motion fixture' });
  }
  const body = process.argv.includes('--body-test') ? await verifyBodyLive({work,resources,root,directory,call,screenshot,difference}) : null;
  if (body) body.directions = await verifyBodyDirection({work,root,directory,call,screenshot,PNG});
  const managedRuntime = mode === '--live' && process.argv.includes('--managed-test') ? await verifyManagedRuntime({root,work: resources,directory,call}) : null;
  const comparison = await verifyComparison({root,call,screenshot,directory,PNG,packet});
  if (process.argv.includes('--global-beauty-test')) report.globalBeauty = await verifyGlobalOutput({root,directory,fixture,executable,port,password,call,screenshot,difference});
  if (process.argv.includes('--profile-skin-test')) report.profileSkin = await verifyProfileSkin({work,directory,call,screenshot,difference,PNG});
  if (process.argv.includes('--body-real-test')) report.bodyReal = await verifyBodyReal({work,directory,call,screenshot,difference,PNG});
  if (process.argv.includes('--body-instance-test')) report.bodyInstance = await verifyBodyReal({work,directory,call,screenshot,difference,PNG,instanceProtection:true,instanceHybrid:process.argv.includes('--instance-hybrid'),instanceRtmdet:process.argv.includes('--instance-rtmdet'),bodyOnDemand:process.argv.includes('--body-demand')});
  if (process.argv.includes('--semantic-gating-test')) report.semanticGating = await verifySemantic({root,work,directory,fixture,packet,call,screenshot,difference});
  const realVideo = motionVideo ? await verifyVideo({root,resources,directory,video:motionVideo,call,PNG}) : null;
  const experimentalProposals = process.argv.includes('--proposal-test') ? await verifyProposals({root,work,directory,video:motionVideo,call,PNG,frozen:process.argv.includes('--proposal-frozen'),seconds:proposalSeconds,portrait:process.argv.includes('--proposal-portrait'),semantic:process.argv.includes('--proposal-semantic'),directml:process.argv.includes('--proposal-directml'),semanticDirectml:process.argv.includes('--semantic-directml'),semanticProbability:process.argv.includes('--semantic-probability'),combined:process.argv.includes('--proposal-combined'),profileSkin:process.argv.includes('--proposal-profile-skin'),instanceProtection:process.argv.includes('--proposal-instance-protection'),instanceHybrid:process.argv.includes('--instance-hybrid'),instanceRtmdet:process.argv.includes('--instance-rtmdet'),gpuFifo:process.argv.includes('--gpu-fifo'),warmupModels:process.argv.includes('--warmup-models'),bodyOnDemand:process.argv.includes('--body-demand')}) : null;
  const performance = process.argv.includes('--performance-test') ? await verifyPerformance({root,resources,directory,fixture,call,screenshot}) : null;
  const desktop = process.argv.includes('--desktop-test') ? await verifyDesktop({root,directory,fixture,faces:packet.faces,executable,desktopExecutable,port,password,call,screenshot,difference}) : null;
  report = { ...report, desktop, performance, realVideo, experimentalProposals, resources, packagedResources: Boolean(resourcesArgument), body, managedRuntime, comparison, scope: mode === '--live' ? 'Static effects plus live pre-filter analysis and synthetic motion; NOT identity/body/production acceptance' : report.scope,
    passed: true, changed, background, individualEffects, colorEffects, skinEffects, shapingEffects, shapingDirections, protectedLips, lipPixels, secondDifference, uniformDifferences, disabled, invalidCases: invalidPackets.length, plugin: modules, fixture, faces: packet.faces.length, live, motion };
  console.log(JSON.stringify({ directory, ...report }, null, 2));
} catch (error) {
  report.error = String(error); failures.push(error);
} finally {
  try {
    if (connected) {
      const stream = await call('GetStreamStatus'), record = await call('GetRecordStatus');
      assert(!stream.outputActive && !record.outputActive, 'Output active; isolated process retained');
      await socket.disconnect();
      await closeOwnedObsTest(identity);
    } else {
      console.error(`No verified connection: process retained for inspection (${identity.pid}), ${directory}`);
    }
  } catch (error) {
    failures.push(error); report.cleanupError = String(error);
  } finally {
    if (failures.length) report.passed = false;
    await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2));
  }
}
if (failures.length) throw new AggregateError(failures, `Beauty verification failed; evidence: ${directory}`);
