import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { test, expect, _electron as electron } from '@playwright/test';
import { createEmptyLinkProject, parseLinkProject, ma2AuditionRequestSchema, type Ma2CatalogRequest } from '@tb/schema';
import { readMa2Catalog } from '../src/main/link/ma2-catalog';
import { meiNanXml, meiNanSequences } from '../src/main/link/fixtures/ma2-mei-nan-reconstruction';
import { showStopped } from '../src/main/link/fixtures/show-gates';

test('截图重建：混合事件读取中切页、缓存配对、Cue可见、重启恢复且不再读取控台', async ({}, info) => {
  test.setTimeout(120000);
  const directory = { show: '截图重建测试 Show', generation: 'reconstruction', version: '3.7.0.5', entries: [{ target: 2, name: 'mei-nan' }, { target: 3, name: '故障时间线' }] };
  const catalog = await readMa2Catalog({ request: (operation, target) => operation === 'LIST' ? Promise.resolve(JSON.stringify(directory)) : target === 3 ? Promise.reject(new Error('读取超时样例')) : Promise.resolve(meiNanXml) }, showStopped, meiNanSequences[0]);
  const project = createEmptyLinkProject('MA2 缓存流程软件验收'); project.obsOutputMode = 'scenes';
  const rate = 8000; const wav = Buffer.alloc(44 + rate * 2 * 40);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 0; i < rate * 40; i++) wav.writeInt16LE(Math.round(Math.sin(i * Math.PI / 10) * (2000 + 10000 * Math.sin(i / rate * Math.PI) ** 2)), 44 + i * 2);
  await mkdir(info.outputPath('assets/reference-audio'), { recursive: true });
  await writeFile(info.outputPath('assets/reference-audio/song.wav'), wav);
  project.rundown = [{ id: 'song', title: '中文歌曲', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [], referenceAudio: { assetId: 'audio', relativePath: 'assets/reference-audio/song.wav', sha256: createHash('sha256').update(wav).digest('hex'), durationMs: 40000 }, playback: { volume: 100, endAction: 'stop', startMs: 1500, endMs: 39000, mtcOffsetMs: 480000, shortcut: '' } }];
  const file = info.outputPath('cached.tblink'); await writeFile(file, JSON.stringify(project));
  const executable = process.env.TBLINK_MA2_PACKAGED_EXE;
  const launch = () => electron.launch({ ...(executable ? { executablePath: executable } : {}), args: [`--user-data-dir=${info.outputPath('profile')}`, ...executable ? [] : [join(process.cwd(), 'out/main/index.cjs')]] });
  let app = await launch();
  let page = await app.firstWindow();
  try {
    await app.evaluate(({ ipcMain, dialog }, data) => {
      process.env.TBLINK_CACHE_TEST_READS = '0';
      process.env.TBLINK_CACHE_SOURCE_READS = '0';
      process.env.TBLINK_AUDITION_CALLS = '[]';
      ipcMain.removeHandler('link:ma2-audition-play'); ipcMain.handle('link:ma2-audition-play', (_event, payload: unknown) => {
        const calls = JSON.parse(process.env.TBLINK_AUDITION_CALLS ?? '[]') as unknown[]; calls.push(payload); process.env.TBLINK_AUDITION_CALLS = JSON.stringify(calls);
      });
      const status = { settings: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test', autoConnect: false }, state: 'connected', version: '3.7.0.5', passwordSaved: false, error: null };
      ipcMain.removeHandler('link:ma2-network-status'); ipcMain.handle('link:ma2-network-status', () => status);
      ipcMain.removeHandler('link:ma2-network-save'); ipcMain.handle('link:ma2-network-save', () => {
        throw new Error('连接设置未修改，重新读取不应保存设置或中断现有连接');
      });
      ipcMain.removeHandler('link:ma2-catalog'); ipcMain.handle('link:ma2-catalog', async (_event, request: Ma2CatalogRequest) => {
        if (request.targets?.length === 0) {
          process.env.TBLINK_CACHE_SOURCE_READS = String(Number(process.env.TBLINK_CACHE_SOURCE_READS) + 1);
          return { directory: data.catalog.directory, readAt: new Date().toISOString(), entries: [] };
        }
        process.env.TBLINK_CACHE_TEST_READS = String(Number(process.env.TBLINK_CACHE_TEST_READS) + 1);
        await new Promise(resolve => setTimeout(resolve, 1500)); return data.catalog;
      });
      ipcMain.removeHandler('link:ma2-preview'); ipcMain.handle('link:ma2-preview', () => { throw new Error('缓存配对不应再次读取'); });
      // A successful full pool read is authoritative. Return the actual fixture
      // pool instead of relying on old song references to refill an empty pool.
      ipcMain.removeHandler('link:ma2-effect-library'); ipcMain.handle('link:ma2-effect-library', (_event, request: Ma2CatalogRequest) => ({
        directory: { ...data.catalog.directory, entries: data.sequences.map(sequence => ({ target: sequence.sequence, name: sequence.name })) },
        readAt: new Date().toISOString(), sequences: request.targets?.length === 0 ? [] : data.sequences, fixtureUsage: [], errors: []
      }));
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [data.file] });
    }, { catalog, file, sequences: meiNanSequences[0]!.sequences.map(sequence => ({ sequence: sequence.number, name: sequence.name, cues: sequence.cues })) });
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await expect(page.getByText('中文歌曲', { exact: true }).first()).toBeVisible();
    const nav = page.getByRole('navigation', { name: '主要工作区' });
    await nav.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
    await page.getByRole('navigation', { name: '设置子子菜单' }).getByRole('button', { name: 'MA2 控台', exact: true }).click();
    await page.getByLabel('MA2 连接方式').selectOption('network');
    await page.getByRole('button', { name: /^(连接控台|读取 Cue)$/ }).click();
    await nav.getByRole('button', { name: '灯光工作台', exact: true }).click();
    await expect.poll(() => app.evaluate(() => process.env.TBLINK_CACHE_TEST_READS)).toBe('1');
    await expect(page.locator('.waveform-cue-point')).toHaveCount(11);
    await page.keyboard.press('Control+S'); await expect(page.locator('.titlebar-save-state')).toBeHidden();
    await nav.getByRole('button', { name: '设置', exact: true }).click();
    const exportButton = page.getByRole('button', { name: '导出控台数据包', exact: true });
    if (!await exportButton.isVisible()) await page.getByText('歌曲导入与同步', { exact: true }).click();
    await expect(exportButton).toBeVisible();
    const diagnosticPath = info.outputPath('现场核对.tbdiag.gz');
    await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: path }); }, diagnosticPath);
    await exportButton.click();
    await expect(page.getByText(`控台数据包已导出：${diagnosticPath}`, { exact: true })).toBeVisible();
    const exported = z.object({ context: z.object({ ma2Site: z.object({ raw: z.array(z.object({ target: z.number(), xml: z.string() })), pairings: z.record(z.string(), z.unknown()) }) }) }).parse(JSON.parse(gunzipSync(await readFile(diagnosticPath)).toString('utf8')));
    expect(exported.context.ma2Site.raw.find(entry => entry.target === 2)?.xml).toBe(meiNanXml);
    expect(await app.evaluate(() => process.env.TBLINK_CACHE_TEST_READS)).toBe('1');
    await expect.poll(() => app.evaluate(() => Number(process.env.TBLINK_CACHE_SOURCE_READS))).toBeGreaterThan(0);
    await nav.getByRole('button', { name: '灯光工作台', exact: true }).click();
    const saved = parseLinkProject(JSON.parse(await readFile(file, 'utf8')));
    expect(saved.ma2ReadState?.catalog.entries.length).toBe(2);
    expect(saved.rundown[0]?.lighting?.ma2Bindings?.[0]?.nativeEvents?.length).toBe(13);
    const sequencePreview = page.getByRole('region', { name: 'MA2 序列预览' });
    await expect(sequencePreview.getByLabel('素材序列', { exact: true })).toHaveAttribute('data-total-cues', '11');
    await sequencePreview.getByRole('button', { name: '试听序列 36 灯光步 1.100', exact: true }).click();
    await expect.poll(async () => (JSON.parse(await app.evaluate(() => process.env.TBLINK_AUDITION_CALLS ?? '[]')) as unknown[]).length).toBe(1);
    const calls = JSON.parse(await app.evaluate(() => process.env.TBLINK_AUDITION_CALLS ?? '[]')) as unknown[];
    expect(calls).toHaveLength(1);
    expect(ma2AuditionRequestSchema.parse(calls[0]).action).toEqual({ target: 'executor', executor: '51.101', cue: '1.100', action: 'goto' });
    await expect(page.locator('.waveform-cue-point')).toHaveCount(11);
    await sequencePreview.getByRole('button', { name: '多步', exact: true }).click();
    await sequencePreview.getByRole('button', { name: /^36 ·/ }).click();
    await expect(sequencePreview.getByLabel('序列中的单步灯光')).toHaveAttribute('data-total-cues', '11');
    await expect(sequencePreview.getByLabel('序列预览播放目标')).toHaveValue('51.101');
    await sequencePreview.getByRole('button', { name: '试听灯光步 1.100', exact: true }).click();
    await expect.poll(async () => (JSON.parse(await app.evaluate(() => process.env.TBLINK_AUDITION_CALLS ?? '[]')) as unknown[]).length).toBe(2);
    await expect(sequencePreview.getByText('未回读播放状态', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('sequence-preview.png') });
    for (const zoom of [1, 2]) {
      await app.evaluate(({ BrowserWindow }, factor) => { const window = BrowserWindow.getAllWindows()[0]!; window.setSize(1180, 760); window.webContents.setZoomFactor(factor); }, zoom);
      await sequencePreview.getByRole('button', { name: '停止试听', exact: true }).scrollIntoViewIfNeeded();
      await expect(sequencePreview.getByRole('button', { name: '停止试听', exact: true })).toBeInViewport();
      expect(await sequencePreview.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`sequence-preview-${zoom}.png`) });
    }
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]!; window.webContents.setZoomFactor(1); window.setSize(1540, 960); });
    await page.getByRole('button', { name: '音频 Cue 1', exact: true }).dblclick();
    const editor = page.getByRole('dialog', { name: '修改 Cue 卡点' });
    await editor.getByLabel('时间（秒）').fill('0.200');
    await editor.getByRole('button', { name: '保存卡点' }).click();
    await page.keyboard.press('Control+S'); await expect(page.locator('.titlebar-save-state')).toBeHidden();
    expect(parseLinkProject(JSON.parse(await readFile(file, 'utf8'))).rundown[0]?.lighting?.tracks[1]?.clips[0]?.events[0]?.at).toBe(200);
    expect(parseLinkProject(JSON.parse(await readFile(file, 'utf8'))).rundown[0]?.lighting?.ma2Bindings?.[0]?.sourceXml).toBe(meiNanXml);
    await page.screenshot({ path: info.outputPath('workbench.png') });
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('navigation', { name: '设置子子菜单' }).getByRole('button', { name: 'MA2 控台', exact: true }).click();
    if (!await page.getByRole('button', { name: '配对与查看 Cue', exact: true }).isVisible()) await page.getByText('歌曲导入与同步', { exact: true }).click();
    await page.getByRole('button', { name: '配对与查看 Cue', exact: true }).click();
    await expect(page.getByRole('region', { name: '控台时间线与歌曲配对' })).toBeVisible();
    await page.getByLabel('时间线状态筛选').selectOption('native');
    await expect(page.locator('.ma2-browser-events tbody tr')).toHaveCount(24);
    await expect(page.locator('.ma2-browser-body article')).toContainText('节目起点 MTC 00:08:00:00');
    await page.screenshot({ path: info.outputPath('cached-details.png') });
    await nav.getByRole('button', { name: '节目单', exact: true }).click();
    await nav.getByRole('button', { name: '灯光工作台', exact: true }).click();
    await expect(page.getByLabel('时间线状态筛选')).toHaveValue('native');
    expect(await app.evaluate(() => process.env.TBLINK_CACHE_TEST_READS)).toBe('1');
    await page.keyboard.press('Control+S'); await expect(page.locator('.titlebar-save-state')).toBeHidden();
    expect(parseLinkProject(JSON.parse(await readFile(file, 'utf8'))).ma2ReadState?.filter).toBe('native');
    await page.evaluate(() => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null })); await app.close();
    app = await launch(); page = await app.firstWindow();
    await expect(page.getByText('MA2 缓存流程软件验收', { exact: true }).first()).toBeVisible();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
    await expect(page.locator('.waveform-cue-point')).toHaveCount(11);
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('navigation', { name: '设置子子菜单' }).getByRole('button', { name: 'MA2 控台', exact: true }).click();
    if (!await page.getByRole('button', { name: '配对与查看 Cue', exact: true }).isVisible()) await page.getByText('歌曲导入与同步', { exact: true }).click();
    await page.getByRole('button', { name: '配对与查看 Cue', exact: true }).click();
    await expect(page.getByLabel('时间线状态筛选')).toHaveValue('native');
    await expect(page.locator('.ma2-browser-events tbody tr')).toHaveCount(24);
    await page.getByLabel('时间线状态筛选').selectOption('error');
    await expect(page.locator('.ma2-browser-body article')).toContainText('读取超时样例');
  } catch (error) {
    if (!page.isClosed()) {
      await writeFile(info.outputPath('failure-reads.json'), JSON.stringify(await app.evaluate(() => ({ fullReads: process.env.TBLINK_CACHE_TEST_READS, sourceReads: process.env.TBLINK_CACHE_SOURCE_READS })), null, 2));
      await writeFile(info.outputPath('failure-ui.txt'), await page.locator('body').innerText());
      await writeFile(info.outputPath('failure-logs.json'), JSON.stringify(await page.evaluate(() => window.tbLink.queryLogs({ limit: 100 })), null, 2));
    }
    throw error;
  } finally { if (!page.isClosed()) await page.evaluate(() => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null })); if (app.process().exitCode === null) await app.close(); }
});


