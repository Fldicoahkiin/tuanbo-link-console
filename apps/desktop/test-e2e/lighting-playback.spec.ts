import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createEmptyLinkProject, createLightingDocument, lightingTrackSchema, ma2PlaybackRequestSchema, parseLinkProject } from '@tb/schema';
import { closeDiscarding } from './save-questions';

for (const scenario of ['connected', 'disconnected', 'empty'] as const) test(`灯光时间线默认驱动输出：${scenario}`, async ({}, info) => {
  const connected = scenario === 'connected';
  const empty = scenario === 'empty';
  const wav = Buffer.alloc(44 + 48000 * 6 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await mkdir(info.outputPath('assets/reference-audio'), { recursive: true }); await writeFile(info.outputPath('assets/reference-audio/song.wav'), wav);
  const track = lightingTrackSchema.parse({ id: 'track', name: '灯光', kind: 'ma2', color: '#68c9ed', group: 'effect-canvas', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: 'clip', name: '灯光', start: 0, duration: 6000, timeLock: 'time', muted: false, events: empty ? [{ id: 'empty', at: 400, kind: 'empty-cue', label: '' }] : [400, 2200, 4200].map((at, i) => ({ id: `cue-${i}`, at, kind: 'ma2', action: 'goto', sequence: 168, cue: `${i + 1}.000`, executor: '', label: `灯光 ${i + 1}` })) }] });
  const project = parseLinkProject({ ...createEmptyLinkProject('播放驱动灯光验收'), schemaVersion: 2, playbackSource: 'p1', rundown: [{ id: 'song', title: '灯光播放回归', cues: [], referenceAudio: { assetId: 'audio', relativePath: 'assets/reference-audio/song.wav', durationMs: 6000, sha256: createHash('sha256').update(wav).digest('hex') }, lighting: { ...createLightingDocument(), outputMode: empty ? 'timecode' : 'network', tracks: [track] } }] });
  const file = info.outputPath('playback.tblink'); await writeFile(file, JSON.stringify(project));
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')], env: { ...process.env, TBLINK_LOCAL_TEST_ACCESS: '1' } });
  const calls: { cue: string; action: string }[] = [];
  app.on('console', message => {
    if (!message.text().startsWith('LIGHTING_PLAYBACK_TEST:')) return;
    const request = ma2PlaybackRequestSchema.parse(JSON.parse(message.text().slice('LIGHTING_PLAYBACK_TEST:'.length)));
    calls.push({ cue: 'cue' in request.action ? request.action.cue ?? '' : '', action: request.action.action });
  });
  const page = await app.firstWindow();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await app.evaluate(({ ipcMain }, isConnected) => {
      ipcMain.removeHandler('link:ma2-network-status');
      ipcMain.handle('link:ma2-network-status', () => ({ state: isConnected ? 'connected' : 'disconnected', settings: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' }, passwordSaved: false, version: '3.9.60.74', error: null }));
      ipcMain.removeHandler('link:ma2-play-cue');
      ipcMain.handle('link:ma2-play-cue', (_event, value: unknown) => { console.log('LIGHTING_PLAYBACK_TEST:' + JSON.stringify(value)); });
      ipcMain.removeHandler('link:ma2-play-cancel'); ipcMain.handle('link:ma2-play-cancel', () => undefined);
    }, connected);
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
    if (empty) {
      await page.locator('.waveform-cue-point').click();
      await expect(page.locator('.cue-ingredient')).toHaveCount(0);
      await expect(page.getByLabel('灯光输出提示', { exact: true })).toHaveCount(0);
      await expect(page.locator('.wavesurfer-surface[data-ready=true]').first()).toBeVisible();
      await page.getByRole('button', { name: '播放时间线', exact: true }).click();
      await expect.poll(() => page.locator('.timeline-audio-engine').evaluate(element => (element as HTMLAudioElement).currentTime)).toBeGreaterThan(1);
      await page.getByRole('button', { name: '停止时间线', exact: true }).click();
      expect(calls).toEqual([]);
      await expect(page.getByText('请在设备设置选择 MIDI 时间码输出', { exact: false })).toHaveCount(0);
      return;
    }
    if (connected) {
      await expect(page.getByRole('combobox', { name: '灯光输出方式' })).toHaveCount(0);
      for (const width of [1440, 1060]) {
        await page.setViewportSize({ width, height: 900 });
        const bounds = await page.locator('.lighting-output-route').boundingBox();
        const toolbar = await page.locator('.timeline-transport').boundingBox();
        expect(bounds!.y).toBeGreaterThanOrEqual(toolbar!.y);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(toolbar!.y + toolbar!.height);
        expect(bounds!.height).toBeLessThan(40);
      }
      await page.screenshot({ path: info.outputPath('output-route-compact.png') });
      expect(calls).toEqual([]);
    }
    await expect(page.locator('.wavesurfer-surface[data-ready=true]').first()).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: '播放时间线', exact: true }).click();
    if (!connected) {
      await expect(page.getByText('序列池播放需要先在设备设置连接 MA2 网络', { exact: false }).first()).toBeVisible();
      await expect(page.getByRole('button', { name: '播放时间线', exact: true })).toBeVisible();
      expect(calls).toEqual([]);
      await page.screenshot({ path: info.outputPath('disconnected.png') });
      return;
    }
    await expect.poll(() => calls.filter(call => call.action === 'goto').map(call => call.cue), { timeout: 5000 }).toEqual(['1.000']);
    await page.getByRole('button', { name: '暂停时间线', exact: true }).click();
    const audio = page.locator('.timeline-audio-engine');
    await expect.poll(() => audio.evaluate(element => (element as HTMLAudioElement).paused)).toBe(true);
    const paused = await audio.evaluate(element => (element as HTMLAudioElement).currentTime);
    await page.waitForTimeout(2300);
    expect(await audio.evaluate(element => (element as HTMLAudioElement).currentTime)).toBe(paused);
    expect(calls.filter(call => call.action === 'goto').map(call => call.cue)).toEqual(['1.000']);
    await page.getByRole('button', { name: '播放时间线', exact: true }).click();
    await expect.poll(() => calls.filter(call => call.action === 'goto').map(call => call.cue), { timeout: 6500 }).toEqual(['1.000', '2.000', '3.000']);
    await page.getByRole('button', { name: '暂停时间线', exact: true }).click();
    await page.getByRole('button', { name: '回到时间线开头', exact: true }).click();
    await page.getByRole('button', { name: '播放时间线', exact: true }).click();
    await expect.poll(() => calls.filter(call => call.action === 'goto').map(call => call.cue), { timeout: 2000 }).toEqual(['1.000', '2.000', '3.000', '1.000']);
    await page.getByRole('button', { name: '暂停时间线', exact: true }).click();
    await page.getByRole('button', { name: '停止时间线', exact: true }).click();
    await expect.poll(() => calls.filter(call => call.action === 'off').length).toBe(1);
    await expect(page.locator('.timeline-transport code')).toHaveText('00:00');
    await page.screenshot({ path: info.outputPath('playback.png') });
  } finally { await closeDiscarding(app); }
});
