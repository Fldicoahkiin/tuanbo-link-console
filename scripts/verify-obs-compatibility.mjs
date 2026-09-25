import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { release } from 'node:os';
import { measureDesktopResources } from './measure-desktop-resources.mjs';

// Real OBS processes, real Electron IPC, real Windows safeStorage. No user profile is read.
const require = createRequire(resolve('apps/desktop/package.json'));
const { _electron: electron, expect } = require('@playwright/test');
const { OBSWebSocket } = require('obs-websocket-js');
const [source, label, packaged] = process.argv.slice(2);
if (!source || !label || process.platform !== 'win32') throw new Error('Usage: node scripts/verify-obs-compatibility.mjs <OBS directory> <version> [packaged exe]');
const root = resolve('artifacts/obs-compatibility');
await mkdir(root, { recursive: true });
const directory = await mkdtemp(join(root, `run-${label}-`));
const obsDirectory = join(directory, 'obs');
for (const name of ['bin', 'data', 'obs-plugins']) await cp(join(resolve(source), name), join(obsDirectory, name), { recursive: true });
const plugin = join(obsDirectory, 'obs-plugins/64bit/tblink-realtime-preview.dll');
await cp(resolve('tools/obs/native-preview/tblink-realtime-preview.dll'), plugin);
const config = join(obsDirectory, 'config/obs-studio');
for (const name of ['basic/profiles/Compatibility', 'basic/scenes', 'plugin_config/obs-websocket']) await mkdir(join(config, name), { recursive: true });
const globalConfig = '[General]\nFirstRun=false\nLastVersion=537001986\nEnableAutoUpdates=false\n[Basic]\nProfile=Compatibility\nProfileDir=Compatibility\nSceneCollection=Compatibility\nSceneCollectionFile=Compatibility\n';
await writeFile(join(config, 'global.ini'), globalConfig);
await writeFile(join(config, 'user.ini'), globalConfig + '\n[BasicWindow]\nPreviewEnabled=true\nSysTrayEnabled=false\n');
const resourceRun = process.env.TBLINK_MEASURE_RESOURCES === '1';
const canvasWidth = resourceRun ? 1920 : 640, canvasHeight = resourceRun ? 1080 : 360;
await writeFile(join(config, 'basic/profiles/Compatibility/basic.ini'), `[General]\nName=Compatibility\n[Video]\nBaseCX=${canvasWidth}\nBaseCY=${canvasHeight}\nOutputCX=${canvasWidth}\nOutputCY=${canvasHeight}\nFPSType=0\nFPSCommon=${resourceRun ? 60 : 30}\n[Output]\nMode=Simple\n`);
await writeFile(join(config, 'basic/scenes/Compatibility.json'), JSON.stringify({ name: 'Compatibility', current_scene: 'Compatibility', current_program_scene: 'Compatibility', sources: [{ name: 'Compatibility', id: 'scene', settings: { items: [] } }], scene_order: [{ name: 'Compatibility' }], version: 2 }));
const password = `兼容性 ' $ ${randomUUID()}`;
const port = 30000 + Math.floor(Math.random() * 15000);
await writeFile(join(config, 'plugin_config/obs-websocket/config.json'), JSON.stringify({ alerts_enabled: false, auth_required: true, first_load: false, server_enabled: true, server_password: password, server_port: port }));
const url = `ws://127.0.0.1:${port}`;
const ps = async (script) => promisify(execFile)(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);" + script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const executable = join(obsDirectory, 'bin/64bit/obs64.exe');
const launched = await ps(`$p=Start-Process -FilePath ${quote(executable)} -WorkingDirectory ${quote(join(obsDirectory, 'bin/64bit'))} -ArgumentList @('--portable','--multi','--disable-updater','--disable-missing-files-check') -WindowStyle Hidden -PassThru; @{pid=$p.Id;started=$p.StartTime.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress`);
const identity = JSON.parse(launched.stdout.replace(/^\uFEFF/, ''));
await writeFile(join(directory, 'owned-process.json'), JSON.stringify({ ...identity, executable }, null, 2));
const results = [];
const observer = new OBSWebSocket();
let app;
let runtimeVersion = null;
const check = async (name, action) => {
  try { const detail = await action(); results.push({ name, passed: true, detail }); }
  catch (error) { results.push({ name, passed: false, error: String(error).replaceAll(password, '[redacted]') }); }
  console.log(JSON.stringify(results.at(-1)));
};
const launchApp = () => electron.launch({
  ...(packaged ? { executablePath: resolve(packaged) } : {}),
  args: [`--user-data-dir=${join(directory, 'app-profile')}`, ...(packaged ? [] : [resolve('apps/desktop')])],
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => !['path', 'electron_run_as_node'].includes(key.toLowerCase()) && typeof value === 'string')), ProgramData: join(directory, 'program-data') }
});
try {
  const deadline = Date.now() + 30000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    const logs = await readdir(join(config, 'logs')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const file of logs) {
      const log = await readFile(join(config, 'logs', file), 'utf8');
      if (log.includes('Startup complete') && log.includes('Loaded scenes:')) ready = true;
    }
    if (!ready) await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert(ready, 'OBS startup timed out');
  await observer.connect(url, password);
  // OBS logs scene loading before its frontend request gate opens (207).
  // Wait for the test fixture, not by retrying any application action.
  const readyDeadline = Date.now() + 10000;
  let version;
  while (!version && Date.now() < readyDeadline) {
    try { version = await observer.call('GetVersion'); }
    catch (error) { if (error.code !== 207) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert(version, 'OBS WebSocket frontend did not become ready');
  assert.equal(version.obsVersion, label);
  runtimeVersion = { obs: version.obsVersion, websocket: version.obsWebSocketVersion, windows: release(), architecture: process.arch };
  console.log(JSON.stringify({ directory, version: version.obsVersion, websocket: version.obsWebSocketVersion }));
  await check('原生插件确实从隔离 OBS 目录加载', async () => {
    const modules = await ps(`(Get-Process -Id ${identity.pid}).Modules | Where-Object {$_.ModuleName -eq 'tblink-realtime-preview.dll'} | ForEach-Object {$_.FileName}`);
    assert.equal(resolve(modules.stdout.trim()).toLowerCase(), plugin.toLowerCase());
  });
  app = await launchApp();
  let page = await app.firstWindow();
  await page.getByRole('button', { name: '新建工程', exact: true }).click();
  await page.getByLabel('工程名称').fill(`OBS ${label} 兼容验收`);
  await page.getByRole('button', { name: '创建工程', exact: true }).click();
  await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '设备连接', exact: true }).click();
  const panel = page.getByRole('region', { name: 'OBS 连接设置', exact: true });
  await panel.getByLabel('WebSocket 地址').fill(url);
  await check('错误密码明确拒绝', async () => {
    await panel.getByLabel('OBS 密码').fill('intentionally-wrong');
    await panel.getByRole('button', { name: '保存并连接 OBS', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('Authentication failed');
  });
  await check('改正密码后通过真实设置表单连接', async () => {
    await panel.getByLabel('OBS 密码').fill(password);
    await panel.getByRole('button', { name: '保存并连接 OBS', exact: true }).click();
    await expect(panel.getByRole('button', { name: '断开 OBS', exact: true })).toBeVisible({ timeout: 25000 });
    await expect(panel.getByRole('alert')).toHaveCount(0);
    assert.equal((await page.evaluate(() => globalThis.tbLink.getObsSnapshot())).status, 'connected');
  });
  await check('读取实际场景与原生画布', async () => {
    const inventory = await page.evaluate(() => globalThis.tbLink.readObsInventory());
    assert(inventory.scenes.includes('Compatibility'));
    return { scenes: inventory.scenes.length, video: inventory.videoSettings };
  });
  await check('场景切换与来源变换双向同步', async () => {
    await observer.call('CreateScene', { sceneName: 'Compatibility B' });
    const created = await observer.call('CreateInput', { sceneName: 'Compatibility B', inputName: 'Compatibility Color', inputKind: 'color_source_v3', inputSettings: { color: 4278190335, width: 320, height: 180 }, sceneItemEnabled: true });
    await page.evaluate(() => globalThis.tbLink.executeObsAction({ id: 'compat-scene', label: '兼容测试切场景', kind: 'obs.setProgramScene', sceneName: 'Compatibility B' }));
    assert.equal((await observer.call('GetCurrentProgramScene')).sceneName, 'Compatibility B');
    await page.evaluate(sceneItemId => globalThis.tbLink.editObsLiveScene({ sceneName: 'Compatibility B', sceneItemId, transform: { positionX: 24, positionY: 32, scaleX: 0.5, scaleY: 0.5, cropLeft: 8 }, enabled: false }), created.sceneItemId);
    const changed = await observer.call('GetSceneItemTransform', { sceneName: 'Compatibility B', sceneItemId: created.sceneItemId });
    assert.equal(changed.sceneItemTransform.positionX, 24);
    assert.equal(changed.sceneItemTransform.cropLeft, 8);
    assert.equal((await observer.call('GetSceneItemEnabled', { sceneName: 'Compatibility B', sceneItemId: created.sceneItemId })).sceneItemEnabled, false);
    await observer.call('SetSceneItemTransform', { sceneName: 'Compatibility B', sceneItemId: created.sceneItemId, sceneItemTransform: { positionX: 60 } });
    const readback = await page.evaluate(() => globalThis.tbLink.readObsLiveScene());
    assert.equal(readback.items.find(item => item.sceneItemId === created.sceneItemId).sceneItemTransform.positionX, 60);
    await page.evaluate(() => globalThis.tbLink.executeObsAction({ id: 'compat-return', label: '兼容测试恢复场景', kind: 'obs.setProgramScene', sceneName: 'Compatibility' }));
  });
  await check('联动台应用音频来源接入与停用', async () => {
    await page.evaluate(() => globalThis.tbLink.setInternalAudioCapture(true, ['Compatibility']));
    const inputs = await observer.call('GetInputList');
    assert(inputs.inputs.some(input => input.inputKind === 'wasapi_process_output_capture'));
    await page.evaluate(() => globalThis.tbLink.setInternalAudioCapture(false));
  });
  await check('原生预览真实视频帧', async () => {
    const frame = await page.evaluate(async () => {
      const frame = await globalThis.tbLink.getObsLiveFrame();
      await globalThis.tbLink.closeObsLivePreview();
      return { width: frame.width, height: frame.height, bytes: frame.rgba.byteLength };
    });
    const width = resourceRun ? 960 : 640, height = resourceRun ? 540 : 360;
    assert.deepEqual(frame, { width, height, bytes: width * height * 4 });
    return frame;
  });
  await check('重复连接同一 OBS', async () => {
    for (let i = 0; i < 3; i++) assert.equal((await page.evaluate(() => globalThis.tbLink.connectObs())).status, 'connected');
  });
  await check('系统组件不可用不影响已正确认证的 WebSocket 连接', async () => {
    const original = await app.evaluate(() => Object.entries(process.env).filter(([key]) => key.toLowerCase() === 'systemroot'));
    try {
      await app.evaluate(() => { process.env.SystemRoot = 'Z:\\missing-windows-components'; });
      assert.equal((await page.evaluate(() => globalThis.tbLink.connectObs())).status, 'connected');
    } finally {
      await app.evaluate(entries => {
        for (const key of Object.keys(process.env)) if (key.toLowerCase() === 'systemroot') delete process.env[key];
        for (const [key, value] of entries) if (value !== undefined) process.env[key] = value;
      }, original);
      assert.deepEqual(await app.evaluate(() => Object.entries(process.env).filter(([key]) => key.toLowerCase() === 'systemroot')), original);
    }
  });
  if (resourceRun) {
    const motion = join(root, 'resource-motion.mp4');
    try { await readFile(motion); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await promisify(execFile)(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=60', '-t', '10', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-n', motion], { windowsHide: true, timeout: 60000 });
    }
    await observer.call('CreateInput', { sceneName: 'Compatibility', inputName: 'Resource Motion', inputKind: 'ffmpeg_source', inputSettings: { local_file: motion, is_local_file: true, looping: true, hw_decode: true }, sceneItemEnabled: true });
    await measureDesktopResources(app, page, identity.pid, directory);
  }
  await page.screenshot({ path: join(directory, 'settings.png') });
  await page.evaluate(() => globalThis.tbLink.setDocumentDirty(false));
  await app.close(); app = undefined;
  await check('重启应用后读取 Windows 加密保存密码', async () => {
    app = await launchApp(); page = await app.firstWindow();
    assert.equal((await page.evaluate(() => globalThis.tbLink.connectObs())).status, 'connected');
  });
  await check('目标端口不可达后恢复正确地址', async () => {
    const profile = await page.evaluate(() => globalThis.tbLink.loadIntegrationProfile());
    await page.evaluate(profile => globalThis.tbLink.saveIntegrationProfile({ profile: { ...profile, obs: { ...profile.obs, webSocketUrl: 'ws://127.0.0.1:1' } } }), profile);
    await assert.rejects(() => page.evaluate(() => globalThis.tbLink.connectObs()));
    await page.evaluate(profile => globalThis.tbLink.saveIntegrationProfile({ profile }), profile);
    assert.equal((await page.evaluate(() => globalThis.tbLink.connectObs())).status, 'connected');
  });
} finally {
  await writeFile(join(directory, 'result.json'), JSON.stringify({ label, runtimeVersion, directory, packaged: packaged ?? null, results }, null, 2));
  if (app) await app.close();
  const stream = await observer.call('GetStreamStatus');
  const recording = await observer.call('GetRecordStatus');
  assert(!stream.outputActive && !recording.outputActive, 'Output active; retaining OBS');
  await observer.disconnect();
  await ps(`$p=Get-Process -Id ${identity.pid}; if(-not $p.MainModule.FileName.Equals(${quote(executable)},[StringComparison]::OrdinalIgnoreCase) -or $p.StartTime.ToUniversalTime().ToString('o') -ne ${quote(identity.started)}){throw 'Process identity changed'};
Add-Type -TypeDefinition 'using System;using System.Text;using System.Runtime.InteropServices;public class CloseCompatibilityTest { public delegate bool E(IntPtr h,IntPtr p); [DllImport("user32.dll")] static extern bool EnumWindows(E e,IntPtr p); [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint p); [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder s,int n); [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l); public static bool Close(uint pid){ bool sent=false;EnumWindows((h,p)=>{uint id;GetWindowThreadProcessId(h,out id);var s=new StringBuilder(512);GetWindowText(h,s,512);if(id==pid && s.ToString().StartsWith("OBS ")){sent=PostMessage(h,16,IntPtr.Zero,IntPtr.Zero);return false;}return true;},IntPtr.Zero);return sent;}}';
if(-not [CloseCompatibilityTest]::Close(${identity.pid})){throw 'Normal close refused; retaining OBS'}; if(-not $p.WaitForExit(15000)){throw 'Normal close timed out; retaining OBS'}`);
}
if (results.some(result => !result.passed)) process.exitCode = 1;
