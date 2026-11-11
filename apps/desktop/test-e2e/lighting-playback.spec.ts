import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createEmptyLinkProject, createLightingDocument, lightingTrackSchema, ma2PlaybackRequestSchema, parseLinkProject } from '@tb/schema';
import { createDefaultIntegrationProfile } from '../src/renderer/src/link/view-models/local-integration-profile';
import { stubMidiPorts } from './midi-ports';
import { closeDiscarding } from './save-questions';

// 2026-11-01: lighting only follows the song's timecode. Playing the workbench sends MIDI timecode from the
// song's MTC start and never the timeline's Cues; stopping switches the song's executor off.
for (const scenario of ['timecode', 'no-port', 'empty'] as const) test(`灯光工作台播放只发时间码：${scenario}`, async ({}, info) => {
  const empty = scenario === 'empty';
  const wav = Buffer.alloc(44 + 48000 * 6 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await mkdir(info.outputPath('assets/reference-audio'), { recursive: true }); await writeFile(info.outputPath('assets/reference-audio/song.wav'), wav);
  const track = lightingTrackSchema.parse({ id: 'track', name: '灯光', kind: 'ma2', color: '#68c9ed', group: 'effect-canvas', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: 'clip', name: '灯光', start: 0, duration: 6000, timeLock: 'time', muted: false, events: empty ? [{ id: 'empty', at: 400, kind: 'empty-cue', label: '' }] : [400, 2200, 4200].map((at, i) => ({ id: `cue-${i}`, at, kind: 'ma2', action: 'goto', sequence: 168, cue: `${i + 1}.000`, executor: '', label: `灯光 ${i + 1}` })) }] });
  const consoleSong = { endpoint: 'console', show: '现场', layout: null, executor: '51.101', sequence: 36, name: '灯光播放回归', baselineXml: '<MA/>', points: [] };
  const project = parseLinkProject({ ...createEmptyLinkProject('播放驱动灯光验收'), schemaVersion: 2, playbackSource: 'p1', rundown: [{ id: 'song', title: '灯光播放回归', cues: [], referenceAudio: { assetId: 'audio', relativePath: 'assets/reference-audio/song.wav', durationMs: 6000, sha256: createHash('sha256').update(wav).digest('hex') }, lighting: { ...createLightingDocument(), tracks: [track], ...(empty ? {} : { consoleSong }) } }] });
  const file = info.outputPath('playback.tblink'); await writeFile(file, JSON.stringify(project));
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')], env: { ...process.env, TBLINK_LOCAL_TEST_ACCESS: '1' } });
  const calls: { cue: string; action: string; executor: string }[] = [];
  app.on('console', message => {
    if (!message.text().startsWith('LIGHTING_PLAYBACK_TEST:')) return;
    const request = ma2PlaybackRequestSchema.parse(JSON.parse(message.text().slice('LIGHTING_PLAYBACK_TEST:'.length)));
    calls.push({ cue: 'cue' in request.action ? request.action.cue ?? '' : '', action: request.action.action, executor: request.action.target === 'executor' ? request.action.executor : '' });
  });
  const page = await app.firstWindow();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('link:ma2-network-status');
      ipcMain.handle('link:ma2-network-status', () => ({ state: 'connected', settings: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' }, passwordSaved: false, version: '3.9.60.74', error: null }));
      ipcMain.removeHandler('link:ma2-play-cue');
      ipcMain.handle('link:ma2-play-cue', (_event, value: unknown) => { console.log('LIGHTING_PLAYBACK_TEST:' + JSON.stringify(value)); });
      ipcMain.removeHandler('link:ma2-play-cancel'); ipcMain.handle('link:ma2-play-cancel', () => undefined);
    });
    const midi = await stubMidiPorts(app, { outputs: ['Preview MTC'] });
    if (scenario === 'timecode') {
      const profile = createDefaultIntegrationProfile();
      profile.midiPortProfiles.push({ id: 'preview-mtc', direction: 'output', portName: 'Preview MTC' });
      profile.internalPlayer = { mtcOutputPortProfileId: 'preview-mtc', audioOutputDeviceId: 'default' };
      await page.evaluate(value => window.tbLink.saveIntegrationProfile({ profile: value }), profile);
      await page.reload();
    }
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
    await expect(page.locator('.audio-segment-canvas[data-ready=true]').first()).toBeVisible({ timeout: 15000 });
    const audio = page.locator('.timeline-audio-engine');
    if (empty) {
      await page.locator('.waveform-cue-point').click();
      await expect(page.locator('.cue-ingredient')).toHaveCount(0);
      await expect(page.getByRole('button', { name: '灯光提示', exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: '播放时间线', exact: true }).click();
      await expect.poll(() => audio.evaluate(element => (element as HTMLAudioElement).currentTime)).toBeGreaterThan(1);
      await page.getByRole('button', { name: '停止时间线', exact: true }).click();
      expect(calls).toEqual([]);
      expect(await midi.sent()).toEqual([]);
      await expect(page.getByText('请先在设备设置里选择 MIDI 时间码输出', { exact: false })).toHaveCount(0);
      return;
    }
    if (scenario === 'no-port') {
      await page.getByRole('button', { name: '播放时间线', exact: true }).click();
      await expect(page.getByText('请先在设备设置里选择 MIDI 时间码输出', { exact: false }).first()).toBeVisible();
      await expect(page.getByRole('button', { name: '播放时间线', exact: true })).toBeVisible();
      expect(calls).toEqual([]);
      expect(await midi.sent()).toEqual([]);
      await page.screenshot({ path: info.outputPath('no-port.png') });
      return;
    }
    await expect(page.getByRole('combobox', { name: '灯光输出方式' })).toHaveCount(0);
    for (const width of [1440, 1060]) {
      await page.setViewportSize({ width, height: 900 });
      const bounds = await page.locator('.lighting-output-route').boundingBox();
      const toolbar = await page.locator('.timeline-transport').boundingBox();
      expect(bounds!.y).toBeGreaterThanOrEqual(toolbar!.y);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(toolbar!.y + toolbar!.height);
      expect(bounds!.height).toBeLessThan(40);
    }
    await page.getByRole('button', { name: '播放时间线', exact: true }).click();
    // Quarter frames reach the timecode port while the music plays past every Cue on the timeline.
    await expect.poll(async () => (await midi.sent('Preview MTC')).filter(bytes => bytes[0] === 0xf1).length, { timeout: 5000 }).toBeGreaterThan(8);
    await expect.poll(() => audio.evaluate(element => (element as HTMLAudioElement).currentTime), { timeout: 8000 }).toBeGreaterThan(4.5);
    await page.getByRole('button', { name: '暂停时间线', exact: true }).click();
    expect(calls).toEqual([]);
    await page.getByRole('button', { name: '停止时间线', exact: true }).click();
    await expect.poll(() => calls).toEqual([{ cue: '', action: 'off', executor: '51.101' }]);
    await expect(page.locator('.timeline-transport code')).toHaveText('00:00');
    await page.screenshot({ path: info.outputPath('playback.png') });
  } finally { await closeDiscarding(app); }
});
