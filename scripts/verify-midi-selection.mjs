import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { launchPackagedDesktop } from '../tools/obs/beauty/verify-packaged-desktop.mjs';

const [executable, output] = process.argv.slice(2);
const directory = resolve(output); await mkdir(directory);
const { chromium, expect } = createRequire(resolve('apps/desktop/package.json'))('@playwright/test');
const target = 'TBLINK SOAK MTC'; // Existing dedicated test loop, never a console endpoint.
const application = await launchPackagedDesktop({ executable, directory, chromium });
const page = await application.firstWindow();
const errors = []; page.on('pageerror', error => errors.push(error.message));
let result;
try {
  await expect(page.getByRole('navigation', { name: '主要工作区' })).toBeVisible();
  const devices = await page.evaluate(() => globalThis.window.tbLink.getNativePlaybackDevices());
  assert.equal(devices.midiOutputs.filter(port => port.name === target).length, 1, 'Requires the dedicated test MIDI loop');
  const wav = Buffer.alloc(44 + 48000 * 4 * 8);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(192000, 28);
  wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await writeFile(join(directory, 'silent.wav'), wav);
  const project = await page.evaluate(() => globalThis.window.tbLink.createProject('MIDI 接口验收'));
  project.playbackSource = 'internal'; project.obsOutputMode = 'scenes';
  project.rundown = [{ id: 'song', title: '时间码起点验收', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [],
    referenceAudio: { assetId: 'audio', relativePath: 'silent.wav', sha256: createHash('sha256').update(wav).digest('hex'), durationMs: 8000 },
    playback: { startMs: 0, endMs: 8000, mtcOffsetMs: 480500, volume: 0, endAction: 'pause', shortcut: '' } }];
  const file = join(directory, 'test.tblink'); await writeFile(file, JSON.stringify(project));
  const external = { executablePath: 'C:\\unused.exe', workingDirectory: 'C:\\', arguments: [], startupTimeoutMs: 10000, shutdownTimeoutMs: 5000 };
  const profile = { schemaVersion: 1, profileId: 'midi-test', name: 'MIDI 验收', updatedAt: new Date().toISOString(),
    obs: { ...external, connectionMethod: 'manual', autoConnectOnLaunch: false, webSocketUrl: 'ws://192.0.2.1:4455', credentialId: 'test' },
    p1: { ...external, mtcInputPortProfileId: 'in', controlOutputPortProfileId: 'out', expectedFrameRate: '30' },
    midiPortProfiles: [{ id: 'in', direction: 'input', portName: '' }, { id: 'out', direction: 'output', portName: '' }], acceptedVersions: { obs: 'test', p1: 'test' },
    internalPlayer: { audioEngine: 'browser', audioOutputDeviceId: 'default', mtcOutputPortProfileId: null, audioSampleRate: 48000 } };
  await page.evaluate(async ({ profile, file }) => { await globalThis.window.tbLink.saveIntegrationProfile({ profile }); globalThis.localStorage.setItem('tblink.last-project-path.v1', file); globalThis.localStorage.setItem('tblink.ma2-connection-method.v1', 'midi'); }, { profile, file });
  // Only Web MIDI enumeration is substituted, to reproduce a missing entry
  // without a hardware event. Native enumeration/open/playback stay real.
  await page.addInitScript(() => {
    Object.defineProperty(globalThis.navigator, 'requestMIDIAccess', { configurable: true, value: async () => {
      const access = new EventTarget(); access.inputs = new Map();
      const names = ['Babyface Midi Port 1', ...(globalThis.localStorage.getItem('midi-test-expand') ? ['USB MIDI Interface'] : [])];
      access.outputs = new Map(names.map(name => [name, { id: name, name, manufacturer: 'fixture', type: 'output', state: 'connected', connection: 'closed', open: async () => undefined }]));
      return access;
    } });
  });
  await page.reload();
  const navigation = page.getByRole('navigation', { name: '主要工作区' });
  await navigation.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: /^音频与 MIDI/ }).click();
  const select = page.getByLabel('灯光 MIDI 输出', { exact: true });
  await expect(select.locator('option[value="Babyface Midi Port 1"]')).toHaveCount(1);
  await expect(select.locator('option[value="USB MIDI Interface"]')).toHaveCount(0);
  await page.evaluate(() => globalThis.localStorage.setItem('midi-test-expand', '1'));
  await page.getByRole('button', { name: '刷新端口', exact: true }).click();
  await expect(select.locator('option[value="USB MIDI Interface"]')).toBeEnabled();
  await select.selectOption('USB MIDI Interface');
  await expect.poll(async () => (await page.evaluate(() => globalThis.window.tbLink.loadIntegrationProfile()))?.midiPortProfiles.find(port => port.id === 'internal-mtc-output')?.portName).toBe('USB MIDI Interface');
  await expect(select).toBeEnabled();
  await select.selectOption(target);
  await expect(page.getByLabel('正式播放引擎', { exact: true })).toHaveValue('native');
  const connect = page.getByRole('button', { name: '顶部一键连接', exact: true });
  await expect(connect).toBeEnabled(); await connect.click();
  await expect(connect).toBeEnabled({ timeout: 45000 });
  const logs = await page.evaluate(() => globalThis.window.tbLink.queryLogs());
  assert(logs.some(entry => entry.message.includes(`Windows MIDI 接口已实际打开并释放：${target}`)), 'One-click must really open the selected WinMM endpoint');
  await expect(page.getByRole('button', { name: '灯光：可用，前往设置', exact: true })).toBeVisible();
  // Editing uses a separate MA2 network connection. It must not turn MIDI red
  // or redirect the lighting status chip away from the timecode settings.
  await page.evaluate(() => globalThis.localStorage.setItem('tblink.ma2-connection-method.v1', 'network'));
  await page.reload();
  await expect(page.getByRole('button', { name: '灯光：可用，前往设置', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '灯光：可用，前往设置', exact: true }).click();
  await expect(page.locator('[data-settings-section="audio"]')).toBeVisible();
  await expect(page.getByLabel('灯光 MIDI 输出', { exact: true })).toHaveValue(target);
  await page.screenshot({ path: join(directory, 'selected-windows-midi.png') });
  await navigation.getByRole('button', { name: '节目单', exact: true }).click();
  await page.locator('.player-transport .primary-button').click();
  await expect.poll(async () => (await page.evaluate(() => globalThis.window.tbLink.getNativePlaybackStatus()))?.mtcSent ?? 0, { timeout: 20000 }).toBeGreaterThan(20);
  const status = await page.evaluate(() => globalThis.window.tbLink.getNativePlaybackStatus());
  assert.equal(status.mtcPortName, target); assert.equal(status.offsetMs, 480500); assert.equal(status.mtcError, null);
  await page.getByRole('button', { name: '停止播放', exact: true }).click();
  await expect(page.locator('.player-transport.status-stopped')).toBeVisible();
  result = { browserRefreshRegression: true, selectedUsbSaved: true, nativeFallbackExplicitSelection: true,
    lightingStatusIndependentOfMa2Network: true, lightingStatusNavigatesToTimecode: true,
    oneClickActuallyOpened: true, realWindowsMidiPort: target, nativeStatus: status, hardwareUsbAndMa2Verified: false, errors };
  assert.deepEqual(errors, []);
  await writeFile(join(directory, 'logs.json'), JSON.stringify(await page.evaluate(() => globalThis.window.tbLink.queryLogs()), null, 2));
} catch (error) {
  await page.screenshot({ path: join(directory, 'failure.png') });
  await writeFile(join(directory, 'failure-ui.txt'), await page.locator('body').innerText());
  await writeFile(join(directory, 'failure-logs.json'), JSON.stringify(await page.evaluate(() => globalThis.window.tbLink.queryLogs()), null, 2));
  throw error;
} finally { await application.close(); }
const restarted = await launchPackagedDesktop({ executable, directory, chromium });
try {
  const window = await restarted.firstWindow(); await expect(window.getByRole('navigation', { name: '主要工作区' })).toBeVisible();
  const profile = await window.evaluate(() => globalThis.window.tbLink.loadIntegrationProfile());
  assert.equal(profile.midiPortProfiles.find(port => port.id === 'internal-mtc-output')?.portName, target);
  assert.equal(profile.internalPlayer.audioEngine, 'native');
  result.restartSelectionRetained = true;
} finally { await restarted.close(); }
await writeFile(join(directory, 'acceptance.json'), JSON.stringify({ executable, ...result }, null, 2));
console.log('端口刷新、Windows 原生接口选择、一键实际打开、原生 MTC 发送及重启保留通过；非实体 USB/MA2 验收。');
