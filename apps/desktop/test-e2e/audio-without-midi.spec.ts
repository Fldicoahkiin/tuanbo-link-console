import { test, expect, _electron as electron } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject } from '@tb/schema';
import { answerStartCheck } from './start-check';
import { closeDiscarding } from './save-questions';
import { stubMidiPorts } from './midi-ports';

test('OBS 和 MIDI 均未连接时，有音频仍可开始播放', async ({}, info) => {
  const wav = Buffer.alloc(44 + 8000 * 40, 128);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await mkdir(info.outputPath('assets/reference-audio'), { recursive: true });
  await writeFile(info.outputPath('assets/reference-audio/audio.wav'), wav);
  const lighting = createLightingDocument();
  lighting.ma2Bindings = [{ id: 'native', timecode: 2, name: '现场时间线', readAt: '2026-09-28T00:00:00.000Z', sourceXml: '<MA/>', mappings: [], baselineTracks: [], timeOriginMs: 480000, playback: 'native-timecode' }];
  const project = parseLinkProject({ ...createEmptyLinkProject('离线音频'), schemaVersion: 2, playbackSource: 'internal', rundown: [{ id: 'song', title: '仅有音频', referenceAudio: { assetId: 'audio', relativePath: 'assets/reference-audio/audio.wav', durationMs: 40000, sha256: createHash('sha256').update(wav).digest('hex') }, lighting }] });
  const file = info.outputPath('audio.tblink'); await writeFile(file, JSON.stringify(project));
  const executablePath = process.env.TBLINK_PACKAGED_APP_EXE;
  const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [`--user-data-dir=${info.outputPath('profile')}`, ...(executablePath ? [] : [join(process.cwd(), 'out/main/index.cjs')])] });
  try {
    if (process.platform === 'win32') expect(await app.evaluate(({ app }) => app.isHardwareAccelerationEnabled())).toBe(false);
    const page = await app.firstWindow();
    await stubMidiPorts(app);
    await page.reload();
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, file);
    // The console timeline is not yet confirmed for this song, so the start check asks; the operator plays without lighting.
    const startChecks = await answerStartCheck(app);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    const waveform = page.locator('.unified-player .home-waveform-monitor');
    const before = await waveform.boundingBox();
    expect(before).not.toBeNull();
    await page.locator('.player-transport .primary-button').click();
    await expect(page.locator('.player-transport.status-playing')).toBeVisible();
    expect(await startChecks()).toEqual([expect.stringContaining('这首歌的灯光需要处理')]);
    await expect(page.locator('.player-diagnostics')).toHaveAttribute('data-status', 'notice');
    await expect(page.locator('.player-notice')).not.toBeVisible();
    expect(await waveform.boundingBox()).toEqual(before);
    await page.locator('.player-diagnostics > summary').click();
    await expect(page.getByText(/不带灯光播放/).first()).toBeVisible();
    await expect(page.getByText(/音频照常播放。原因：OBS 未连接/).first()).toBeVisible();
    expect(await waveform.boundingBox()).toEqual(before);
    await page.keyboard.press('Escape');
    await expect(page.locator('.player-notice')).not.toBeVisible();
    await expect(page.locator('.player-diagnostics > summary')).toBeFocused();
    for (const width of [1440, 1100]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setSize(width, 800), width);
      const closed = await waveform.boundingBox();
      await page.locator('.player-diagnostics > summary').click();
      await expect(page.locator('.player-notice')).toBeVisible();
      expect(await waveform.boundingBox()).toEqual(closed);
      const panel = await page.locator('.player-diagnostics-popover').boundingBox();
      expect(panel).not.toBeNull();
      expect(panel!.x).toBeGreaterThanOrEqual(0);
      expect(panel!.x + panel!.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
      await page.screenshot({ path: info.outputPath(`playback-details-${width}.png`) });
      await page.getByRole('button', { name: '关闭播放状态详情' }).click();
      await expect(page.locator('.player-notice')).not.toBeVisible();
    }
    await page.locator('.player-diagnostics > summary').click();
    await page.getByRole('region', { name: '实时音频频谱' }).click();
    await expect(page.locator('.player-notice')).not.toBeVisible();
    await page.screenshot({ path: info.outputPath('playback-compact.png') });
    await page.getByRole('button', { name: '停止播放', exact: true }).click();
  } finally {
    await closeDiscarding(app);
  }
});

test('真实损坏音频报错不挤压播放器，修复文件后可重新播放', async ({}, info) => {
  const wav = Buffer.alloc(44 + 8000 * 15, 128);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  const audioPath = info.outputPath('assets/reference-audio/damaged.wav');
  await mkdir(info.outputPath('assets/reference-audio'), { recursive: true });
  await writeFile(audioPath, 'invalid audio');
  const project = parseLinkProject({ ...createEmptyLinkProject('音频故障恢复'), playbackSource: 'internal', rundown: [{ id: 'song', title: '故障恢复', referenceAudio: { assetId: 'audio', relativePath: 'assets/reference-audio/damaged.wav', durationMs: 15000, sha256: createHash('sha256').update(wav).digest('hex') } }] });
  const file = info.outputPath('recovery.tblink'); await writeFile(file, JSON.stringify(project));
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')] });
  try {
    const page = await app.firstWindow();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await stubMidiPorts(app);
    await page.reload();
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    const waveform = page.locator('.unified-player .home-waveform-monitor');
    const before = await waveform.boundingBox();
    await page.locator('.player-transport .primary-button').click();
    await expect(page.locator('.player-transport.status-error')).toBeVisible();
    await expect(page.locator('.player-diagnostics')).toHaveAttribute('data-status', 'error');
    await expect(page.locator('.player-error')).not.toBeVisible();
    expect(await waveform.boundingBox()).toEqual(before);
    await page.locator('.player-diagnostics > summary').press('Enter');
    await expect(page.locator('.player-error')).toBeVisible();
    await expect(page.locator('.player-error')).toContainText(/音频/);
    expect(await page.locator('.player-diagnostics > summary').evaluate(element => getComputedStyle(element).color))
      .toBe(await page.locator('.player-error').evaluate(element => getComputedStyle(element).color));
    expect(await waveform.boundingBox()).toEqual(before);
    await page.screenshot({ path: info.outputPath('audio-error-details.png') });
    await page.keyboard.press('Escape');
    await writeFile(audioPath, wav);
    await page.locator('.player-transport .primary-button').click();
    await expect(page.locator('.player-transport.status-playing')).toBeVisible();
    await expect(page.locator('.player-error')).toHaveCount(0);
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.locator('.player-transport .primary-button').click();
      await expect(page.locator('.player-transport.status-paused')).toBeVisible();
      await page.locator('.player-transport .primary-button').click();
      await expect(page.locator('.player-transport.status-playing')).toBeVisible();
    }
    expect(errors).toEqual([]);
    await page.getByRole('button', { name: '停止播放', exact: true }).click();
  } finally {
    await closeDiscarding(app);
  }
});
