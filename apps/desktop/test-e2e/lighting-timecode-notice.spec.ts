import { test, expect, _electron as electron } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEmptyLinkProject, createLightingDocument, lightingTrackSchema, parseLinkProject } from '@tb/schema';

test('时间码关联待核对：反复切换和播放只显示一条准确提示，并可直接检查关联', async ({}, info) => {
  const wav = Buffer.alloc(44 + 48000 * 30 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await mkdir(info.outputPath('assets/reference-audio'), { recursive: true }); await writeFile(info.outputPath('assets/reference-audio/song.wav'), wav);
  const track = lightingTrackSchema.parse({ id: 'track', name: '灯光', kind: 'ma2', color: '#68c9ed', group: 'effect-canvas', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: 'clip', name: '灯光', start: 0, duration: 30000, timeLock: 'time', muted: false, events: [{ id: 'cue', kind: 'ma2', at: 1000, sequence: 168, cue: '1.000', executor: '', action: 'goto', label: '1' }] }] });
  const project = parseLinkProject({ ...createEmptyLinkProject('时间码提示回归'), schemaVersion: 2, playbackSource: 'internal', obsOutputMode: 'scenes',
    rundown: [{ id: 'song', title: '歌曲', cues: [], referenceAudio: { assetId: 'audio', relativePath: 'assets/reference-audio/song.wav', durationMs: 30000, sha256: createHash('sha256').update(wav).digest('hex') }, lighting: { ...createLightingDocument(), outputMode: 'network', tracks: [track] } }],
    ma2ReadState: { source: 'console', catalog: { directory: { show: 'test', generation: 'test', version: '3.9.60.74', entries: [] }, readAt: new Date().toISOString(), entries: [] }, pairs: {}, pairings: { '2': { itemId: 'song', status: 'stale', evidence: '', reason: '音频已替换' } }, failures: [], selectedTarget: null, query: '', filter: 'all', message: '' } });
  const file = info.outputPath('project.tblink'); await writeFile(file, JSON.stringify(project));
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')], env: { ...process.env, TBLINK_LOCAL_TEST_ACCESS: '1' } });
  const page = await app.firstWindow();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
    for (const mode of ['timecode', 'direct', 'timecode', 'network', 'timecode']) await page.getByRole('combobox', { name: '灯光输出方式' }).selectOption(mode);
    await page.getByLabel('灯光输出提示', { exact: true }).click();
    await expect(page.getByText('时间码关联待核对', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.getByRole('button', { name: '播放时间线', exact: true }).click();
      await expect(page.getByRole('button', { name: '暂停时间线', exact: true })).toBeVisible();
      const notices = page.getByRole('region', { name: '通知', exact: true });
      await expect(notices.getByText(/当前歌曲与控台时间线尚未核对/)).toHaveCount(1);
      await expect(notices.getByText(/按开关设置输出/)).toHaveCount(0);
      await expect(notices.locator('.toast.info')).toHaveCount(1);
      await page.getByRole('button', { name: '停止时间线', exact: true }).click();
      await expect(page.getByRole('button', { name: '播放时间线', exact: true })).toBeVisible();
    }
    await page.getByLabel('灯光输出提示', { exact: true }).click();
    await page.getByRole('button', { name: '核对控台时间线', exact: true }).click();
    await expect(page.getByRole('heading', { name: '控台时间线', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath('timecode-pairing-review.png') });
  } finally {
    await page.evaluate(async () => { await window.tbLink.setRuntimeActive(false); await window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null }); });
    await app.close();
  }
});
