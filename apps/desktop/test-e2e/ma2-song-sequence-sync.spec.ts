import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { test, expect, _electron as electron } from '@playwright/test';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject, type Ma2SongConflict, type Ma2SongSyncRequest, type Ma2SongSyncResult } from '@tb/schema';
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
        if (process.env.TBLINK_SONG_CLEAR_NATIVE && !request.points.length && request.binding) {
          const native = JSON.parse(process.env.TBLINK_SONG_CLEAR_NATIVE) as Array<{ index: number; number: string; name: string }>;
          const approved = new Set(request.confirmedDeletions ?? []);
          const cues = native.filter(cue => !approved.has(cue.number));
          if (approved.size) {
            process.env.TBLINK_SONG_CLEAR_NATIVE = JSON.stringify(cues);
            process.env.TBLINK_SONG_CLEAR_CONFIRMED = JSON.stringify(request.confirmedDeletions);
          }
          const points = request.binding.points.filter(point => cues.some(cue => cue.number === point.cue));
          return { binding: { ...request.binding, points, baselineXml: approved.size ? `<Fixture>${JSON.stringify(cues)}</Fixture>` : request.binding.baselineXml },
            library: { directory: { ...source, entries: [{ target, name: request.name }] }, readAt: new Date().toISOString(), sequences: [{ sequence: target, name: request.name, cues }], fixtureUsage: [], errors: [] },
            layout: null, changed: approved.size > 0, removed: [], backupFile: '',
            conflicts: points.map(point => ({ key: `${point.id}:cue-deletion`, field: 'cue-deletion', pointId: point.id, cue: point.cue,
              baseline: native.find(cue => cue.number === point.cue)?.name ?? '', local: '软件已移除', console: native.find(cue => cue.number === point.cue)?.name ?? '', token: 'd'.repeat(64) })) };
        }
        const consoleConflict = process.env.TBLINK_SONG_CONFLICT_NAME;
        const decision = request.conflictResolutions?.find(value => value.key === 'point-0:cue-name' && value.token === 'c'.repeat(64));
        if (decision) {
          process.env.TBLINK_SONG_CONFLICT_DECISION = JSON.stringify(decision);
          process.env.TBLINK_SONG_CONFLICT_RESOLVED = decision.choice;
        }
        const conflict = consoleConflict && !process.env.TBLINK_SONG_CONFLICT_RESOLVED && request.points[0]?.name === '软件冲突开场';
        const conflicts: Ma2SongConflict[] = conflict ? [{ key: 'point-0:cue-name', field: 'cue-name', pointId: 'point-0', cue: '1.000',
          baseline: '断线期间继续修改', local: request.points[0]!.name, console: consoleConflict, token: 'c'.repeat(64) }] : [];
        const cues = request.points.map((point, i) => ({ index: i + 1, number: `${i + 1}.000`,
          name: i === 0 && consoleConflict && (conflict || process.env.TBLINK_SONG_CONFLICT_RESOLVED === 'console') ? consoleConflict
            : i === 1 && process.env.TBLINK_SONG_REMOTE_NAME ? process.env.TBLINK_SONG_REMOTE_NAME : point.name }));
        return { binding: { endpoint: '192.0.2.1:30000', show: source.show, layout: null, executor: `${request.settings.executorPage}.101`, sequence: target, name: request.name, points: request.points.map((point, i) => ({ id: point.id, cue: cues[i]!.number })),
          baselineXml: conflict && request.binding ? request.binding.baselineXml : `<Fixture>${JSON.stringify(cues)}</Fixture>` },
          library: { directory: { ...source, entries: [{ target, name: request.name }] }, readAt: new Date().toISOString(), sequences: [{ sequence: target, name: request.name, cues }], fixtureUsage: [], errors: [] },
          layout: null, changed: !request.binding, removed: [], backupFile: '', conflicts };
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
      await saveProject(page);
      const existing = (await saved()).tracks.flatMap(track => track.clips.flatMap(clip => clip.events));
      await app.evaluate(() => { process.env.TBLINK_SONG_CONFLICT_NAME = '控台同时改开场'; });
      await composer.getByLabel('Cue 名称', { exact: true }).fill('软件冲突开场');
      await composer.getByLabel('Cue 名称', { exact: true }).press('Tab');
      await expect(page.getByRole('button', { name: '同步状态详情', exact: true })).toContainText('有修改待核对');
      await page.getByRole('button', { name: '同步状态详情', exact: true }).click();
      const details = page.getByRole('region', { name: '同步状态详情', exact: true });
      const conflict = details.getByLabel('两边修改核对');
      await expect(conflict).toContainText('软件冲突开场');
      await expect(conflict).toContainText('控台同时改开场');
      await expect(conflict.getByRole('button', { name: '采用软件', exact: true })).toBeEnabled();
      await expect(conflict.getByRole('button', { name: '采用控台', exact: true })).toBeEnabled();
      await expect(page.getByRole('button', { name: '保存', exact: true }).first()).toBeEnabled();
      await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeEnabled();
      await details.getByRole('button', { name: '关闭', exact: true }).click();
      // The conflict is local to this field. Editing another Cue remains usable.
      await page.locator('.waveform-cue-point').nth(2).click();
      await expect(composer.getByLabel('Cue 名称', { exact: true })).toBeEnabled();
      await composer.getByLabel('Cue 名称', { exact: true }).fill('冲突期间第三步仍可编辑');
      await composer.getByLabel('Cue 名称', { exact: true }).press('Tab');
      await expect.poll(async () => (JSON.parse(await app.evaluate(() => process.env.TBLINK_SONG_LAST_REQUEST ?? '{}')) as Ma2SongSyncRequest).points?.[2]?.name).toBe('冲突期间第三步仍可编辑');
      await page.getByRole('button', { name: '同步状态详情', exact: true }).click();
      await page.screenshot({ path: info.outputPath('song-conflict-review.png') });
      await conflict.getByRole('button', { name: '采用控台', exact: true }).click();
      await expect.poll(async () => JSON.parse(await app.evaluate(() => process.env.TBLINK_SONG_CONFLICT_DECISION ?? '{}')) as unknown).toEqual({ key: 'point-0:cue-name', token: 'c'.repeat(64), choice: 'console' });
      await expect.poll(() => savedValue(page, async () => (await saved()).tracks.flatMap(track => track.clips.flatMap(clip => clip.events)).find(event => event.id === 'point-0'))).toMatchObject({ label: '控台同时改开场' });
      await expect(conflict).toHaveCount(0);
      await saveProject(page);
      const events = (await saved()).tracks.flatMap(track => track.clips.flatMap(clip => clip.events));
      expect(events).toHaveLength(40);
      expect(events.find(event => event.id === 'point-2')).toMatchObject({ label: '冲突期间第三步仍可编辑' });
      expect(events.filter(event => event.id !== 'point-0' && event.id !== 'point-2')).toEqual(existing.filter(event => event.id !== 'point-0' && event.id !== 'point-2'));
      await saveProject(page);
      expect((await saved()).consoleSong).toMatchObject({ sequence: 9000, executor: '1234.101', points: expect.arrayContaining(existing.map(event => ({ id: event.id, cue: `${Number(event.id.split('-')[1]) + 1}.000` }))) });
      await details.getByRole('button', { name: '关闭', exact: true }).click();
      await page.getByRole('switch', { name: '实时同步', exact: true }).click();
      await expect(page.getByRole('switch', { name: '实时同步', exact: true })).toHaveAttribute('aria-checked', 'false');
      await saveProject(page);
      const native = (await savedProject()).ma2MaterialLibrary!.library!.sequences.find(sequence => sequence.sequence === 9000)!.cues;
      await app.evaluate((_context, cues) => { process.env.TBLINK_SONG_CLEAR_NATIVE = JSON.stringify(cues); }, native);
      for (let index = 0; index < 40; index++) {
        await page.locator('.waveform-cue-point').first().click();
        await page.locator('.waveform-cue-point').first().press('Delete');
      }
      await expect.poll(() => savedValue(page, async () => (await saved()).tracks.flatMap(track => track.clips.flatMap(clip => clip.events)).length)).toBe(0);
      await page.getByRole('switch', { name: '实时同步', exact: true }).click();
      await expect(page.getByRole('button', { name: '同步状态详情', exact: true })).toContainText('有修改待核对');
      await pool.getByRole('button', { name: '新建 Cue', exact: true }).click();
      await expect(song.getByLabel('两边修改核对')).toHaveCount(0);
      await song.getByRole('button', { name: '核对控台删除清单 · 40 项', exact: true }).click();
      const checklist = song.locator('.ma2-song-delete-review');
      await expect(checklist.locator('li')).toHaveCount(40);
      await expect(checklist).toContainText('Sequence 9000 · Cue 1');
      await expect(checklist).toContainText('Sequence 9000 · Cue 40');
      expect(await app.evaluate(() => process.env.TBLINK_SONG_CLEAR_CONFIRMED ?? '')).toBe('');
      await saveProject(page);
      expect((await saved()).consoleSong?.points).toHaveLength(40);
      await page.screenshot({ path: info.outputPath('song-clear-review.png') });
      await checklist.getByRole('button', { name: '确认清单并同步删除', exact: true }).click();
      await expect.poll(() => savedValue(page, async () => (await saved()).consoleSong?.points.length)).toBe(0);
      expect(JSON.parse(await app.evaluate(() => process.env.TBLINK_SONG_CLEAR_CONFIRMED ?? '[]')) as string[]).toEqual(Array.from({ length: 40 }, (_, index) => `${index + 1}.000`));
      await saveProject(page);
      expect((await saved()).consoleSong).toMatchObject({ sequence: 9000, executor: '1234.101', points: [] });
      expect((await savedProject()).ma2MaterialLibrary?.library?.sequences.find(sequence => sequence.sequence === 9000)?.cues).toEqual([]);
    }
    await page.getByRole('switch', { name: '实时同步', exact: true }).click();
    await expect(page.getByRole('switch', { name: '实时同步', exact: true })).toHaveAttribute('aria-checked', 'false');
    expect(errors).toEqual([]);
  } finally { await page.evaluate(() => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null })); await app.close(); }
});
