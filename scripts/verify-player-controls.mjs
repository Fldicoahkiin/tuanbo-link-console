import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { launchPackagedDesktop } from '../tools/obs/beauty/verify-packaged-desktop.mjs';
import { ownTestWindowScript } from './own-test-window.mjs';

const [executable, output] = process.argv.slice(2);
if (!output) throw new Error('Usage: node scripts/verify-player-controls.mjs <packaged exe> <new evidence directory>');
const directory = resolve(output); await mkdir(directory);
const requireDesktop = createRequire(resolve('apps/desktop/package.json'));
const { chromium, expect } = requireDesktop('@playwright/test');
const wav = Buffer.alloc(44 + 48000 * 4 * 20);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(192000, 28);
wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
for (let frame = 0; frame < 48000 * 20; frame++) { const sample = Math.round(32 * Math.sin(frame * Math.PI * 2 * 500 / 48000)); wav.writeInt16LE(sample, 44 + frame * 4); wav.writeInt16LE(sample, 46 + frame * 4); }
await writeFile(join(directory, 'audio.wav'), wav);
const sha256 = createHash('sha256').update(wav).digest('hex');
const application = await launchPackagedDesktop({ executable, directory, chromium });
const page = await application.firstWindow();
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await expect(page.getByRole('navigation', { name: '主要工作区' })).toBeVisible();
  const project = await page.evaluate(() => globalThis.window.tbLink.createProject('播放按钮验收'));
  project.playbackSource = 'internal'; project.obsOutputMode = 'scenes';
  project.playlists = [{ id: 'empty', name: '空列表验收' }];
  project.rundown = [{ id: 'song', title: '验收音频', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [],
    referenceAudio: { assetId: 'audio', relativePath: 'audio.wav', sha256, durationMs: 20000 },
    playback: { startMs: 0, endMs: 20000, mtcOffsetMs: 480000, volume: 10, endAction: 'pause', shortcut: '' } }];
  const file = join(directory, 'test.tblink'); await writeFile(file, JSON.stringify(project));
  const external = { executablePath: 'C:\\unused.exe', workingDirectory: 'C:\\', arguments: [], startupTimeoutMs: 10000, shutdownTimeoutMs: 5000 };
  const profile = { schemaVersion: 1, profileId: 'player-test', name: '播放按钮验收', updatedAt: new Date().toISOString(),
    obs: { ...external, autoConnectOnLaunch: false, webSocketUrl: 'ws://127.0.0.1:4455', credentialId: 'test' },
    p1: { ...external, mtcInputPortProfileId: 'in', controlOutputPortProfileId: 'out', expectedFrameRate: '30' },
    midiPortProfiles: [{ id: 'in', direction: 'input', portName: '' }, { id: 'out', direction: 'output', portName: '' }], acceptedVersions: { obs: 'test', p1: 'test' }, internalPlayer: { audioEngine: 'native', nativeAudioOutputDeviceId: 'default', audioOutputDeviceId: 'default', mtcOutputPortProfileId: null, audioSampleRate: 48000 } };
  await page.evaluate(async ({ profile, file }) => { await globalThis.window.tbLink.saveIntegrationProfile({ profile }); localStorage.setItem('tblink.last-project-path.v1', file); }, { profile, file });
  await page.reload();
  const button = page.locator('.player-transport .primary-button');
  await expect(button).toBeEnabled();
  await expect(page.locator('.player-now h2')).toHaveText('验收音频');
  // An empty list must not disable the audio already selected in the monitor.
  await page.getByRole('button', { name: /空列表验收/ }).click();
  await expect(button).toBeEnabled();
  for (let cycle = 0; cycle < 3; cycle++) {
    await button.click();
    await expect(page.locator('.player-transport.status-playing')).toBeVisible({ timeout: 20000 });
    await expect.poll(async () => (await page.evaluate(() => globalThis.window.tbLink.getNativePlaybackStatus()))?.positionMs).toBeGreaterThan(100);
    await button.click(); await expect(page.locator('.player-transport.status-paused')).toBeVisible();
    await expect(button).toBeEnabled(); await button.click();
    await expect(page.locator('.player-transport.status-playing')).toBeVisible();
    await page.getByRole('button', { name: '停止播放', exact: true }).click();
    await expect(page.locator('.player-transport.status-stopped')).toBeVisible();
    await expect(button).toBeEnabled();
  }
  await page.waitForTimeout(15000);
  await expect(button).toBeEnabled();
  const navigation = page.getByRole('navigation', { name: '主要工作区' });
  for (let visit = 0; visit < 3; visit++) {
    await navigation.getByRole('button', { name: '编辑器', exact: true }).click();
    await expect(page.locator('.timeline-ruler')).toBeVisible();
    await expect(page.getByText('尚未打开工程', { exact: true })).toHaveCount(0);
    await navigation.getByRole('button', { name: '节目单', exact: true }).click();
    await expect(button).toBeEnabled();
  }
  await page.reload();
  await expect(button).toBeEnabled();
  await expect(page.locator('.player-now h2')).toHaveText('验收音频');
  assert.notEqual((await page.evaluate(() => globalThis.window.tbLink.getNativePlaybackStatus()))?.status, 'playing');
  const identity = JSON.parse(await readFile(join(directory, 'packaged-desktop-process.json'), 'utf8'));
  const restore = `$ErrorActionPreference='Stop';${ownTestWindowScript(identity.pid)}[void][TestWindow]::ShowWindow($h,9);[void][TestWindow]::MoveWindow($h,80,80,1300,800,$true)`;
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(restore, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000 });
  await page.waitForTimeout(300);
  const region = page.locator('.topbar-connection-status');
  assert.equal(await region.evaluate(el => globalThis.getComputedStyle(el).getPropertyValue('-webkit-app-region')), 'drag');
  assert.equal(await page.locator('.connection-overview-item').first().evaluate(el => globalThis.getComputedStyle(el).getPropertyValue('-webkit-app-region')), 'no-drag');
  const bounds = await region.boundingBox();
  const ratio = await page.evaluate(() => globalThis.devicePixelRatio);
  const x = Math.round((bounds.x + bounds.width - 5) * ratio), y = Math.round((bounds.y + bounds.height / 2) * ratio);
  const script = `$ErrorActionPreference='Stop';${ownTestWindowScript(identity.pid)} Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class HitTest { [StructLayout(LayoutKind.Sequential)] public struct Point {public int X;public int Y;} [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref Point p); [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,IntPtr l); }'; $point=[HitTest+Point]::new();$point.X=${x};$point.Y=${y};[void][HitTest]::ClientToScreen($h,[ref]$point);$packed=($point.Y -shl 16) -bor ($point.X -band 65535);[HitTest]::SendMessage($h,132,[IntPtr]::Zero,[IntPtr]$packed).ToInt32()`;
  const hit = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000 });
  assert.equal(Number(hit.stdout.trim()), 2, 'Windows must identify blank status area as draggable caption');
  await page.getByRole('button', { name: '详细', exact: true }).click();
  await expect(page.locator('.topbar-connection-status .toolbar-connections')).toBeVisible();
  assert.equal(await page.locator('.topbar-connection-status .toolbar-connection').first().evaluate(el => globalThis.getComputedStyle(el).getPropertyValue('-webkit-app-region')), 'no-drag');
  await page.screenshot({ path: join(directory, 'player-and-topbar.png') });
  await writeFile(join(directory, 'logs.json'), JSON.stringify(await page.evaluate(() => globalThis.window.tbLink.queryLogs()), null, 2));
  assert.deepEqual(errors, []);
  await writeFile(join(directory, 'acceptance.json'), JSON.stringify({ executable, selectedAudioWithEmptyPlaylist: true, cycles: 3, editorPageRoundTrips: 3, projectRestoredAfterReload: true, nativeAudioWithoutObsOrMidi: true, idleMs: 15000, windowsCaptionHitTest: 2, rendererErrors: errors, completedAt: new Date().toISOString() }, null, 2));
} finally { await application.close(); }
console.log('实际安装程序：空列表仍可播放选中音频；播放/暂停/继续/停止三轮通过；Windows 原生标题栏命中测试通过。');
