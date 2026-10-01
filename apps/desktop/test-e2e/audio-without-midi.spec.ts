import { test, expect, _electron as electron } from '@playwright/test';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject } from '@tb/schema';

test('OBS 和 MIDI 均未连接时，有音频仍可开始播放', async ({}, info) => {
  const wav = Buffer.alloc(44 + 8000 * 8, 128);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await writeFile(info.outputPath('audio.wav'), wav);
  const lighting = createLightingDocument();
  lighting.ma2Bindings = [{ id: 'native', timecode: 2, name: '现场时间线', readAt: '2026-09-28T00:00:00.000Z', sourceXml: '<MA/>', mappings: [], baselineTracks: [], timeOriginMs: 480000, playback: 'native-timecode' }];
  const project = parseLinkProject({ ...createEmptyLinkProject('离线音频'), schemaVersion: 2, playbackSource: 'internal', rundown: [{ id: 'song', title: '仅有音频', referenceAudio: { assetId: 'audio', relativePath: 'audio.wav', durationMs: 8000, sha256: createHash('sha256').update(wav).digest('hex') }, lighting }] });
  const file = info.outputPath('audio.tblink'); await writeFile(file, JSON.stringify(project));
  const executablePath = process.env.TBLINK_PACKAGED_APP_EXE;
  const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [`--user-data-dir=${info.outputPath('profile')}`, ...(executablePath ? [] : [join(process.cwd(), 'out/main/index.cjs')])] });
  try {
    if (process.platform === 'win32') expect(await app.evaluate(({ app }) => app.isHardwareAccelerationEnabled())).toBe(false);
    const page = await app.firstWindow();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: () => Promise.reject(new Error('未连接 MIDI 设备')) });
    });
    await page.reload();
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.locator('.player-transport .primary-button').click();
    await expect(page.locator('.player-transport.status-playing')).toBeVisible();
    await expect(page.getByText(/MIDI 时间码未输出.*本次继续播放音频/).first()).toBeVisible();
    await expect(page.getByText(/OBS 未连接.*本次继续播放音频/).first()).toBeVisible();
    await page.getByRole('button', { name: '停止播放', exact: true }).click();
  } finally { await app.close(); }
});
