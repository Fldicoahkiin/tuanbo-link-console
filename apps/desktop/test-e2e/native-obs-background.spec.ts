import { test, expect, _electron as electron } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import OBSWebSocket, { EventSubscription } from 'obs-websocket-js';
import { z } from 'zod';
import { createEmptyLinkProject, parseLinkProject, type NativePlayerPrepare, type NativeObsPrepare } from '@tb/schema';
import { createObsProgramSnapshot } from '@tb/core/link';
import { createDefaultIntegrationProfile } from '../src/renderer/src/link/view-models/local-integration-profile';

test('后台画面服务在渲染器阻塞时按实际音频时钟切换隔离 OBS', async ({}, info) => {
  test.skip(!process.env.TBLINK_TEST_OBS_URL || !process.env.TBLINK_TEST_OBS_AUDIO, '需要专用隔离 OBS；不使用用户现场场景');
  const wav = await readFile(process.env.TBLINK_TEST_OBS_AUDIO!);
  await copyFile(process.env.TBLINK_TEST_OBS_AUDIO!, info.outputPath('tone.wav'));
  const sha256 = createHash('sha256').update(wav).digest('hex');
  const project = parseLinkProject({ ...createEmptyLinkProject('后台画面验收'), playbackSource: 'internal', obsOutputMode: 'scenes',
    rundown: [{ id: 'song', title: '后台节目', referenceAudio: { assetId: 'audio', relativePath: 'tone.wav', sha256, durationMs: 20000 },
      cues: [0, 3, 7].map((seconds, index) => ({ id: `cue-${index}`, name: `机位 ${index}`, timecode: { hours: 0, minutes: 0, seconds, frames: 0 },
        actions: [{ id: `scene-${index}`, label: '切换原生机位', kind: 'obs.setProgramScene', sceneName: index === 1 ? 'Audio B' : 'Audio' }] })) }] });
  const file = info.outputPath('project.tblink'); await writeFile(file, JSON.stringify(project));
  const profile = createDefaultIntegrationProfile(); profile.obs.autoConnectOnLaunch = false; profile.obs.webSocketUrl = process.env.TBLINK_TEST_OBS_URL!;
  const audio: NativePlayerPrepare = { version: 1, sessionId: randomUUID(), generation: 1, projectPath: file, audioDeviceId: 'default', midiPortName: null,
    snapshot: { version: 1, projectId: project.projectId, itemId: 'song', revision: 1, audio: { relativePath: 'tone.wav', sha256, durationMs: 20000 },
      startMs: 500, positionMs: 500, endMs: 18000, offsetMs: 480000, frameRate: 30, sampleRate: 48000, volume: 1 } };
  const visual: NativeObsPrepare = { version: 1, sessionId: audio.sessionId, generation: 1, projectPath: file,
    preciseSeeking: false, snapshot: createObsProgramSnapshot(project, 'song', 1) };
  const obs = new OBSWebSocket(), scenes: { name: string; at: number }[] = [];
  await obs.connect(profile.obs.webSocketUrl, process.env.TBLINK_TEST_OBS_PASSWORD, { eventSubscriptions: EventSubscription.All });
  const transitions = z.array(z.object({ transitionName: z.string(), transitionKind: z.string() })).parse((await obs.call('GetSceneTransitionList')).transitions);
  const cut = transitions.find(transition => transition.transitionKind === 'cut_transition');
  if (!cut) throw new Error('隔离 OBS 缺少直接切换转场');
  await obs.call('SetCurrentSceneTransition', { transitionName: cut.transitionName });
  obs.on('CurrentProgramSceneChanged', event => scenes.push({ name: event.sceneName, at: Date.now() }));
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), process.env.TBLINK_MTC_SOAK_BUILD_DIR ?? 'out', 'main/index.cjs')] });
  const page = await app.firstWindow(), evidence: Record<string, unknown> = { passed: false, scenes,
    scope: '真实 Electron 类型化后台接口、WASAPI、隔离 OBS；本测试不走正式播放按钮，不代表视频高负载、MIDI、实体 MA2 或六小时验收' };
  try {
    await page.waitForFunction(() => Boolean(window.tbLink));
    await page.evaluate(({ profile, password }) => window.tbLink.saveIntegrationProfile({ profile, obsPassword: password }), { profile, password: process.env.TBLINK_TEST_OBS_PASSWORD! });
    await page.evaluate(() => window.tbLink.connectObs());
    await page.evaluate(audio => window.tbLink.prepareNativePlayback(audio), audio);
    const ready = await page.evaluate(visual => window.tbLink.prepareNativeObs(visual), visual);
    expect(ready.state).toBe('ready'); expect((await obs.call('GetCurrentProgramScene')).currentProgramSceneName).toBe('Audio');
    await page.evaluate(audio => window.tbLink.controlNativePlayback({ version: 1, sessionId: audio.sessionId, generation: 2, kind: 'play' }), audio);
    const blockStarted = Date.now();
    const blocked = page.evaluate(() => { const until = performance.now() + 4000; while (performance.now() < until) { /* Intentional renderer stall. */ } });
    await expect.poll(async () => (await obs.call('GetCurrentProgramScene')).currentProgramSceneName, { timeout: 3500, intervals: [50] }).toBe('Audio B');
    await expect.poll(() => scenes.some(scene => scene.name === 'Audio B'), { timeout: 500, intervals: [10] }).toBe(true);
    const changedAt = scenes.find(scene => scene.name === 'Audio B')!.at;
    expect(changedAt - blockStarted).toBeLessThan(3500);
    await blocked;
    const status = await page.evaluate(() => window.tbLink.getNativePlaybackStatus());
    const running = await page.evaluate(() => window.tbLink.getNativeObsStatus());
    expect(status).toMatchObject({ status: 'playing', offsetMs: 480000, underruns: 0, audioError: null });
    expect(running).toMatchObject({ state: 'running', currentCueId: 'cue-1', nextCueId: 'cue-2', reason: null });
    await page.evaluate(audio => window.tbLink.controlNativePlayback({ version: 1, sessionId: audio.sessionId, generation: 3, kind: 'pause' }), audio);
    await expect.poll(async () => (await page.evaluate(() => window.tbLink.getNativeObsStatus()))?.state).toBe('paused');
    await page.waitForTimeout(300);
    await page.evaluate(audio => window.tbLink.controlNativePlayback({ version: 1, sessionId: audio.sessionId, generation: 4, kind: 'play' }), audio);
    await expect.poll(async () => (await obs.call('GetCurrentProgramScene')).currentProgramSceneName, { timeout: 5000 }).toBe('Audio');
    await page.evaluate(audio => window.tbLink.controlNativePlayback({ version: 1, sessionId: audio.sessionId, generation: 5, kind: 'stop' }), audio);
    await expect.poll(async () => (await page.evaluate(() => window.tbLink.getNativeObsStatus()))?.state).toBe('stopped');
    evidence.passed = true; Object.assign(evidence, { status, running, blockStarted, changedAt, ready });
  } finally {
    await writeFile(info.outputPath('evidence.json'), JSON.stringify(evidence, null, 2));
    await page.evaluate(async audio => {
      const state = await window.tbLink.getNativePlaybackStatus();
      if (state) await window.tbLink.controlNativePlayback({ version: 1, sessionId: audio.sessionId, generation: 100, kind: 'stop' });
      await window.tbLink.setRuntimeActive(false); await window.tbLink.setDocumentDirty(false);
    }, audio);
    await app.close(); await obs.disconnect();
  }
});
