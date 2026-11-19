import { test, expect, _electron as electron } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEmptyLinkProject, createLightingDocument, lightingTrackSchema, parseLinkProject } from '@tb/schema';
import { recordStartCheckDialogs } from './start-check';

test('时间码关联待核对：不弹窗直接播放，只显示一条准确提示，并可直接检查关联（2026-10-26）', async ({}, info) => {
  const wav = Buffer.alloc(44 + 48000 * 30 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await mkdir(info.outputPath('assets/reference-audio'), { recursive: true }); await writeFile(info.outputPath('assets/reference-audio/song.wav'), wav);
  const track = lightingTrackSchema.parse({ id: 'track', name: '灯光', kind: 'ma2', color: '#68c9ed', group: 'effect-canvas', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: 'clip', name: '灯光', start: 0, duration: 30000, timeLock: 'time', muted: false, events: [{ id: 'cue', kind: 'ma2', at: 1000, sequence: 168, cue: '1.000', executor: '', action: 'goto', label: '1' }] }] });
  const entries = [2, 3].map(target => ({ target, name: `歌曲 ${target}`, eventCount: 0, frameFormat: '30 FPS', offset: '1800', slot: 'TC Slot 2', events: [], error: null, warnings: [] }));
  const project = parseLinkProject({ ...createEmptyLinkProject('时间码提示回归'), schemaVersion: 2, playbackSource: 'internal', obsOutputMode: 'scenes',
    rundown: [{ id: 'song', title: '歌曲', cues: [], playback: { volume: 100, endAction: 'stop', startMs: 0, endMs: 0, mtcOffsetMs: 60_000, shortcut: '' }, referenceAudio: { assetId: 'audio', relativePath: 'assets/reference-audio/song.wav', durationMs: 30000, sha256: createHash('sha256').update(wav).digest('hex') }, lighting: { ...createLightingDocument(), tracks: [track] } }],
    ma2ReadState: { source: 'console', catalog: { directory: { show: 'test', generation: 'test', version: '3.9.60.74', entries: entries.map(({target, name}) => ({target, name})) }, readAt: new Date().toISOString(), entries }, pairs: {}, pairings: {}, failures: [], selectedTarget: null, query: '', filter: 'all', message: '' } });
  const file = info.outputPath('project.tblink'); await writeFile(file, JSON.stringify(project));
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')], env: { ...process.env, TBLINK_LOCAL_TEST_ACCESS: '1' } });
  const page = await app.firstWindow();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, file);
    const startChecks = await recordStartCheckDialogs(app);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
    // The output mode selector is gone (1d7d5bd); the notice follows the song's lighting state alone.
    await expect(page.getByRole('combobox', { name: '灯光输出方式' })).toHaveCount(0);
    await page.getByRole('button', { name: '灯光提示', exact: true }).click();
    const menu = page.getByRole('dialog', { name: '灯光提示', exact: true });
    await expect(menu.getByText(/Timecode 2、3 的起点都是/)).toBeVisible();
    await expect(page.locator('.lighting-output-route .song-mtc-start')).toHaveAttribute('data-state', 'warning');
    await page.keyboard.press('Escape');
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.getByRole('button', { name: '播放时间线', exact: true }).click();
      await expect(page.getByRole('button', { name: '暂停时间线', exact: true })).toBeVisible();
      const notices = page.getByRole('region', { name: '通知', exact: true });
      await expect(notices.getByText(/Timecode 2、3.*时间码照常发送/)).toHaveCount(1);
      await expect(notices.getByText(/按开关设置输出/)).toHaveCount(0);
      const pairingNotice = notices.locator('.toast.info').filter({ hasText: /Timecode 2、3/ });
      await expect(pairingNotice).toHaveCount(1);
      await expect(pairingNotice).not.toHaveText(/OBS 没有连接[\s\S]*OBS 没有连接/);
      await page.getByRole('button', { name: '停止时间线', exact: true }).click();
      await expect(page.getByRole('button', { name: '播放时间线', exact: true })).toBeVisible();
    }
    expect(await startChecks()).toEqual([]);
    await page.getByRole('button', { name: '灯光提示', exact: true }).click();
    await page.getByRole('button', { name: '查看控台时间线', exact: true }).click();
    await expect(page.locator('.lighting-output-timelines')).toHaveAttribute('aria-pressed', 'true');
    expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath('timecode-pairing-review.png') });
  } finally {
    await page.evaluate(async () => { await window.tbLink.setRuntimeActive(false); await window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null }); });
    await app.close();
  }
});
