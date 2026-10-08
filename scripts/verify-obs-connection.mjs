import assert from 'node:assert/strict';
import { cp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createConnection, createServer } from 'node:net';
import { launchPackagedDesktop } from '../tools/obs/beauty/verify-packaged-desktop.mjs';
import { closeOwnedObsTest } from './close-owned-obs-test.mjs';
import { ownTestWindowScript } from './own-test-window.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireDesktop = createRequire(join(root, 'apps/desktop/package.json'));
const { chromium, expect } = requireDesktop('@playwright/test');
const [desktopExecutable, obsInstallation, outputArgument] = process.argv.slice(2);
if (!outputArgument || process.platform !== 'win32') throw new Error('Usage: node scripts/verify-obs-connection.mjs <desktop exe> <OBS installation> <new evidence directory>');
const directory = resolve(outputArgument);
await mkdir(directory);
const obsDirectory = join(directory, 'obs');
for (const folder of ['bin', 'data', 'obs-plugins']) await cp(join(obsInstallation, folder), join(obsDirectory, folder), { recursive: true });
const verifyEditor = process.env.TBLINK_VERIFY_EDITOR === '1';
if (verifyEditor) await cp(resolve('tools/obs/native-preview/tblink-realtime-preview.dll'), join(obsDirectory, 'obs-plugins/64bit/tblink-realtime-preview.dll'));
const config = join(obsDirectory, 'config/obs-studio');
for (const folder of ['basic/profiles/Connection', 'basic/scenes', 'plugin_config/obs-websocket']) await mkdir(join(config, folder), { recursive: true });
const settings = '[General]\nFirstRun=false\nLastVersion=537001986\nEnableAutoUpdates=false\n[Basic]\nProfile=Connection\nProfileDir=Connection\nSceneCollection=Connection\nSceneCollectionFile=Connection\n';
await writeFile(join(config, 'global.ini'), settings);
await writeFile(join(config, 'user.ini'), settings + '[BasicWindow]\nPreviewEnabled=true\nSysTrayEnabled=false\n');
await writeFile(join(config, 'basic/profiles/Connection/basic.ini'), '[General]\nName=Connection\n[Video]\nBaseCX=640\nBaseCY=360\nOutputCX=640\nOutputCY=360\nFPSType=0\nFPSCommon=30\n[Output]\nMode=Simple\n');
await writeFile(join(config, 'basic/scenes/Connection.json'), JSON.stringify({ name: 'Connection', current_scene: 'Connection', current_program_scene: 'Connection', sources: [{ name: 'Connection', id: 'scene', settings: { items: [] } }], scene_order: [{ name: 'Connection' }], version: 2 }));
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const password = randomUUID();
const executable = join(obsDirectory, 'bin/64bit/obs64.exe');
const ps = script => promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);" + script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 20000 });
const quote = value => `'${value.replaceAll("'", "''")}'`;
const results = [];
for (const auth of process.env.TBLINK_VERIFY_PLAYBACK === '1' ? [false] : [false, true]) {
  const scenario = join(directory, auth ? 'password' : 'no-password');
  await mkdir(scenario);
  await writeFile(join(config, 'plugin_config/obs-websocket/config.json'), JSON.stringify({ alerts_enabled: false, auth_required: auth, first_load: false, server_enabled: true, server_password: password, server_port: port }));
  const launch = await ps(`$p=Start-Process -FilePath ${quote(executable)} -WorkingDirectory ${quote(dirname(executable))} -ArgumentList @('--portable','--multi','--disable-updater','--disable-missing-files-check') -WindowStyle Hidden -PassThru; @{pid=$p.Id;started=$p.StartTime.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress`);
  const identity = { ...JSON.parse(launch.stdout.replace(/^\uFEFF/, '')), executable };
  await writeFile(join(scenario, 'owned-obs.json'), JSON.stringify(identity));
  let application;
  try {
    const deadline = Date.now() + 20000;
    let listening = false;
    while (!listening && Date.now() < deadline) {
      listening = await new Promise(resolve => { const socket = createConnection({ host: '127.0.0.1', port }); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => { socket.destroy(); resolve(false); }); });
      if (!listening) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(listening, 'Isolated OBS WebSocket did not start');
    application = await launchPackagedDesktop({ executable: desktopExecutable, directory: scenario, chromium });
    const page = await application.firstWindow();
    await expect(page.getByRole('navigation', { name: '主要工作区' })).toBeVisible();
    const external = { executablePath: executable, workingDirectory: dirname(executable), arguments: ['--portable', '--multi'], startupTimeoutMs: 10000, shutdownTimeoutMs: 5000 };
    const profile = { schemaVersion: 1, profileId: 'obs-connection-test', name: 'OBS 连接验收', updatedAt: new Date().toISOString(),
      obs: { ...external, autoConnectOnLaunch: false, webSocketUrl: `ws://127.0.0.1:${port}`, credentialId: 'obs-main' },
      p1: { ...external, mtcInputPortProfileId: 'in', controlOutputPortProfileId: 'out', expectedFrameRate: '30' },
      midiPortProfiles: [{ id: 'in', direction: 'input', portName: '' }, { id: 'out', direction: 'output', portName: '' }], acceptedVersions: { obs: '32.2.2', p1: 'test' } };
    await page.evaluate(profile => globalThis.window.tbLink.saveIntegrationProfile({ profile: { ...profile, obs: { ...profile.obs, webSocketUrl: 'ws://wrong-host' } }, obsPassword: 'outdated-test-value' }), profile);
    await page.reload();
    await expect(page.getByRole('navigation', { name: '主要工作区' })).toBeVisible();
    // Real main-process exact-path process detection, without plugin maintenance.
    const running = await page.evaluate(() => globalThis.window.tbLink.startExternalApplication('obs'));
    assert.equal(running.pid, identity.pid);
    assert.equal(running.owned, false);
    // The user must not enter a URL or password: recover from deliberately wrong saved settings.
    await page.getByRole('button', { name: '顶部一键连接', exact: true }).click();
    await expect(page.getByRole('button', { name: '顶部一键连接', exact: true })).toBeEnabled({ timeout: 45000 });
    assert.equal((await page.evaluate(() => globalThis.window.tbLink.getObsSnapshot())).status, 'connected');
    await expect(page.getByRole('button', { name: '视频：已连接，前往设置', exact: true })).toBeVisible();
    const automaticallySaved = await page.evaluate(() => globalThis.window.tbLink.loadIntegrationProfile());
    assert.equal(automaticallySaved.obs.webSocketUrl, profile.obs.webSocketUrl);
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: /OBS Studio/ }).first().click();
    const panel = page.getByRole('region', { name: 'OBS 连接设置', exact: true });
    await expect(panel).toBeVisible();
    await expect(panel.getByLabel('OBS 密码', { exact: true })).toHaveAttribute('type', 'text');
    if (auth) await expect(panel.getByLabel('OBS 密码', { exact: true })).toHaveValue(password);
    await page.evaluate(() => globalThis.window.tbLink.disconnectObs());
    // Manual override accepts just the port, without asking users to construct a URL.
    await panel.getByLabel('WebSocket 地址', { exact: true }).fill(String(port));
    if (auth) {
      await panel.getByLabel('OBS 密码', { exact: true }).fill('wrong-test-password');
      await panel.getByRole('button', { name: '保存并连接 OBS', exact: true }).click();
      await expect(panel.getByRole('alert')).toContainText(/Authentication|认证|密码/);
      assert.equal((await page.evaluate(() => globalThis.window.tbLink.getObsSnapshot())).status, 'error');
      await panel.getByLabel('OBS 密码', { exact: true }).fill(password);
    }
    await panel.getByRole('button', { name: '保存并连接 OBS', exact: true }).click();
    await expect(panel.getByRole('button', { name: '断开 OBS', exact: true })).toBeVisible({ timeout: 15000 });
    const snapshot = await page.evaluate(() => globalThis.window.tbLink.getObsSnapshot());
    assert.equal(snapshot.status, 'connected');
    const inventory = await page.evaluate(() => globalThis.window.tbLink.readObsInventory());
    assert(inventory.scenes.includes('Connection'));
    if (auth) {
      const validation = await page.evaluate(async profile => {
        try { await globalThis.window.tbLink.saveIntegrationProfile({ profile: { ...profile, obs: { ...profile.obs, webSocketUrl: 'http://invalid-address' } } }); return 'unexpected-success'; }
        catch (error) { return String(error); }
      }, profile);
      assert(validation.includes('连接配置校验失败') && validation.includes('profile.obs.webSocketUrl'));
      const persisted = await page.evaluate(() => globalThis.window.tbLink.loadIntegrationProfile());
      assert.equal(persisted.obs.webSocketUrl, profile.obs.webSocketUrl);
    }
    await page.screenshot({ path: join(scenario, 'connected.png'), mask: [panel.getByLabel('OBS 密码', { exact: true })] });
    // Save again through the exact top-bar workflow that failed at the user's site.
    await page.getByRole('button', { name: '顶部一键连接', exact: true }).click();
    await expect(page.getByRole('button', { name: '顶部一键连接', exact: true })).toBeEnabled({ timeout: 30000 });
    assert.equal((await page.evaluate(() => globalThis.window.tbLink.getObsSnapshot())).status, 'connected');
    const logs = await page.evaluate(() => globalThis.window.tbLink.queryLogs());
    await writeFile(join(scenario, 'logs.json'), JSON.stringify(logs, null, 2));
    assert(!logs.some(entry => entry.message.includes('连接配置：操作未能完成')));
    if (auth) assert(logs.some(entry => entry.message === '连接配置校验失败' && entry.details?.issues?.some(issue => issue.path === 'profile.obs.webSocketUrl')));
    assert(!JSON.stringify(logs).includes(password));
    if (verifyEditor && !auth) {
      const { OBSWebSocket } = requireDesktop('obs-websocket-js');
      const control = new OBSWebSocket(); await control.connect(profile.obs.webSocketUrl);
      try {
        await control.call('CreateScene', { sceneName: 'Second' });
        for (const sceneName of ['Connection', 'Second']) await control.call('CreateInput', { sceneName, inputName: `${sceneName}-source`, inputKind: 'color_source_v3', inputSettings: { width: 300, height: 200, color: 4278255615 }, sceneItemEnabled: true });
        await control.call('SetCurrentProgramScene', { sceneName: 'Connection' });
        const project = await page.evaluate(() => globalThis.window.tbLink.createProject('真实 OBS 编辑恢复验收'));
        project.obsOutputMode = 'scenes'; project.rundown = [{ id: 'song', title: '测试节目', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [] }];
        const projectPath = join(scenario, 'editor.tblink'); await writeFile(projectPath, JSON.stringify(project));
        await page.evaluate(path => localStorage.setItem('tblink.last-project-path.v1', path), projectPath); await page.reload();
        const appIdentity = JSON.parse(await readFile(join(scenario, 'packaged-desktop-process.json'), 'utf8'));
        await ps(`${ownTestWindowScript(appIdentity.pid)}[void][TestWindow]::ShowWindow($h,9);[void][TestWindow]::MoveWindow($h,80,80,1300,850,$true)`);
        await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
        let source = page.locator('.obs-live-source[title="Connection-source"]'); await expect(source).toBeVisible({ timeout: 15000 });
        const bounds = await source.boundingBox(); await page.mouse.move(bounds.x + 30, bounds.y + 30); await page.mouse.down(); await page.mouse.move(bounds.x + 45, bounds.y + 40);
        await control.call('SetCurrentProgramScene', { sceneName: 'Second' });
        await page.mouse.move(bounds.x + 70, bounds.y + 45); await page.mouse.up();
        source = page.locator('.obs-live-source[title="Second-source"]'); await expect(source).toBeVisible({ timeout: 10000 });
        await expect(page.locator('.stage-error')).toHaveCount(0);
        const item = (await control.call('GetSceneItemList', { sceneName: 'Second' })).sceneItems[0];
        const before = await control.call('GetSceneItemTransform', { sceneName: 'Second', sceneItemId: item.sceneItemId });
        const second = await source.boundingBox(); await page.mouse.move(second.x + 25, second.y + 25); await page.mouse.down(); await page.mouse.move(second.x + 70, second.y + 55, { steps: 8 }); await page.mouse.up();
        await expect.poll(async () => (await control.call('GetSceneItemTransform', { sceneName: 'Second', sceneItemId: item.sceneItemId })).sceneItemTransform.positionX).toBeGreaterThan(before.sceneItemTransform.positionX + 10);
        await expect(page.locator('.stage-error')).toHaveCount(0);
        await page.screenshot({ path: join(scenario, 'editor-recovered.png') });
        await writeFile(join(scenario, 'editor-acceptance.json'), JSON.stringify({ realObs: true, obsVersion: snapshot.obsVersion, externalSceneChangeDuringDrag: true, newSceneDragConfirmedByObs: true, componentRepairNotRequired: true }, null, 2));
      } finally { await control.disconnect(); }
    }
    if (process.env.TBLINK_VERIFY_PLAYBACK === '1') {
      const appIdentity = JSON.parse(await readFile(join(scenario, 'packaged-desktop-process.json'), 'utf8'));
      await ps(`${ownTestWindowScript(appIdentity.pid)}[void][TestWindow]::ShowWindow($h,9);[void][TestWindow]::MoveWindow($h,80,80,1300,850,$true)`);
      const { OBSWebSocket } = requireDesktop('obs-websocket-js');
      const control = new OBSWebSocket(); await control.connect(profile.obs.webSocketUrl);
      try { const { verifyObsProgramPlayback } = await import('./verify-obs-program-playback.mjs'); await verifyObsProgramPlayback({ page, directory: scenario, profile, control, expect, requireDesktop,
        setWindowVisible: visible => ps(`${ownTestWindowScript(appIdentity.pid)}[void][TestWindow]::ShowWindow($h,${visible ? 9 : 0})`) }); }
      finally { await control.disconnect(); }
    }
    const { OBSWebSocket: StatusControl } = requireDesktop('obs-websocket-js');
    const statusControl = new StatusControl(); await statusControl.connect(profile.obs.webSocketUrl, auth ? password : undefined);
    try {
      await statusControl.call('CreateInput', { sceneName: 'Connection', inputName: 'Unavailable-monitor-test', inputKind: 'monitor_capture', inputSettings: { monitor_id: 'TBLINK-MISSING-MONITOR' }, sceneItemEnabled: false });
      const partial = await page.evaluate(() => globalThis.window.tbLink.readObsInventory());
      assert(partial.scenes.includes('Connection'));
      assert.match(partial.sourceSizeErrors['Unavailable-monitor-test'], /显示器采集/);
      assert.equal(partial.sourceSizes['Unavailable-monitor-test'], undefined);
      await page.getByRole('button', { name: '顶部一键连接', exact: true }).click();
      await expect(page.getByRole('button', { name: '顶部一键连接', exact: true })).toBeEnabled({ timeout: 30000 });
      await expect(page.getByRole('button', { name: '视频：已连接，前往设置', exact: true })).toBeVisible();
      await writeFile(join(scenario, 'inventory-failure-logs.json'), JSON.stringify(await page.evaluate(() => globalThis.window.tbLink.queryLogs()), null, 2));
    } finally {
      try { await statusControl.call('RemoveInput', { inputName: 'Unavailable-monitor-test' }); }
      finally { await statusControl.disconnect(); }
    }
    results.push({ auth, obsVersion: snapshot.obsVersion, originalPidRetained: running.pid === identity.pid, sceneRead: true, uiPasswordFlow: auth, topBarConnect: true, actualInventoryFailureRetainsConnectedIndicator: true });
    await page.evaluate(() => globalThis.window.tbLink.disconnectObs());
    await expect(page.getByRole('button', { name: '视频：未连接，前往设置', exact: true })).toBeVisible();
  } finally {
    try { if (application) await application.close(); }
    finally { await closeOwnedObsTest(identity); }
  }
}
await writeFile(join(directory, 'acceptance.json'), JSON.stringify({ results, completedAt: new Date().toISOString(), executable: desktopExecutable }, null, 2));
console.log('真实 OBS 无认证、错误密码提示、界面输入正确密码、重复一键连接、场景读取通过；原 OBS 进程保持。');
