import { test, expect, _electron as electron } from '@playwright/test';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEmptyLinkProject, createLightingDocument, lightingTrackSchema, parseLinkProject } from '@tb/schema';
import { createDefaultIntegrationProfile } from '../src/renderer/src/link/view-models/local-integration-profile';

test('无 MA2 网线时按原偏移发 MTC；长时阻塞只停止发码，音频继续', async ({}, info) => {
  const wav = Buffer.alloc(44 + 8000 * 20, 128);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await writeFile(info.outputPath('clock.wav'), wav);
  const lighting = createLightingDocument(); lighting.outputMode = 'timecode';
  lighting.ma2Bindings = [{ id: 'native-timecode', timecode: 2, name: '离线控台时间线', readAt: '2026-09-28T00:00:00.000Z', sourceXml: '<MA/>', mappings: [], baselineTracks: [], timeOriginMs: 480000, playback: 'native-timecode' }];
  lighting.tracks = [lightingTrackSchema.parse({ id: 'pool', name: '本地序列池 Cue', kind: 'ma2', color: '#ffffff', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: 'pool-clip', name: '本地 Cue', start: 0, duration: 20000, timeLock: 'time', muted: false, events: [{ id: 'pool-cue', kind: 'ma2', action: 'goto', sequence: 36, cue: '1.100', executor: '', label: 'Cue 1.1', at: 1000 }] }] })];
  const project = parseLinkProject({ ...createEmptyLinkProject('时间码调度'), schemaVersion: 2, playbackSource: 'internal', obsOutputMode: 'scenes', rundown: [{ id: 'song', title: '时间码调度', cues: [{ id: 'scene', name: '画面', timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, actions: [{ id: 'action', kind: 'obs.setProgramScene', label: '画面', sceneName: '测试场景' }] }], referenceAudio: { assetId: 'audio', relativePath: 'clock.wav', durationMs: 20000, sha256: createHash('sha256').update(wav).digest('hex') }, playback: { volume: 100, endAction: 'stop', startMs: 0, endMs: 20000, mtcOffsetMs: 480000, shortcut: '' }, lighting }] });
  const file = info.outputPath('clock.tblink'); await writeFile(file, JSON.stringify(project));
  const executablePath = process.env.TBLINK_MA2_PACKAGED_EXE;
  const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [`--user-data-dir=${info.outputPath('profile')}`, ...(executablePath ? [] : [join(process.cwd(), 'out/main/index.cjs')])] });
  try {
    const page = await app.firstWindow();
    const profile = createDefaultIntegrationProfile();
    profile.midiPortProfiles.push({ id: 'test-output', direction: 'output', portName: '调度测试' });
    profile.internalPlayer = { mtcOutputPortProfileId: 'test-output', audioOutputDeviceId: 'default' };
    await page.evaluate(value => window.tbLink.saveIntegrationProfile({ profile: value }), profile);
    await page.addInitScript(() => {
      const messages: number[][] = []; Reflect.set(window, '__schedulingMessages', messages);
      const port = Object.assign(new EventTarget(), { id: 'test', type: 'output', name: '调度测试', state: 'connected', connection: 'open', open: () => Promise.resolve(port), send: (bytes: number[]) => messages.push([...bytes]) });
      const access = Object.assign(new EventTarget(), { inputs: new Map(), outputs: new Map([['test', port]]) });
      Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: () => Promise.resolve(access) });
      const play = Reflect.get(HTMLMediaElement.prototype, 'play') as (this: HTMLMediaElement) => Promise<void>;
      HTMLMediaElement.prototype.play = function(): Promise<void> { Reflect.set(window, '__schedulingAudio', this); return play.call(this); };
    });
    await page.reload();
    await app.evaluate(({ dialog, ipcMain, BrowserWindow }, path) => {
      process.env.TBLINK_OFFLINE_NETWORK_CALLS = '0';
      ipcMain.removeHandler('link:ma2-network-status');
      ipcMain.handle('link:ma2-network-status', () => ({ state: 'disconnected', settings: null, version: null, passwordSaved: false, error: null }));
      ipcMain.removeHandler('link:ma2-play-cue');
      ipcMain.handle('link:ma2-play-cue', () => { process.env.TBLINK_OFFLINE_NETWORK_CALLS = String(Number(process.env.TBLINK_OFFLINE_NETWORK_CALLS) + 1); throw new Error('离线演出不得调用网络 Cue'); });
      const status = { status: 'connected', obsVersion: '32.2.2', webSocketVersion: '5.6.3', error: null };
      const handlers: Record<string, () => unknown> = {
        'link:obs-connect': () => status, 'link:obs-snapshot': () => status,
        'link:security-preflight': () => ({ credentialDecryptable: true, logRedactionReady: true }),
        'link:obs-inventory': () => ({ videoSettings: { baseWidth: 1080, baseHeight: 1920 }, scenes: ['测试场景'], inputs: [], inputKinds: {}, sceneItems: { 测试场景: [] }, filters: {}, transitions: [], inputAudioStates: {}, sourceSizes: {} }),
        'link:obs-internal-audio': () => undefined, 'link:obs-execute': () => undefined
      };
      for (const [channel, handler] of Object.entries(handlers)) { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler); }
      BrowserWindow.getAllWindows()[0]!.webContents.send('link:obs-status', status);
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] });
    }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('link:obs-status', { status: 'connected', obsVersion: '32.2.2', webSocketVersion: '5.6.3', error: null }));
    await page.getByRole('button', { name: '播放时间线', exact: true }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '节目单', exact: true }).click();
    await page.locator('.player-diagnostics > summary').click();
    await expect(page.getByText(/本地序列池 Cue 不会单独发送/).first()).toBeVisible();
    const audioPosition = (): Promise<number> => page.evaluate(() => (Reflect.get(window, '__schedulingAudio') as HTMLMediaElement | undefined)?.currentTime ?? 0);
    try { await expect.poll(audioPosition).toBeGreaterThan(0.3); }
    catch (error) { await writeFile(info.outputPath('playback-state.txt'), await page.locator('body').innerText()); throw error; }
    const position = await audioPosition();
    await page.evaluate(() => { const until = performance.now() + 200; while (performance.now() < until) { /* Simulate a busy renderer, with audio continuing independently. */ } });
    await expect(page.getByText(/MIDI 时间码已停止.*音频继续播放/).first()).toBeVisible();
    const sentAfterStall = await page.evaluate(() => (Reflect.get(window, '__schedulingMessages') as number[][]).length);
    expect(await page.evaluate(() => (Reflect.get(window, '__schedulingMessages') as number[][]).filter(bytes => bytes[0] === 0xf0).length)).toBe(1);
    await expect.poll(() => page.evaluate(() => (Reflect.get(window, '__schedulingMessages') as number[][]).find(bytes => bytes[0] === 0xf0)?.slice(5, 9))).toEqual([0x60, 8, 0, 0]);
    expect(await app.evaluate(() => process.env.TBLINK_OFFLINE_NETWORK_CALLS)).toBe('0');
    await expect.poll(audioPosition).toBeGreaterThan(position + 0.5);
    expect(await page.evaluate(() => (Reflect.get(window, '__schedulingMessages') as number[][]).length)).toBe(sentAfterStall);
    await expect(page.getByText('MIDI 时间码发送延迟超过 100ms，已停止播放', { exact: true })).toHaveCount(0);
    await page.evaluate(() => { const until = performance.now() + 650; while (performance.now() < until) { /* A further stall must neither restart MIDI nor stop independent audio. */ } });
    await expect.poll(() => page.evaluate(() => (Reflect.get(window, '__schedulingAudio') as HTMLMediaElement | undefined)?.paused)).toBe(false);
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '节目单', exact: true }).click();
    await page.locator('.player-diagnostics > summary').click();
    await expect(page.getByText(/MIDI 时间码已停止.*音频继续播放/).first()).toBeVisible();
    await page.getByRole('button', { name: '停止播放', exact: true }).click();
  } finally {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript('window.tbLink.setRuntimeActive(false).then(() => window.tbLink.setDocumentDirty(false))'));
    await app.close();
  }
});
