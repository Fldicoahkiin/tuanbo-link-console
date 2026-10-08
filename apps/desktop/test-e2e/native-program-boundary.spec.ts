import { test, expect, _electron as electron } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { createDefaultIntegrationProfile } from '../src/renderer/src/link/view-models/local-integration-profile';

for (const crash of [false, true]) test(`正式节目后台接续：界面繁忙跨越曲尾${crash ? '后界面崩溃停止自有输出并可退出' : '仍继续下一首'}`, async ({}, info) => {
  test.skip(process.env.TBLINK_NATIVE_ENGINE_TEST !== '1', '真实WASAPI边界测试；不启用MIDI或用户OBS');
  const wav = Buffer.alloc(44 + 48000 * 4 * 10);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(192000, 28);
  wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  const sha256 = createHash('sha256').update(wav).digest('hex'); await writeFile(info.outputPath('silence.wav'), wav);
  const project = parseLinkProject({ ...createEmptyLinkProject('曲尾后台接续验收'), playbackSource: 'internal', obsOutputMode: 'scenes',
    rundown: [0, 1].map(index => ({ id: `song-${index}`, title: `接续节目 ${index + 1}`,
      referenceAudio: { assetId: `audio-${index}`, relativePath: 'silence.wav', sha256, durationMs: 10000 },
      playback: { startMs: index ? 500 : 0, endMs: index ? 9500 : 1200, mtcOffsetMs: index ? 600000 : 480000,
        volume: 0, endAction: index ? 'pause' : 'next', shortcut: '' } })) });
  const file = info.outputPath('project.tblink'); await writeFile(file, JSON.stringify(project));
  const profile = createDefaultIntegrationProfile(); profile.obs.autoConnectOnLaunch = false;
  profile.internalPlayer = { audioEngine: 'native', nativeAudioOutputDeviceId: 'default', audioOutputDeviceId: 'default', mtcOutputPortProfileId: null, audioSampleRate: 48000 };
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), process.env.TBLINK_MTC_SOAK_BUILD_DIR ?? 'out', 'main/index.cjs')] });
  const page = await app.firstWindow();
  const evidence: Record<string, unknown> = { passed: false, scope: '真实正式按钮/WASAPI曲尾跨界面阻塞；无OBS/MIDI/灯具，不代替完整六小时' };
  let crashed = false;
  try {
    await page.waitForFunction(() => Boolean(window.tbLink));
    await page.evaluate(profile => window.tbLink.saveIntegrationProfile({ profile }), profile); await page.reload();
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [file] }); }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.keyboard.press('Control+KeyM');
    await page.locator('.player-transport .primary-button').click();
    await expect(page.locator('.player-transport.status-playing')).toBeVisible();
    const before = await page.evaluate(() => window.tbLink.getNativePlaybackStatus()); evidence.before = before;
    expect(before).toMatchObject({ itemId: 'song-0', status: 'playing', mtcPortName: null });
    expect(before!.positionMs).toBeLessThan(1000);
    const blocked = await page.evaluate(async () => {
      const started = performance.now();
      while (performance.now() - started < 4000) { /* Deliberate renderer-only fault injection. */ }
      return { blockedMs: performance.now() - started, status: await window.tbLink.getNativePlaybackStatus() };
    });
    evidence.after = blocked;
    evidence.engineSha256 = createHash('sha256').update(await readFile(process.env.TBLINK_PLAYBACK_ENGINE_EXE!)).digest('hex');
    expect(blocked.status).toMatchObject({ itemId: 'song-1', status: 'playing', offsetMs: 600000, underruns: 0, audioError: null });
    // A start scheduled only after the renderer wakes is not a successful handoff.
    expect(blocked.status!.positionMs).toBeGreaterThan(2500);
    if (crash) {
      crashed = true;
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.forcefullyCrashRenderer());
      await expect.poll(async () => app.evaluate((_electron, pid) => {
        try { process.kill(pid, 0); return true; }
        catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false; throw error; }
      }, blocked.status!.enginePid!), { timeout: 10000 }).toBe(false);
      evidence.engineExitedAfterRendererCrash = true;
    }
    evidence.passed = true;
  } finally {
    await writeFile(info.outputPath('evidence.json'), JSON.stringify(evidence, null, 2));
    if (!crashed) {
      await page.keyboard.press('Escape');
      await expect.poll(async () => (await page.evaluate(() => window.tbLink.getNativePlaybackStatus()))?.status).toBe('stopped');
      await expect(page.locator('.player-transport.status-stopped')).toBeVisible();
      await page.evaluate(async () => { await window.tbLink.setRuntimeActive(false); await window.tbLink.setDocumentDirty(false); });
    }
    await app.close();
  }
});
