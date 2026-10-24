import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { test, expect, _electron as electron } from '@playwright/test';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject, type Ma2SongSyncRequest, type Ma2SongSyncResult } from '@tb/schema';
import { saveProject, savedValue } from './save-questions';

for (const targetPage of [1000, 1234]) test(`整曲 40 Cue 创建到按钮 ${targetPage} 页，默认页保存恢复、双向同步保留新默认值与原位置`, async ({}, info) => {
  test.setTimeout(120000);
  const wav = Buffer.alloc(44 + 24000 * 10 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await mkdir(info.outputPath('assets/reference-audio'), { recursive: true }); await writeFile(info.outputPath('assets/reference-audio/reference.wav'), wav);
  const lighting = createLightingDocument(); lighting.outputMode = 'network';
  lighting.tracks = [{ id: 'track', name: '灯光', kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false, channel: 1, controller: 7, portProfileId: '', noteNames: {}, clips: [{ id: 'clip', name: '整曲', start: 0, duration: 10000, timeLock: 'time', muted: false, events: Array.from({ length: 40 }, (_, i) => ({ id: `point-${i}`, kind: 'empty-cue', label: `第 ${i + 1} 段`, at: i * 200 + 100, runMode: 'independent' })) }] }];
  const source = { show: '歌曲同步验收', generation: 'fixture', version: '3.7.0.5' };
  const project = parseLinkProject({ ...createEmptyLinkProject('歌曲同步验收'), schemaVersion: 2, ma2MaterialLibrary: { version: 1, source: '192.0.2.1:30000', library: { directory: { ...source, entries: [] }, readAt: new Date().toISOString(), sequences: [], fixtureUsage: [], errors: [] } }, rundown: [{ id: 'song', title: '新歌', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting, referenceAudio: { assetId: 'audio', relativePath: 'assets/reference-audio/reference.wav', durationMs: 10000, sha256: createHash('sha256').update(wav).digest('hex') } }] });
  const file = info.outputPath('song.tblink'); await writeFile(file, JSON.stringify(project));
  const savedProject = async () => parseLinkProject(JSON.parse(await readFile(file, 'utf8')));
  const saved = async () => (await savedProject()).rundown[0]!.lighting!;
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')], env: { ...process.env, TBLINK_LOCAL_TEST_ACCESS: '1' } });
  const page = await app.firstWindow(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await app.evaluate(({ ipcMain, dialog }, { file, source, targetPage }) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [file] });
      process.env.TBLINK_SONG_SYNC_CALLS = '0';
      ipcMain.removeHandler('link:ma2-song-check'); ipcMain.handle('link:ma2-song-check', () => Boolean(process.env.TBLINK_SONG_REMOTE_NAME));
      // A song without an MTC start reads the console's Timecode shows before its first sync; this console has none.
      ipcMain.removeHandler('link:ma2-timecode-ranges'); ipcMain.handle('link:ma2-timecode-ranges', () => ({ show: source.show, entries: [] }));
      ipcMain.removeHandler('link:ma2-network-status'); ipcMain.handle('link:ma2-network-status', () => ({ state: process.env.TBLINK_SONG_OFFLINE ? 'disconnected' : 'connected', settings: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test', autoConnect: false }, version: '3.7.0.5', passwordSaved: false, error: null }));
      ipcMain.removeHandler('link:ma2-effect-library'); ipcMain.handle('link:ma2-effect-library', () => {
        if (process.env.TBLINK_SONG_OFFLINE) throw new Error('验收：控台已断开');
        const last = process.env.TBLINK_SONG_LAST_REQUEST ? JSON.parse(process.env.TBLINK_SONG_LAST_REQUEST) as Ma2SongSyncRequest : null;
        return { directory: { ...source, entries: last ? [{ target: last.binding?.sequence ?? last.settings.nextSequence, name: last.name }] : [] }, readAt: new Date().toISOString(), sequences: [], fixtureUsage: [], errors: [] };
      });
      ipcMain.removeHandler('link:ma2-layout'); ipcMain.handle('link:ma2-layout', (_event, request: { layout: number }) => ({ layout: request.layout, name: '指定页面', readAt: new Date().toISOString(), items: [], omittedFixtures: 0 }));
      ipcMain.removeHandler('link:ma2-executor-pages'); ipcMain.handle('link:ma2-executor-pages', () => ({ ...source, buttonPage: 4, faderPage: 100, pages: [{ page: 4, name: '常用' }, { page: targetPage, name: '歌曲编排' }] }));
      ipcMain.removeHandler('link:ma2-executor-page'); ipcMain.handle('link:ma2-executor-page', (_event, request: { page: number }) => ({ page: request.page, name: '歌曲编排', readAt: new Date().toISOString(), source, items: [], sequences: [] }));
      ipcMain.removeHandler('link:ma2-song-sync'); ipcMain.handle('link:ma2-song-sync', (_event, request: Ma2SongSyncRequest): Ma2SongSyncResult => {
        if (process.env.TBLINK_SONG_OFFLINE) throw new Error('验收：控台已断开');
        process.env.TBLINK_SONG_SYNC_CALLS = String(Number(process.env.TBLINK_SONG_SYNC_CALLS) + 1);
        process.env.TBLINK_SONG_LAST_REQUEST = JSON.stringify(request);
        const target = request.binding?.sequence ?? request.settings.nextSequence;
        const cues = request.points.map((point, i) => ({ index: i + 1, number: `${i + 1}.000`,
          name: i === 1 && process.env.TBLINK_SONG_REMOTE_NAME ? process.env.TBLINK_SONG_REMOTE_NAME : point.name }));
        return { binding: { endpoint: '192.0.2.1:30000', show: source.show, layout: null, executor: `${request.settings.executorPage}.101`, sequence: target, name: request.name, points: request.points.map((point, i) => ({ id: point.id, cue: cues[i]!.number })),
          baselineXml: `<Fixture>${JSON.stringify(cues)}</Fixture>` },
          library: { directory: { ...source, entries: [{ target, name: request.name }] }, readAt: new Date().toISOString(), sequences: [{ sequence: target, name: request.name, cues }], fixtureUsage: [], errors: [] },
          layout: null, changed: !request.binding || !request.points.length, backupFile: '' };
      });
    }, { file, source, targetPage });
    await page.evaluate(() => {
      localStorage.setItem('tblink.ma2-connection-method.v1', 'network');
      localStorage.setItem('tblink.ma2-realtime-enabled.v1', 'false');
    });
    await page.reload();
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('button', { name: '灯光工作台', exact: true }).click();
    await page.locator('.lighting-playback-settings > summary').click();
    await page.getByRole('checkbox', { name: '选中 Cue 实时播放', exact: true }).uncheck();
    await page.locator('.lighting-playback-settings > summary').click();
    const pool = page.getByRole('region', { name: 'MA2 序列预览' });
    await pool.getByRole('button', { name: '控台页面', exact: true }).click();
    await pool.getByRole('button', { name: '新建 Cue', exact: true }).click();
    const panel = page.locator('.ma2-layout-panel');
    const song = panel.getByRole('region', { name: '本曲控台序列' });
    await expect(song.getByLabel('默认创建按钮页')).toHaveValue('1000');
    if (targetPage !== 1000) {
      await song.getByLabel('默认创建按钮页').fill('0');
      await song.getByRole('button', { name: '保存默认', exact: true }).click();
      await expect(song.getByRole('alert')).toContainText('1–9999');
      await saveProject(page);
      expect((await savedProject()).ma2MaterialLibrary?.userLibrary?.consoleWorkspace?.executorPage).toBeUndefined();
      await song.getByLabel('默认创建按钮页').fill(String(targetPage));
      await song.getByRole('button', { name: '保存默认', exact: true }).click();
      await expect(song).toContainText(`默认第 ${targetPage} 页，保存工程后写入工程文件`);
      await saveProject(page);
      expect((await savedProject()).ma2MaterialLibrary?.userLibrary?.consoleWorkspace?.executorPage).toBe(targetPage);
      await page.reload();
      await page.getByRole('button', { name: '灯光工作台', exact: true }).click();
      await pool.getByRole('button', { name: '控台页面', exact: true }).click();
      await pool.getByRole('button', { name: '新建 Cue', exact: true }).click();
      await expect(song.getByLabel('默认创建按钮页')).toHaveValue(String(targetPage));
    }
    if (targetPage === 1000) {
      // A fresh installation starts synchronization without a manual create.
      await page.evaluate(() => localStorage.removeItem('tblink.ma2-realtime-enabled.v1'));
      await page.reload();
      await page.getByRole('button', { name: '灯光工作台', exact: true }).click();
      await expect(page.getByRole('switch', { name: '实时同步', exact: true })).toHaveAttribute('aria-checked', 'true');
      await pool.getByRole('button', { name: '控台页面', exact: true }).click();
    } else await song.getByRole('button', { name: `创建到按钮第 ${targetPage} 页并同步`, exact: true }).click();
    await expect.poll(() => savedValue(page, async () => (await saved()).consoleSong?.points.length)).toBe(40);
    expect((await saved()).consoleSong).toMatchObject({ layout: null, executor: `${targetPage}.101`, sequence: 9000 });
    expect((await saved()).tracks.flatMap(track => track.clips.flatMap(clip => clip.events)).every(event => event.kind === 'ma2' && event.sequence === 9000)).toBe(true);
    await expect(pool.getByLabel('上层按钮页码', { exact: true })).toHaveValue(String(targetPage));
    await expect(panel).toHaveCount(0);
    await pool.getByRole('button', { name: '新建 Cue', exact: true }).click();
    await song.getByLabel('默认创建按钮页').fill('2000');
    await song.getByRole('button', { name: '保存默认', exact: true }).click();
    await expect(song).toContainText('默认第 2000 页，保存工程后写入工程文件');
    await page.screenshot({ path: info.outputPath('default-creation-page.png') });
    await page.locator('.waveform-cue-point').first().click();
    const composer = page.locator('.cue-composer');
    await expect(composer).toBeVisible(); await expect(panel).toHaveCount(0);
    await expect(composer).toContainText(`按钮第 ${targetPage} 页 · 101 格`);
    await composer.getByRole('button', { name: '跟随上一个', exact: true }).click();
    await expect(composer.getByRole('button', { name: '跟随上一个', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await composer.getByLabel('Cue 名称', { exact: true }).fill('电脑修改开场');
    await composer.getByLabel('Cue 名称', { exact: true }).press('Tab');
    await expect.poll(async () => (JSON.parse(await app.evaluate(() => process.env.TBLINK_SONG_LAST_REQUEST ?? '{}')) as Ma2SongSyncRequest).points?.[0]?.name).toBe('电脑修改开场');
    await app.evaluate(() => { process.env.TBLINK_SONG_REMOTE_NAME = '控台修改第二步'; });
    await expect.poll(() => savedValue(page, async () => (await saved()).tracks.flatMap(track => track.clips.flatMap(clip => clip.events)).find(event => event.id === 'point-1'))).toMatchObject({ label: '控台修改第二步' });
    expect((await savedProject()).ma2MaterialLibrary?.userLibrary?.consoleWorkspace?.executorPage).toBe(2000);
    expect((await saved()).consoleSong?.executor).toBe(`${targetPage}.101`);
    await pool.getByRole('button', { name: '新建 Cue', exact: true }).click(); await expect(panel).toBeVisible();
    await expect(song.getByLabel('默认创建按钮页')).toHaveValue('2000');
    await page.locator('.waveform-cue-point').first().click();
    await expect(panel).toHaveCount(0); await expect(composer).toBeVisible();
    await expect(composer.getByLabel('Cue 名称', { exact: true })).toHaveValue('电脑修改开场');
    await page.screenshot({ path: info.outputPath('song-40-cues.png') });
    await app.evaluate(() => { process.env.TBLINK_SONG_OFFLINE = 'true'; });
    await expect(page.getByRole('button', { name: '同步状态详情' })).toContainText('等待连接');
    await composer.getByLabel('Cue 名称', { exact: true }).fill('断线期间继续修改');
    await composer.getByLabel('Cue 名称', { exact: true }).press('Tab');
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: '保存', exact: true }).first()).toBeEnabled();
    await expect.poll(() => savedValue(page, async () => (await saved()).tracks.flatMap(track => track.clips.flatMap(clip => clip.events)).find(event => event.id === 'point-0'))).toMatchObject({ label: '断线期间继续修改' });
    await app.evaluate(() => { delete process.env.TBLINK_SONG_OFFLINE; });
    await expect.poll(async () => (JSON.parse(await app.evaluate(() => process.env.TBLINK_SONG_LAST_REQUEST ?? '{}')) as Ma2SongSyncRequest).points?.[0]?.name).toBe('断线期间继续修改');
    await saveProject(page);
    expect((await saved()).consoleSong?.executor).toBe(`${targetPage}.101`);
    if (targetPage === 1234) {
      // Deleting every step on the timeline deletes the console Cues in the same sync: no review list, no waiting.
      await page.getByRole('switch', { name: '实时同步', exact: true }).click();
      await expect(page.getByRole('switch', { name: '实时同步', exact: true })).toHaveAttribute('aria-checked', 'false');
      for (let index = 0; index < 40; index++) {
        await page.locator('.waveform-cue-point').first().click();
        await page.locator('.waveform-cue-point').first().press('Delete');
      }
      await expect.poll(() => savedValue(page, async () => (await saved()).tracks.flatMap(track => track.clips.flatMap(clip => clip.events)).length)).toBe(0);
      await page.getByRole('switch', { name: '实时同步', exact: true }).click();
      await expect.poll(() => savedValue(page, async () => (await saved()).consoleSong?.points.length)).toBe(0);
      const cleared = JSON.parse(await app.evaluate(() => process.env.TBLINK_SONG_LAST_REQUEST ?? '{}')) as Ma2SongSyncRequest;
      expect(cleared.points).toEqual([]); expect(cleared).not.toHaveProperty('confirmedDeletions');
      await saveProject(page);
      expect((await saved()).consoleSong).toMatchObject({ sequence: 9000, executor: '1234.101', points: [] });
      expect((await savedProject()).ma2MaterialLibrary?.library?.sequences.find(sequence => sequence.sequence === 9000)?.cues).toEqual([]);
      // 刷新同步 reads the console again at once.
      const calls = Number(await app.evaluate(() => process.env.TBLINK_SONG_SYNC_CALLS));
      await page.getByRole('button', { name: '刷新同步', exact: true }).click();
      await expect.poll(async () => Number(await app.evaluate(() => process.env.TBLINK_SONG_SYNC_CALLS))).toBeGreaterThan(calls);
      await page.screenshot({ path: info.outputPath('song-cleared.png') });
    }
    await page.getByRole('switch', { name: '实时同步', exact: true }).click();
    await expect(page.getByRole('switch', { name: '实时同步', exact: true })).toHaveAttribute('aria-checked', 'false');
    expect(errors).toEqual([]);
  } finally { await page.evaluate(() => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null })); await app.close(); }
});
