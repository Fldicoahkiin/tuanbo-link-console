import { test, expect, _electron as electron } from '@playwright/test';
import { createHash } from 'node:crypto';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import OBSWebSocket, { EventSubscription } from 'obs-websocket-js';
import { z } from 'zod';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { createDefaultIntegrationProfile } from '../src/renderer/src/link/view-models/local-integration-profile';

test('正式原生按钮驱动隔离 OBS：精确音频采集、编排切场景、暂停和继续', async ({}, info) => {
  test.skip(!process.env.TBLINK_TEST_OBS_URL || !process.env.TBLINK_TEST_OBS_AUDIO, '由隔离 OBS 验收脚本启动，不连接用户 OBS');
  const wav = await readFile(process.env.TBLINK_TEST_OBS_AUDIO!);
  await copyFile(process.env.TBLINK_TEST_OBS_AUDIO!, info.outputPath('tone.wav'));
  const sha256 = createHash('sha256').update(wav).digest('hex');
  const project = parseLinkProject({ ...createEmptyLinkProject('正式原生 OBS 验收'), playbackSource: 'internal', obsOutputMode: 'scenes',
    rundown: [{ id: 'song', title: '原生节目', referenceAudio: { assetId: 'audio', relativePath: 'tone.wav', sha256, durationMs: 20000 },
      playback: { startMs: 500, endMs: 18000, mtcOffsetMs: 480000, volume: 100, endAction: 'pause', shortcut: '' },
      cues: [0, 3].map((second, index) => ({ id: `cue-${index}`, name: `场景 ${index}`, timecode: { hours: 0, minutes: 0, seconds: second, frames: 0 },
        actions: [{ id: `action-${index}`, kind: 'obs.setProgramScene', label: '原生声音跨机位', sceneName: index ? 'Audio B' : 'Audio' }] })) }] });
  const file = info.outputPath('project.tblink'); await writeFile(file, JSON.stringify(project));
  const profile = createDefaultIntegrationProfile(); profile.obs.autoConnectOnLaunch = false; profile.obs.webSocketUrl = process.env.TBLINK_TEST_OBS_URL!;
  profile.internalPlayer = { audioEngine: 'native', nativeAudioOutputDeviceId: 'default', audioOutputDeviceId: 'default', mtcOutputPortProfileId: null, audioSampleRate: 48000 };
  const obs = new OBSWebSocket();
  const readings: { at: number; phase: string; levels: number[][] }[] = []; let phase = 'starting';
  await obs.connect(profile.obs.webSocketUrl, process.env.TBLINK_TEST_OBS_PASSWORD, { eventSubscriptions: EventSubscription.All | EventSubscription.InputVolumeMeters });
  obs.on('InputVolumeMeters', event => {
    for (const input of event.inputs) if (input.inputName === '团播联动台·内部正式音频') readings.push({ at: Date.now(), phase, levels: z.array(z.array(z.number())).parse(input.inputLevelsMul) });
  });
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), process.env.TBLINK_MTC_SOAK_BUILD_DIR ?? 'out', 'main/index.cjs')] });
  const page = await app.firstWindow(), errors: string[] = [], evidence: Record<string, unknown> = { passed: false, scope: '正式按钮、原生音频和真实 OBS 采集；无 MIDI、实体灯具或长时验收', readings };
  page.on('pageerror', error => errors.push(error.message));
  const peak = (label: string): number => Math.max(0, ...readings.filter(reading => reading.phase === label).flatMap(reading => reading.levels.flat()));
  try {
    await page.waitForFunction(() => Boolean(window.tbLink));
    await page.evaluate(({ profile, password }) => window.tbLink.saveIntegrationProfile({ profile, obsPassword: password }), { profile, password: process.env.TBLINK_TEST_OBS_PASSWORD! });
    await page.reload(); await page.waitForFunction(() => Boolean(window.tbLink));
    await page.evaluate(() => window.tbLink.connectObs());
    await page.evaluate(({ file, sha256 }) => window.tbLink.saveWaveformCache({ projectPath: file, sha256, peaks: Array.from({ length: 2400 }, () => 0) }), { file, sha256 });
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [file] }); }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.locator('.player-transport .primary-button').click();
    await expect(page.locator('.player-transport.status-playing')).toBeVisible();
    await expect.poll(() => peak('starting'), { timeout: 2000 }).toBeGreaterThan(0.005);
    const state = await page.evaluate(() => window.tbLink.getNativePlaybackStatus());
    expect(state).toMatchObject({ status: 'playing', offsetMs: 480000, audioError: null, underruns: 0 });
    const settings = await obs.call('GetInputSettings', { inputName: '团播联动台·内部正式音频' });
    expect(settings.inputSettings.window).toContain(`TBLINK Audio ${state!.enginePid}:Static:tblink-playback.exe`);
    const special = await obs.call('GetSpecialInputs'); expect(special.desktop1).toBeNull(); expect(special.desktop2).toBeNull();
    const blocked = page.evaluate(() => { const until = performance.now() + 4000; while (performance.now() < until) { /* Verify the real button no longer schedules OBS in this renderer. */ } });
    await expect.poll(async () => (await obs.call('GetCurrentProgramScene')).currentProgramSceneName, { timeout: 5000 }).toBe('Audio B');
    await blocked;
    const background = await page.evaluate(() => window.tbLink.getNativeObsStatus());
    expect(background).toMatchObject({ state: 'running', currentCueId: 'cue-1', reason: null });
    phase = 'scene-b'; await expect.poll(() => peak('scene-b')).toBeGreaterThan(0.005);
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.tbLink.getNativePlaybackStatus()))?.status).toBe('paused');
    await page.waitForTimeout(300); phase = 'paused'; await page.waitForTimeout(300);
    expect(readings.some(reading => reading.phase === 'paused' && reading.levels.length > 0)).toBe(true); expect(peak('paused')).toBeLessThan(0.0001);
    await page.locator('.player-transport .primary-button').click();
    phase = 'resumed'; await expect.poll(() => peak('resumed')).toBeGreaterThan(0.005);
    await page.getByRole('button', { name: '停止播放', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.tbLink.getNativePlaybackStatus()))?.status).toBe('stopped');
    expect(errors).toEqual([]);
    const stateErrors = await page.evaluate(async () => (await window.tbLink.queryLogs({ limit: 500 })).filter(entry => entry.category === 'state' && entry.level === 'error'));
    evidence.stateErrors = stateErrors; expect(stateErrors).toEqual([]);
    Object.assign(evidence, { passed: true, state, settings, background, rendererBlockedMs: 4000, errors, engineSha256: createHash('sha256').update(await readFile(process.env.TBLINK_PLAYBACK_ENGINE_EXE!)).digest('hex') });
  } finally {
    await writeFile(info.outputPath('evidence.json'), JSON.stringify(evidence, null, 2));
    await page.screenshot({ path: info.outputPath('final.png') });
    await page.getByRole('button', { name: '停止播放', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.tbLink.getNativePlaybackStatus()))?.status).toBe('stopped');
    await page.evaluate(async () => { await window.tbLink.setRuntimeActive(false); await window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null }); });
    await app.close(); await obs.disconnect();
  }
});
