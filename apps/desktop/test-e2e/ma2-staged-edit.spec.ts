import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { importMa2TimecodeCommand } from '@tb/core/link';
import { convertMa2Timecode } from '../src/main/link/ma2-timecode-conversion';
import { readMa2Catalog } from '../src/main/link/ma2-catalog';
import { inspectMa2SequenceXml } from '../src/main/link/ma2-timecode-xml';
import { savedValue } from './save-questions';

test('播放中编辑已绑定 Cue、撤销重做、停止与重开保留待提交列表', async ({}, info) => {
  const xml = await readFile(join(process.cwd(), 'src/main/link/fixtures/ma2-timecode-fractional-3.3.xml'), 'utf8');
  const sequence = await readFile(join(process.cwd(), 'src/main/link/fixtures/ma2-sequence-fractional-3.3.xml'), 'utf8');
  const directory = { show: '安全暂存桌面验收', generation: 'test', version: '3.3.4', entries: [{ target: 9902, name: '暂存歌曲' }] };
  const catalog = await readMa2Catalog({ request: operation => Promise.resolve(operation === 'LIST' ? JSON.stringify(directory) : xml) }, () => false, inspectMa2SequenceXml(sequence));
  const library = { directory: { ...directory, entries: [] }, readAt: new Date().toISOString(), sequences: [], fixtureUsage: [], errors: [] };
  const wav = Buffer.alloc(44 + 8000 * 60, 128);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await mkdir(info.outputPath('assets/reference-audio'), { recursive: true }); await writeFile(info.outputPath('assets/reference-audio/song.wav'), wav);
  const project = parseLinkProject({ ...createEmptyLinkProject('安全暂存桌面验收'), schemaVersion: 2, playbackSource: 'p1', ma2MaterialLibrary: { version: 1, source: '192.0.2.1:30000', library }, rundown: [{ id: 'song', title: '暂存歌曲', cues: [], referenceAudio: { assetId: 'audio', relativePath: 'assets/reference-audio/song.wav', sha256: createHash('sha256').update(wav).digest('hex'), durationMs: 60000 } }] });
  const file = info.outputPath('staged.tblink');
  const imported = importMa2TimecodeCommand('song', convertMa2Timecode(xml, [sequence], 9902)).execute(project);
  // The workbench preview still follows the stored mode; there is no selector to switch it any more.
  imported.rundown[0]!.lighting!.outputMode = 'network';
  await writeFile(file, JSON.stringify(imported));
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')] });
  try {
    const page = await app.firstWindow(); const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ dialog, ipcMain }, data) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [data.file] });
      ipcMain.removeHandler('link:ma2-network-status');
      ipcMain.handle('link:ma2-network-status', () => ({ state: 'connected', settings: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test', autoConnect: false }, passwordSaved: false, version: '3.3.4', error: null }));
      ipcMain.removeHandler('link:ma2-catalog'); ipcMain.handle('link:ma2-catalog', () => data.catalog);
      ipcMain.removeHandler('link:ma2-preview'); ipcMain.handle('link:ma2-preview', () => data.catalog.entries[0]!.preview);
      ipcMain.removeHandler('link:ma2-effect-library'); ipcMain.handle('link:ma2-effect-library', () => data.library);
      process.env.TBLINK_STAGED_WRITE_CALLS = '0';
      for (const channel of ['link:ma2-apply', 'link:ma2-song-sync']) {
        ipcMain.removeHandler(channel); ipcMain.handle(channel, () => {
          process.env.TBLINK_STAGED_WRITE_CALLS = String(Number(process.env.TBLINK_STAGED_WRITE_CALLS) + 1);
          throw new Error('播放或主动暂停期间不得提交控台修改');
        });
      }
      ipcMain.removeHandler('link:ma2-play-cue'); ipcMain.handle('link:ma2-play-cue', () => undefined);
      ipcMain.removeHandler('link:ma2-play-cancel'); ipcMain.handle('link:ma2-play-cancel', () => undefined);
    }, { file, catalog, library });
    await page.evaluate(() => localStorage.setItem('tblink.ma2-connection-method.v1', 'network'));
    await page.reload();
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
    await expect(page.locator('[data-waveform-engine="wavesurfer"][data-ready="true"]').first()).toBeVisible();
    const realtime = page.getByRole('switch', { name: '实时同步', exact: true });
    await expect(realtime).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('button', { name: '播放时间线', exact: true }).click();
    await expect(page.getByRole('button', { name: '暂停时间线', exact: true })).toBeVisible();
    await page.locator('.waveform-cue-point').first().dblclick();
    await expect(page.getByRole('button', { name: '暂停时间线', exact: true })).toBeVisible();
    await page.getByLabel('时间（秒）', { exact: true }).fill('2');
    await page.getByRole('button', { name: '保存卡点', exact: true }).click();
    await expect(page.getByRole('button', { name: '暂停时间线', exact: true })).toBeVisible();
    const badge = page.getByRole('button', { name: '同步状态详情', exact: true });
    await expect(badge).toContainText('待同步 1');
    await badge.click();
    const pending = page.getByRole('dialog', { name: '同步状态详情' });
    await expect(pending).toContainText('1 处修改');
    await expect(pending).toContainText('播放时先暂存在本地');
    await expect(page.getByRole('button', { name: '暂停时间线', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(badge).not.toContainText('待同步');
    // A click elsewhere closes the details; opened again they no longer list the change.
    await expect(pending).toHaveCount(0);
    await badge.click();
    await expect(pending).not.toContainText('1 处修改');
    await expect(realtime).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('button', { name: '重做', exact: true }).click(); await expect(badge).toContainText('待同步 1');
    await expect.poll(() => savedValue(page, async () => parseLinkProject(JSON.parse(await readFile(file, 'utf8'))).rundown[0]?.lighting?.tracks[0]?.clips[0]?.events[0]?.at)).toBe(2000);
    expect(await app.evaluate(() => process.env.TBLINK_STAGED_WRITE_CALLS)).toBe('0');
    await realtime.click();
    await expect(realtime).toHaveAttribute('aria-checked', 'false');
    await page.getByRole('button', { name: '暂停时间线', exact: true }).click();
    await expect(badge).toContainText('已暂停同步');
    await expect(realtime).toHaveAttribute('aria-checked', 'false');
    // The clicks on the switch and the transport closed the details; opened again they still list the change.
    await badge.click();
    await expect(pending).toContainText('1 处修改');
    await page.screenshot({ path: info.outputPath('pending.png') });
    await page.getByRole('button', { name: '停止时间线', exact: true }).click();
    await page.reload();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
    await expect(badge).toContainText('已暂停同步');
    await expect(realtime).toHaveAttribute('aria-checked', 'false');
    await badge.click();
    await expect(pending).toContainText('1 处修改');
    expect(await app.evaluate(() => process.env.TBLINK_STAGED_WRITE_CALLS)).toBe('0');
    expect(errors).toEqual([]);
  } finally { const page = await app.firstWindow(); await page.evaluate(() => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null })); await app.close(); }
});
