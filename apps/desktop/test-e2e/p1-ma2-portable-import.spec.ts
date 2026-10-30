import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';
import { createLightingDocument, parseLinkProject, type Ma2Catalog, type Ma2TimecodePreview } from '@tb/schema';
import { answerSaveQuestions, closeDiscarding, savedValue } from './save-questions';

function wave(): Buffer {
  const samples = 8000 * 5;
  const result = Buffer.alloc(44 + samples, 128);
  result.write('RIFF', 0); result.writeUInt32LE(result.length - 8, 4);
  result.write('WAVEfmt ', 8); result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22); result.writeUInt32LE(8000, 24); result.writeUInt32LE(8000, 28);
  result.writeUInt16LE(1, 32); result.writeUInt16LE(8, 34);
  result.write('data', 36); result.writeUInt32LE(samples, 40);
  return result;
}

function preview(target: number, originMs: number, cue: string, label: string): Ma2TimecodePreview {
  const document = createLightingDocument();
  const trackId = `track-${target}`, clipId = `clip-${target}`, eventId = `event-${target}`;
  document.tracks.push({ id: trackId, kind: 'ma2', name: `控台轨道 ${target}`, color: '#ba8fff', group: '', muted: false, solo: false,
    locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: clipId, name: 'MA2',
      start: 0, duration: originMs + 5000, timeLock: 'time', muted: false,
      events: [{ id: eventId, kind: 'ma2', at: originMs + 1000, sequence: target, cue, executor: '1.101', label, action: 'goto' }] }] });
  return { target, name: label, readAt: '2026-09-23T00:00:00.000Z', document, sourceXml: '<MA/>',
    mappings: [{ eventId, trackId, clipId, path: `Timecode:${target}/Track:0/SubTrack:0/Event:1`, sequence: target, cueIndex: 1, executor: '1.101' }],
    warnings: [], unconverted: [] };
}

test('离线复制两首 P1 歌曲后自动配对控台 Cue，并在编辑器按歌显示', async ({}, info) => {
  test.setTimeout(120000);
  const first = info.outputPath('甲.wav'), second = info.outputPath('乙.wav');
  await writeFile(first, wave()); await writeFile(second, wave());
  const p1Path = info.outputPath('演出.hia'), linkPath = info.outputPath('演出.tblink');
  await writeFile(p1Path, `<?xml version="1.0" encoding="UTF-8"?><playerRoot><audioPlayList CurrentList="0"><audioPlayElement caption="主歌单" type="0"/></audioPlayList><videoPlayList CurrentList="0"><videoPlayElement caption="主歌单" type="0"><media mediaType="4" resourceFilePath="Z:/旧电脑/甲.wav" playEndAction="2" cut_start="0" cut_end="5" volume="100" mute="0" shortcut="" MidiStartTime="60" audio_caption_="甲.wav"/><media mediaType="4" resourceFilePath="Z:/旧电脑/乙.wav" playEndAction="2" cut_start="0" cut_end="5" volume="100" mute="0" shortcut="" MidiStartTime="120" audio_caption_="乙.wav"/></videoPlayElement></videoPlayList></playerRoot>`);
  const catalog: Ma2Catalog = { directory: { show: '验收Show', version: '3.3.4.3', generation: '1', entries: [{ target: 101, name: '甲' }, { target: 102, name: '乙' }] },
    readAt: '2026-09-23T00:00:00.000Z', entries: [
      { target: 101, name: '甲', preview: preview(101, 60000, '1.250', '甲的 Cue'), sourceXml: '<MA/>', eventCount: 1, frameFormat: '30 FPS', offset: '1800', slot: 'TC Slot 1', error: null, warnings: [], events: [{ path: 'tc101/1', time: '30', action: 'Goto', executor: '1.101', cue: '1.250', name: '甲的 Cue' }] },
      { target: 102, name: '乙', preview: preview(102, 120000, '2.500', '乙的 Cue'), sourceXml: '<MA/>', eventCount: 1, frameFormat: '30 FPS', offset: '3600', slot: 'TC Slot 1', error: null, warnings: [], events: [{ path: 'tc102/1', time: '30', action: 'Goto', executor: '1.101', cue: '2.500', name: '乙的 Cue' }] }
    ] };
  const executable = process.env.TBLINK_MA2_PACKAGED_EXE;
  const application = await electron.launch({ ...(executable ? { executablePath: executable } : {}), args: [`--user-data-dir=${info.outputPath('profile')}`, ...executable ? [] : [join(process.cwd(), 'out/main/index.cjs')]] });
  const page = await application.firstWindow();
  await answerSaveQuestions(application);
  if (process.env.TBLINK_MA2_TEST_HIDDEN) await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.hide(); });
  try {
    await application.evaluate(({ ipcMain, dialog }, input) => {
      ipcMain.removeHandler('link:ma2-network-status');
      ipcMain.handle('link:ma2-network-status', () => ({ settings: { host: '127.0.0.1', port: 30000, monitorPort: 30001, username: 'administrator', autoConnect: false }, passwordSaved: true, state: 'connected', version: '3.3.4.3', error: null }));
      ipcMain.removeHandler('link:ma2-capabilities');
      ipcMain.handle('link:ma2-capabilities', () => ({ settings: { host: '127.0.0.1', port: 30000, monitorPort: 30001, username: 'administrator', autoConnect: false }, passwordSaved: true, state: 'connected', version: '3.3.4.3', error: null }));
      ipcMain.removeHandler('link:ma2-exchange');
      ipcMain.handle('link:ma2-exchange', (_event, request: { operation: string }) => {
        if (request.operation !== 'PING') throw new Error('隔离导入测试禁止写控台');
        return 'PONG';
      });
      ipcMain.removeHandler('link:ma2-catalog');
      ipcMain.handle('link:ma2-catalog', () => input.catalog);
      ipcMain.removeHandler('link:ma2-preview');
      ipcMain.handle('link:ma2-preview', () => { throw new Error('应使用已读预览，不重复请求控台'); });
      ipcMain.removeHandler('link:ma2-effect-library');
      ipcMain.handle('link:ma2-effect-library', () => ({ directory: { ...input.catalog.directory, entries: [] }, readAt: input.catalog.readAt, sequences: [], fixtureUsage: [], errors: [] }));
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [input.p1Path] });
      dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: input.linkPath });
    }, { catalog, p1Path, linkPath });
    await page.evaluate(() => localStorage.setItem('tblink.ma2-connection-method.v1', 'network'));
    await page.reload();
    const navigation = page.getByRole('navigation', { name: '主要工作区' });
    await navigation.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
    await page.getByRole('navigation', { name: '设置子子菜单' }).getByRole('button', { name: 'MA2 控台', exact: true }).click();
    await page.getByText('歌曲导入与同步', { exact: true }).click();
    const section = page.getByRole('region', { name: 'MA2 现场节目导入' });
    await section.getByText('从 P1 工程导入歌曲', { exact: true }).click();
    await section.getByLabel('仅导入 P1 音乐').click();
    await section.getByRole('button', { name: '选择 .hia 文件', exact: true }).click();
    await expect(section.getByRole('button', { name: '读取控台灯光到现有歌曲' })).toBeEnabled({ timeout: 90000 });
    await expect(section.getByText('P1 歌曲和原始时间码已保存在工程，无需重新选择 .hia。', { exact: true })).toBeVisible();
    await expect.poll(() => savedValue(page, async () => parseLinkProject(JSON.parse(await readFile(linkPath, 'utf8'))).rundown.length)).toBe(2);
    const musicOnly = parseLinkProject(JSON.parse(await readFile(linkPath, 'utf8')));
    expect(musicOnly.rundown).toHaveLength(2);
    expect(musicOnly.rundown.every(item => !item.lighting?.ma2Bindings?.length)).toBe(true);
    await section.getByRole('button', { name: '读取控台灯光到现有歌曲' }).click();
    await expect(section.getByText('已关联 2 / 2 首歌曲', { exact: false })).toBeVisible({ timeout: 90000 });
    await expect.poll(() => savedValue(page, async () => parseLinkProject(JSON.parse(await readFile(linkPath, 'utf8'))).rundown.map(item => item.lighting?.ma2Bindings?.[0]?.timecode))).toEqual([101, 102]);
    const saved = parseLinkProject(JSON.parse(await readFile(linkPath, 'utf8')));
    expect(saved.rundown.map(item => item.id)).toEqual(musicOnly.rundown.map(item => item.id));
    expect(saved.rundown.map(item => item.referenceAudio?.relativePath)).toEqual(musicOnly.rundown.map(item => item.referenceAudio?.relativePath));
    expect(saved.rundown.map(item => item.playback?.mtcOffsetMs)).toEqual([60000, 120000]);
    expect(saved.rundown.map(item => item.lighting?.tracks[0]?.clips[0]?.events[0]?.at)).toEqual([1000, 1000]);
    await navigation.getByRole('button', { name: '编辑器', exact: true }).click();
    await expect(page.getByRole('button', { name: '修改节目名称：甲.wav' })).toBeVisible();
    await expect(page.locator('.lighting-timeline-point')).toHaveAttribute('title', /甲的 Cue · Cue 1\.250/);
    await navigation.getByRole('button', { name: '节目单', exact: true }).click();
    await page.locator('.home-card').filter({ hasText: '乙.wav' }).click({ button: 'right' });
    await page.keyboard.press('Escape');
    await navigation.getByRole('button', { name: '灯光工作台', exact: true }).click();
    await expect(page.getByRole('button', { name: '音频 Cue 1', exact: true })).toBeVisible();
    await expect(page.locator('.waveform-cue-point')).toHaveCount(1);
    const importedCue = saved.rundown[1]?.lighting?.tracks[0]?.clips[0]?.events[0];
    expect(importedCue).toMatchObject({ kind: 'ma2', cue: '2.500' });
    await navigation.getByRole('button', { name: '编辑器', exact: true }).click();
    await expect(page.getByRole('button', { name: '修改节目名称：乙.wav' })).toBeVisible();
    await expect(page.locator('.lighting-timeline-point')).toHaveAttribute('title', /乙的 Cue · Cue 2\.500/);
    await navigation.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
    await page.getByRole('navigation', { name: '设置子子菜单' }).getByRole('button', { name: 'MA2 控台', exact: true }).click();
    if (!await section.getByRole('button', { name: '更新控台读取' }).isVisible()) await page.getByText('歌曲导入与同步', { exact: true }).click();
    await section.getByRole('button', { name: '更新控台读取' }).click();
    await expect(section.getByText('0 条已关联 · 0 条含控台原样动作 · 0 条需处理', { exact: true })).toBeVisible({ timeout: 90000 });
    await expect(section.getByText('已关联 2 / 2 首歌曲', { exact: false })).toBeVisible({ timeout: 90000 });
    await expect.poll(() => savedValue(page, async () => parseLinkProject(JSON.parse(await readFile(linkPath, 'utf8'))).rundown.map(item => item.lighting?.ma2Bindings?.length))).toEqual([1, 1]);
    const reopened = parseLinkProject(JSON.parse(await readFile(linkPath, 'utf8')));
    expect(reopened.rundown.map(item => item.lighting?.tracks.flatMap(track => track.clips.flatMap(clip => clip.events)).length)).toEqual([1, 1]);
  } catch (error) {
    await writeFile(info.outputPath('failure-ui.txt'), await page.locator('body').innerText());
    throw error;
  } finally {
    if (!page.isClosed()) {
      await page.evaluate(() => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null }));
    }
    if (application.process().exitCode === null) await closeDiscarding(application);
  }
});
