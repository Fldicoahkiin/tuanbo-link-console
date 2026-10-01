import { test, expect, _electron as electron } from '@playwright/test';
import { writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createEmptyLinkProject, createLightingDocument, lightingTrackSchema, ma2PlaybackRequestSchema, parseLinkProject } from '@tb/schema';

for (const playbackSource of ['internal', 'p1'] as const) test(`埋步 ${playbackSource} 编辑、保存重开、时间线跟随与关闭`, async ({}, info) => {
  const wav = Buffer.alloc(44 + 48000 * 12 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await writeFile(info.outputPath('dance.wav'), wav);
  const track = lightingTrackSchema.parse({ id: 'track', name: '灯光', kind: 'ma2', color: '#68c9ed', group: 'effect-canvas', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, cueStamp: { mode: 'fixed', sequence: 168, cue: '2', executor: '' }, clips: [{ id: 'clip', name: '副歌', start: 0, duration: 12000, timeLock: 'time', muted: false, events: [{ id: 'cue', at: 5000, kind: 'ma2', action: 'goto', sequence: 168, cue: '2', executor: '', label: '副歌蓝光' }] }] });
  const project = parseLinkProject({ ...createEmptyLinkProject('埋步验收'), schemaVersion: 2, playbackSource, rundown: [{ id: 'dance', title: '埋步验收', cues: [], referenceAudio: { assetId: 'audio', relativePath: 'dance.wav', sha256: createHash('sha256').update(wav).digest('hex'), durationMs: 12000 }, lighting: { ...createLightingDocument(), outputMode: 'network', tracks: [track], templates: [{ id: 'prepared', name: '灭灯蓝光就位', track: { ...track, id: 'template-track', cueStamp: { mode: 'fixed', sequence: 168, cue: '1', executor: '' }, clips: [] } }] } }] });
  const file = info.outputPath('preparation.tblink'); await writeFile(file, JSON.stringify(project));
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')] });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1400, 900); });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    const openWorkbench = async (): Promise<void> => {
      await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
      if (!await page.getByLabel('选中 Cue 实时播放', { exact: true }).isVisible()) await page.locator('.lighting-playback-settings summary').click();
      await page.getByLabel('选中 Cue 实时播放', { exact: true }).uncheck();
      await page.getByRole('button', { name: '音频 Cue 2', exact: true }).click();
    };
    const calls: { cue: string | undefined; at: number }[] = [];
    if (playbackSource === 'p1') {
      app.on('console', message => {
        if (!message.text().startsWith('PREPARATION_TEST:')) return;
        const request = ma2PlaybackRequestSchema.parse(JSON.parse(message.text().slice('PREPARATION_TEST:'.length)));
        calls.push({ cue: request.action.cue, at: Date.now() });
      });
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('link:ma2-network-status');
        ipcMain.handle('link:ma2-network-status', () => ({ state: 'connected', settings: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' }, passwordSaved: false, version: '3.9.60.74', error: null }));
        ipcMain.removeHandler('link:ma2-play-cue'); ipcMain.handle('link:ma2-play-cue', (_event, request: unknown) => { console.log('PREPARATION_TEST:' + JSON.stringify(request)); });
        ipcMain.removeHandler('link:ma2-play-cancel'); ipcMain.handle('link:ma2-play-cancel', () => undefined);
      });
    }
    await openWorkbench();
    await expect(page.locator('.cue-preparation')).not.toHaveAttribute('open');
    await page.locator('.cue-preparation summary').click();
    await page.getByLabel('素材 1 启用埋步', { exact: true }).check();
    await page.getByLabel('素材 1 准备 Cue', { exact: true }).fill('1');
    await page.getByLabel('素材 1 埋步提前秒数', { exact: true }).fill('2');
    await page.getByLabel('素材 1 埋步提前秒数', { exact: true }).press('Tab');
    await expect(page.locator('.cue-preparation-body output')).toContainText('3.000 秒开始准备 → 5.000 秒正式亮灯');
    await page.getByRole('button', { name: '保存 Cue', exact: true }).click();
    await expect(page.locator('.waveform-cue-preparation')).toHaveCount(1);
    await page.keyboard.press('Control+s');
    const savedCue = async () => parseLinkProject(JSON.parse(await readFile(file, 'utf8'))).rundown[0]?.lighting?.tracks.flatMap(value => value.clips.flatMap(clip => clip.events)).find(event => event.kind === 'ma2');
    await expect.poll(async () => { const cue = await savedCue(); return cue?.kind === 'ma2' ? cue.preparation : null; }).toEqual({ cue: '1', leadMs: 2000 });
    if (playbackSource === 'p1') {
      await page.getByLabel('时间线播放控制灯光', { exact: true }).check();
      await page.getByRole('button', { name: '回到时间线开头', exact: true }).click();
      await page.getByRole('button', { name: '播放时间线', exact: true }).click();
      await expect.poll(() => calls.map(value => value.cue), { timeout: 10000 }).toEqual(['1', '2']);
      expect(calls[1]!.at - calls[0]!.at).toBeGreaterThan(1750);
      await page.getByRole('button', { name: '暂停时间线', exact: true }).click();
    }
    await page.screenshot({ path: info.outputPath('preparation-editor.png') });
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '节目单', exact: true }).click();
    await page.getByLabel('工程菜单', { exact: true }).click();
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await openWorkbench();
    if (!await page.locator('.cue-preparation').getAttribute('open').then(value => value !== null)) await page.locator('.cue-preparation summary').click();
    await expect(page.getByLabel('素材 1 准备 Cue', { exact: true })).toHaveValue('1');
    await expect(page.getByLabel('素材 1 埋步提前秒数', { exact: true })).toHaveValue('2');
    await page.getByRole('button', { name: '音频 Cue 2', exact: true }).dblclick();
    await page.getByLabel('时间（秒）', { exact: true }).fill('7');
    await page.getByRole('button', { name: '保存卡点', exact: true }).click();
    await expect(page.locator('.cue-preparation-body output')).toContainText('5.000 秒开始准备 → 7.000 秒正式亮灯');
    await page.getByLabel('素材 1 启用埋步', { exact: true }).uncheck();
    await page.getByRole('button', { name: '保存 Cue', exact: true }).click();
    await expect(page.locator('.waveform-cue-preparation')).toHaveCount(0);
    await page.keyboard.press('Control+s');
    await expect.poll(async () => { const cue = await savedCue(); return cue?.kind === 'ma2' ? cue.preparation ?? null : 'missing'; }).toBe(null);
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});
