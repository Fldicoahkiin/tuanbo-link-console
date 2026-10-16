import { test, expect, _electron as electron } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { createDefaultIntegrationProfile } from '../src/renderer/src/link/view-models/local-integration-profile';

test('正式播放按钮使用原生音频：切页、界面阻塞、暂停继续、关闭时间码、切歌及播完暂停', async ({}, info) => {
  test.skip(process.env.TBLINK_NATIVE_ENGINE_TEST !== '1', '需要真实 WASAPI；不占用正在长测的 MIDI 端口');
  const wav = Buffer.alloc(44 + 48000 * 4 * 20);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(192000, 28);
  wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  for (let frame = 0; frame < 48000 * 20; frame++) { const tone = Math.round(128 * Math.sin(frame * 2 * Math.PI * 1500 / 48000)); wav.writeInt16LE(tone, 44 + frame * 4); wav.writeInt16LE(tone, 46 + frame * 4); }
  const sha256 = createHash('sha256').update(wav).digest('hex'); await writeFile(info.outputPath('tone.wav'), wav);
  const project = parseLinkProject({ ...createEmptyLinkProject('原生正式按钮验收'), playbackSource: 'internal', obsOutputMode: 'scenes',
    rundown: [0, 1].map(index => ({ id: `song-${index}`, title: `正式音频 ${index + 1}`, referenceAudio: { assetId: `audio-${index}`, relativePath: 'tone.wav', sha256, durationMs: 20000 },
      playback: { startMs: index ? 0 : 500, endMs: index ? 1500 : 18000, mtcOffsetMs: 480000 + index * 20000, volume: 50, endAction: 'pause', shortcut: '' } })) });
  const file = info.outputPath('project.tblink'); await writeFile(file, JSON.stringify(project));
  const profile = createDefaultIntegrationProfile(); profile.obs.autoConnectOnLaunch = false;
  profile.internalPlayer = { audioEngine: 'native', nativeAudioOutputDeviceId: 'default', audioOutputDeviceId: 'default', mtcOutputPortProfileId: null, audioSampleRate: 48000, fadeInMs: 300 };
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), process.env.TBLINK_MTC_SOAK_BUILD_DIR ?? 'out', 'main/index.cjs')] });
  const page = await app.firstWindow(), errors: string[] = [], evidence: Record<string, unknown> = { passed: false, scope: '真实正式播放按钮 → 原生 WASAPI；无 MIDI、OBS、实体控台，不代表六小时或高负载完整节目' };
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.waitForFunction(() => Boolean(window.tbLink));
    await page.evaluate(profile => window.tbLink.saveIntegrationProfile({ profile }), profile); await page.reload();
    await page.waitForFunction(() => Boolean(window.tbLink));
    await page.evaluate(({ file, sha256 }) => window.tbLink.saveWaveformCache({ projectPath: file, sha256, peaks: Array.from({ length: 2400 }, () => 0) }), { file, sha256 });
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [file] }); }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.evaluate(() => { const Original = AudioContext; Reflect.set(window, '__audioContexts', 0); Reflect.set(window, 'AudioContext', class extends Original { constructor(options?: AudioContextOptions) { super(options); Reflect.set(window, '__audioContexts', (Reflect.get(window, '__audioContexts') as number) + 1); } }); });
    await page.locator('.player-transport .primary-button').click();
    await expect(page.locator('.player-transport.status-playing')).toBeVisible();
    const before = await page.evaluate(() => window.tbLink.getNativePlaybackStatus());
    const displayedBefore = await page.locator('.p1-time-monitor dd').first().innerText();
    expect(before).toMatchObject({ itemId: 'song-0', status: 'playing', offsetMs: 480000, audioError: null, underruns: 0 });
    await app.evaluate(({ app, dialog }) => {
      dialog.showMessageBoxSync = () => { throw new Error('运行退出提示不应阻塞主进程'); };
      dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false });
      app.quit();
    });
    expect((await page.evaluate(() => window.tbLink.getNativePlaybackStatus()))?.status).toBe('playing');
    await page.evaluate(() => { const end = performance.now() + 900; while (performance.now() < end) { /* Deliberate renderer stall. */ } });
    const after = await page.evaluate(() => window.tbLink.getNativePlaybackStatus());
    expect(after!.positionMs - before!.positionMs).toBeGreaterThan(800); expect(after!.audioError).toBeNull();
    await expect(page.locator('.p1-time-monitor dd').first()).not.toHaveText(displayedBefore);
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
    await expect(page.locator('.reference-timeline')).toBeVisible();
    expect((await page.evaluate(() => window.tbLink.getNativePlaybackStatus()))?.status).toBe('playing');
    await page.getByRole('button', { name: '暂停时间线', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.tbLink.getNativePlaybackStatus()))?.status).toBe('paused');
    const paused = await page.evaluate(() => window.tbLink.getNativePlaybackStatus());
    await page.waitForTimeout(200); expect((await page.evaluate(() => window.tbLink.getNativePlaybackStatus()))!.positionMs).toBe(paused!.positionMs);
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '节目单', exact: true }).click();
    const displayedPaused = await page.locator('.p1-time-monitor dd').first().innerText();
    await page.waitForTimeout(200);
    await expect(page.locator('.p1-time-monitor dd').first()).toHaveText(displayedPaused);
    await page.screenshot({ path: info.outputPath('paused-player.png') });
    await page.getByRole('textbox', { name: '节目名称', exact: true }).fill('暂停中修改名称');
    await page.getByRole('textbox', { name: '节目名称', exact: true }).press('Enter');
    await page.waitForTimeout(200);
    const afterEdit = await page.evaluate(() => window.tbLink.getNativePlaybackStatus());
    expect(afterEdit).toMatchObject({ sessionId: paused!.sessionId, status: 'paused', positionMs: paused!.positionMs });
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
    await page.getByRole('button', { name: '播放时间线', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.tbLink.getNativePlaybackStatus()))?.status).toBe('playing');
    await page.keyboard.press('Control+KeyM');
    await expect.poll(async () => (await page.evaluate(() => window.tbLink.getNativePlaybackStatus()))!.positionMs).toBeGreaterThan(paused!.positionMs + 100);
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '节目单', exact: true }).click();
    await page.getByRole('button', { name: '下一首', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.tbLink.getNativePlaybackStatus()))?.itemId).toBe('song-1');
    await expect(page.locator('.player-transport.status-paused')).toBeVisible();
    const ended = await page.evaluate(() => window.tbLink.getNativePlaybackStatus());
    expect(ended).toMatchObject({ status: 'ended', offsetMs: 500000, positionMs: 1500, underruns: 0, audioError: null });
    expect(await page.evaluate(() => Reflect.get(window, '__audioContexts') as number)).toBe(0);
    expect(errors).toEqual([]);
    const stateErrors = await page.evaluate(async () => (await window.tbLink.queryLogs({ limit: 500 })).filter(entry => entry.category === 'state' && entry.level === 'error'));
    evidence.stateErrors = stateErrors; expect(stateErrors).toEqual([]);
    await page.getByRole('button', { name: '停止播放', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.tbLink.getNativePlaybackStatus()))?.status).toBe('stopped');
    Object.assign(evidence, { passed: true, before, after, paused, afterEdit, ended, errors,
      engineSha256: createHash('sha256').update(await readFile(process.env.TBLINK_PLAYBACK_ENGINE_EXE ?? join(process.cwd(), '../../tools/playback-engine/bin/tblink-playback.exe'))).digest('hex') });
  } finally {
    await writeFile(info.outputPath('evidence.json'), JSON.stringify(evidence, null, 2));
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await page.evaluate(() => window.tbLink.getNativePlaybackStatus()))?.status).toBe('stopped');
    await page.evaluate(async () => { await window.tbLink.setRuntimeActive(false); await window.tbLink.setDocumentDirty(false); });
    await app.close();
  }
});
