import { test, expect, _electron as electron } from '@playwright/test';
import { copyFile, readFile, writeFile, appendFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { OBSWebSocket, EventSubscription } from 'obs-websocket-js';
import { z } from 'zod';
import { parseLinkProject } from '@tb/schema';
import { createDefaultIntegrationProfile } from '../src/renderer/src/link/view-models/local-integration-profile';

test('高负载正式按钮与真实 OBS 连续节目', async ({}, info) => {
  test.skip(process.env.TBLINK_VERIFY_LOAD_UI !== '1' || !process.env.TBLINK_TEST_OBS_URL || !process.env.TBLINK_STABILITY_FIXTURE,
    '需隔离 OBS 和高负载工程；不连接用户正式 OBS');
  const seconds = Number(process.env.TBLINK_NATIVE_OBS_LOAD_SECONDS ?? 120);
  if (!Number.isInteger(seconds) || seconds < 120 || seconds > 21600) throw new Error('OBS连续节目验收时长必须为120至21600秒');
  test.setTimeout(seconds * 1000 + 120000);
  const original = resolve(process.env.TBLINK_STABILITY_FIXTURE!);
  const file = join(dirname(original), `output-acceptance-${randomUUID()}.tblink`); await copyFile(original, file);
  const project = parseLinkProject(JSON.parse(await readFile(file, 'utf8')));
  // Keep the original load fixture untouched (other long tests may be using
  // its hard-linked audio). A continuous pilot makes meter dropout observable;
  // the original 20 ms pulse once per second can fall between WS meter samples.
  const probe = Buffer.alloc(44 + 108 * 48000 * 4);
  probe.write('RIFF'); probe.writeUInt32LE(probe.length - 8, 4); probe.write('WAVEfmt ', 8); probe.writeUInt32LE(16, 16);
  probe.writeUInt16LE(1, 20); probe.writeUInt16LE(2, 22); probe.writeUInt32LE(48000, 24); probe.writeUInt32LE(192000, 28);
  probe.writeUInt16LE(4, 32); probe.writeUInt16LE(16, 34); probe.write('data', 36); probe.writeUInt32LE(probe.length - 44, 40);
  for (let frame = 0; frame < 108 * 48000; frame++) {
    const value = Math.round(128 * Math.sin(frame * 400 * 2 * Math.PI / 48000)
      + (frame % 48000 < 960 ? 512 * Math.sin(frame * 1000 * 2 * Math.PI / 48000) : 0));
    probe.writeInt16LE(value, 44 + frame * 4); probe.writeInt16LE(value, 46 + frame * 4);
  }
  const probeName = `${basename(file, '.tblink')}.wav`, probeSha256 = createHash('sha256').update(probe).digest('hex');
  await writeFile(join(dirname(file), probeName), probe);
  for (const item of project.rundown) {
    if (!item.referenceAudio || item.referenceAudio.durationMs !== 108000) throw new Error('持续电平验收要求每节目108秒的合成音源');
    item.referenceAudio = { ...item.referenceAudio, relativePath: probeName, sha256: probeSha256 };
  }
  await writeFile(file, JSON.stringify(project));
  expect(project.rundown).toHaveLength(200); expect(project.mediaAssets).toHaveLength(2000);
  expect(project.rundown.reduce((count, item) => count + item.cues.length + (item.lighting?.tracks.reduce((n, track) => n + track.clips.reduce((events, clip) => events + clip.events.length, 0), 0) ?? 0), 0)).toBe(50000);
  const obs = new OBSWebSocket(), errors: string[] = [], programs = new Set<string>();
  await obs.connect(process.env.TBLINK_TEST_OBS_URL, process.env.TBLINK_TEST_OBS_PASSWORD, { eventSubscriptions: EventSubscription.All | EventSubscription.InputVolumeMeters });
  let audioPeak = 0, lastAudibleAt = -Infinity;
  obs.on('InputVolumeMeters', event => {
    for (const input of event.inputs) if (input.inputName === '团播联动台·内部正式音频') {
      const levels = z.array(z.array(z.number().finite())).safeParse(input.inputLevelsMul);
      if (!levels.success) errors.push(`OBS 音频电平格式无效：${levels.error.message}`);
      else {
        const peak = Math.max(...levels.data.flat());
        audioPeak = Math.max(audioPeak, peak);
        if (peak > 0.001) lastAudibleAt = performance.now();
      }
    }
  });
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), process.env.TBLINK_MTC_SOAK_BUILD_DIR ?? 'out', 'main/index.cjs')] });
  const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  let passed = false, failure: string | null = null;
  let initialRender: { skipped: number; total: number } | null = null;
  let latestRender: { skipped: number; total: number } | null = null;
  try {
    expect(await obs.call('GetVideoSettings')).toMatchObject({ baseWidth: 2160, baseHeight: 3840, outputWidth: 2160, outputHeight: 3840, fpsNumerator: 60, fpsDenominator: 1 });
    const profile = createDefaultIntegrationProfile(); profile.obs.autoConnectOnLaunch = false; profile.obs.webSocketUrl = process.env.TBLINK_TEST_OBS_URL!;
    profile.internalPlayer = { audioEngine: 'native', nativeAudioOutputDeviceId: 'default', audioOutputDeviceId: 'default', mtcOutputPortProfileId: null, audioSampleRate: 48000 };
    await page.waitForFunction(() => Boolean(window.tbLink));
    await page.evaluate(({ profile, password }) => window.tbLink.saveIntegrationProfile({ profile, obsPassword: password }), { profile, password: process.env.TBLINK_TEST_OBS_PASSWORD! });
    await page.reload(); await page.waitForFunction(() => Boolean(window.tbLink)); await page.evaluate(() => window.tbLink.connectObs());
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await expect(page.locator('[data-total-programs]')).toHaveAttribute('data-total-programs', '200');
    await page.keyboard.press('Control+KeyM'); // Dedicated loopback is owned by the concurrent native soak.
    // This case measures prepared multi-channel playback. Opening a cold show
    // and immediately pressing Play is a separate audio-only admission case;
    // do not extend the production one-second participation deadline.
    const preloadingAt = performance.now();
    await expect.poll(async () => (await page.evaluate(() => window.tbLink.queryLogs({ limit: 1000 })))
      .some(entry => entry.itemId === project.rundown[0]!.id && entry.message === '画面准备 · 机位结构' && entry.result === 'succeeded'),
    { timeout: 60000, message: '选定节目必须在点击播放前完成真实 OBS 预备，不能用 sleep 或模拟就绪替代' }).toBe(true);
    await writeFile(info.outputPath('initial-preload.json'), JSON.stringify({ elapsedMs: performance.now() - preloadingAt, itemId: project.rundown[0]!.id }));
    await page.locator('.player-transport .primary-button').click();
    await expect(page.locator('.player-transport.status-playing')).toBeVisible();
    const started = performance.now(), initial = await obs.call('GetStats');
    initialRender = { skipped: initial.renderSkippedFrames, total: initial.renderTotalFrames };
    for (let index = 0; performance.now() - started < seconds * 1000; index++) {
      const status = await page.evaluate(async () => ({ audio: await window.tbLink.getNativePlaybackStatus(), visual: await window.tbLink.getNativeObsStatus() }));
      const stats = await obs.call('GetStats');
      latestRender = { skipped: stats.renderSkippedFrames, total: stats.renderTotalFrames };
      const audioSignalAgeMs = performance.now() - lastAudibleAt;
      await appendFile(info.outputPath('samples.ndjson'), JSON.stringify({ at: new Date().toISOString(), elapsedMs: performance.now() - started, audioPeak, audioSignalAgeMs, ...status, stats }) + '\n');
      expect(status.audio?.audioError).toBeNull(); expect(status.audio?.underruns).toBe(0);
      expect(status.visual?.state, `后台画面失败：${status.visual?.reason}`).not.toBe('failed');
      // During an explicit next-song preparation, the old visual session must
      // stop. Once audio plays, the exact new visual session must be running.
      if (status.audio?.status === 'preparing') expect(status.visual?.state).toMatch(/^(stopped|preparing|ready)$/);
      if (status.audio?.status === 'playing') {
        programs.add(status.audio.itemId);
        expect(status.visual).toMatchObject({ state: 'running', itemId: status.audio.itemId, reason: null });
        if (status.audio.positionMs > 1000) expect(audioSignalAgeMs, '切歌后仍必须持续取得真实 OBS 音频电平，历史峰值不能代替当前采集').toBeLessThan(1000);
      }
      if (index === 5) expect(audioPeak, 'OBS 必须收到正式音频，进度前进不能替代采集').toBeGreaterThan(0.001);
      expect(errors).toEqual([]); await page.waitForTimeout(500);
    }
    const final = await obs.call('GetStats');
    latestRender = { skipped: final.renderSkippedFrames, total: final.renderTotalFrames };
    expect(programs.size).toBeGreaterThanOrEqual(Math.min(200, Math.floor(seconds / 108) + 1));
    expect((final.renderSkippedFrames - initial.renderSkippedFrames) / Math.max(1, final.renderTotalFrames - initial.renderTotalFrames)).toBeLessThanOrEqual(0.001);
    passed = true;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error); throw error;
  } finally {
    const logs = await page.evaluate(() => window.tbLink.queryLogs({ limit: 1000 }));
    await writeFile(info.outputPath('logs.json'), JSON.stringify(logs, null, 2));
    await writeFile(info.outputPath('evidence.json'), JSON.stringify({ passed, failure, seconds,
      render: { initial: initialRender, latest: latestRender, skippedRatio: initialRender && latestRender
        ? (latestRender.skipped - initialRender.skipped) / Math.max(1, latestRender.total - initialRender.total) : null },
      scope: '真实正式按钮、WASAPI 和隔离 OBS；无 MIDI/实体 MA2，非六小时及实际像素时序验收', programs: [...programs], audioPeak, errors,
      audioProbe: { file: join(dirname(file), probeName), sha256: probeSha256, description: '108秒48kHz双声道：连续低电平400Hz导频叠加每秒20ms的1000Hz脉冲；原始负载工程未改动' },
      engineSha256: createHash('sha256').update(await readFile(process.env.TBLINK_PLAYBACK_ENGINE_EXE!)).digest('hex') }, null, 2));
    await page.screenshot({ path: info.outputPath('final.png') });
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await page.evaluate(() => window.tbLink.getNativePlaybackStatus()))?.status).toBe('stopped');
    await page.evaluate(async () => { await window.tbLink.setRuntimeActive(false); await window.tbLink.setDocumentDirty(false); });
    await app.close(); await obs.disconnect();
  }
});
