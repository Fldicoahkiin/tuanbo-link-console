import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { test, expect, _electron as electron } from '@playwright/test';
import { createEmptyLinkProject, ma2ApplyRequestSchema, parseLinkProject } from '@tb/schema';
import { readMa2Catalog } from '../src/main/link/ma2-catalog';
import { convertMa2Timecode } from '../src/main/link/ma2-timecode-conversion';
import { inspectMa2SequenceXml } from '../src/main/link/ma2-timecode-xml';
import { savedValue } from './save-questions';

test('软件流程：连接后自动配对，编辑后自动发送并应用已确认回读', async ({}, info) => {
  const xml = await readFile(join(process.cwd(), 'src/main/link/fixtures/ma2-timecode-fractional-3.3.xml'), 'utf8');
  const sequence = await readFile(join(process.cwd(), 'src/main/link/fixtures/ma2-sequence-fractional-3.3.xml'), 'utf8');
  const directory = { show: '专用软件验收', generation: 'test', version: '3.3.4', entries: [{ target: 9902, name: '不同名称的控台时间线' }] };
  const catalog = await readMa2Catalog({ request: operation => Promise.resolve(operation === 'LIST' ? JSON.stringify(directory) : xml) }, () => false, inspectMa2SequenceXml(sequence));
  const confirmed = convertMa2Timecode(xml.replace('<Event index="0"', '<Event time="21" index="0"'), [sequence], 9902);
  const project = createEmptyLinkProject('连接并编辑软件验收'); project.playbackSource = 'internal';
  const wav = Buffer.alloc(44 + 8000 * 2 * 3);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await mkdir(info.outputPath('assets/reference-audio'), { recursive: true });
  await writeFile(info.outputPath('assets/reference-audio/song.wav'), wav);
  project.rundown = [{ id: 'song', title: '歌曲原名', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [], referenceAudio: { assetId: 'audio', relativePath: 'assets/reference-audio/song.wav', sha256: createHash('sha256').update(wav).digest('hex'), durationMs: 3000 }, playback: { volume: 100, endAction: 'stop', startMs: 0, endMs: 0, mtcOffsetMs: 0, shortcut: '' } }];
  const file = info.outputPath('song.tblink'); await writeFile(file, JSON.stringify(project));
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')] });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ ipcMain, dialog }, data) => {
      const status = { settings: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test', autoConnect: false }, state: 'connected', version: '3.3.4', passwordSaved: false, error: null };
      ipcMain.removeHandler('link:ma2-network-status'); ipcMain.handle('link:ma2-network-status', () => status);
      ipcMain.removeHandler('link:ma2-network-save'); ipcMain.handle('link:ma2-network-save', () => status);
      ipcMain.removeHandler('link:ma2-catalog'); ipcMain.handle('link:ma2-catalog', () => data.catalog);
      ipcMain.removeHandler('link:ma2-preview'); ipcMain.handle('link:ma2-preview', () => process.env.TBLINK_EDIT_REQUEST ? data.confirmed : data.catalog.entries[0]!.preview);
      ipcMain.removeHandler('link:ma2-effect-library'); ipcMain.handle('link:ma2-effect-library', () => ({ directory: { ...data.catalog.directory, entries: [] }, readAt: new Date().toISOString(), sequences: [], fixtureUsage: [], errors: [] }));
      // Only the transport receipt is simulated; renderer, comparison and document saving are real.
      ipcMain.removeHandler('link:ma2-apply'); ipcMain.handle('link:ma2-apply', (_event, request: unknown) => {
        process.env.TBLINK_EDIT_REQUEST = JSON.stringify(request);
        return { status: 'verified', confirmed: data.confirmed, backupFile: 'test-backup.xml' };
      });
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [data.file] });
    }, { catalog, confirmed, file });
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await expect(page.getByText('连接并编辑软件验收', { exact: true })).toBeVisible();
    const nav = page.getByRole('navigation', { name: '主要工作区' });
    await nav.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('navigation', { name: '设置子子菜单' }).getByRole('button', { name: 'MA2 控台', exact: true }).click();
    await page.getByLabel('MA2 连接方式').selectOption('network');
    await page.getByRole('button', { name: /^(连接控台|读取 Cue)$/ }).click();
    await expect(page.getByText(/灯光工作台左下角的“实时同步”开着时/)).toBeVisible();
    await nav.getByRole('button', { name: '灯光工作台', exact: true }).click();
    await expect(page.locator('.waveform-cue-point')).toHaveCount(2);
    expect(await app.evaluate(() => process.env.TBLINK_EDIT_REQUEST)).toBeUndefined();
    await expect(page.getByRole('switch', { name: '实时同步', exact: true })).toHaveAttribute('aria-checked', 'true');
    const first = await page.locator('.waveform-cue-point').first().boundingBox();
    const second = await page.locator('.waveform-cue-point').nth(1).boundingBox();
    if (!first || !second) throw new Error('Cue 标记不可见');
    await page.mouse.move(first.x + 20, first.y + first.height / 2);
    await page.mouse.down();
    await page.mouse.move(first.x + 20 + (second.x - first.x) * 700 / 1500, first.y + first.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.getByRole('button', { name: '同步状态详情', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '同步状态详情' })).toContainText('回读确认');
    await expect.poll(() => savedValue(page, async () => parseLinkProject(JSON.parse(await readFile(file, 'utf8'))).rundown[0]!.lighting!.ma2Bindings![0]!.baselineTracks[0]!.clips[0]!.events[0]!.at)).toBe(700);
    const sent = await app.evaluate(() => process.env.TBLINK_EDIT_REQUEST);
    expect(ma2ApplyRequestSchema.parse(JSON.parse(sent ?? 'null')).document.tracks[0]!.clips[0]!.events[0]!.at).toBeCloseTo(700, -1);
    await page.screenshot({ path: info.outputPath('编辑后已回读.png') });
  } finally { await (await app.firstWindow()).evaluate(() => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null })); await app.close(); }
});
