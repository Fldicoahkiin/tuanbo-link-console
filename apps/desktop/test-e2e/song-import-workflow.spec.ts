import { test, expect, _electron as electron } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseLinkProject } from '@tb/schema';
import { answerSaveQuestions, saveProject, closeDiscarding } from './save-questions';

async function audioFixture(path: string): Promise<void> {
  const samples = 48000 * 3;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  await writeFile(path, wav);
}

test('从首页直接导入 P1 歌曲并保存原始时间码，内部主控仍能再次打开导入入口', async ({}, info) => {
  const audio = info.outputPath('测试原音.wav'); await audioFixture(audio);
  const source = info.outputPath('现场.hia'); const target = info.outputPath('联动.tblink');
  await writeFile(source, `<playerRoot><videoPlayList><videoPlayElement caption="现场列表"><media mediaType="4" resourceFilePath="${audio.replaceAll('\\', '/')}" playEndAction="2" cut_start="1" cut_end="2.5" volume="100" mute="0" shortcut="" MidiStartTime="120" audio_caption_="歌曲原名"/></videoPlayElement></videoPlayList></playerRoot>`);
  const application = await electron.launch({ env: { ...process.env, TBLINK_LOCAL_TEST_ACCESS: '1' }, args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')] });
  try {
    const page = await application.firstWindow();
    await page.getByRole('button', { name: '导入歌曲 / P1', exact: true }).click();
    await application.evaluate(({ BrowserWindow, dialog }, paths) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1440, 900);
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [paths.source] });
      dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: paths.target });
    }, { source, target });
    await answerSaveQuestions(application);
    const songs = page.getByRole('region', { name: '歌曲导入', exact: true });
    await expect(songs.getByRole('button', { name: '导入 P1 歌曲（.hia）', exact: true })).toBeVisible();
    await expect(page.locator('.settings-location-highlight')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('song-workflow-dark.png'), animations: 'disabled' });
    await songs.getByRole('button', { name: '导入 P1 歌曲（.hia）', exact: true }).click();
    await expect(songs.locator('.p1-sync-summary')).toContainText('1 首音频');
    await saveProject(page);
    const saved = parseLinkProject(JSON.parse(await readFile(target, 'utf8')));
    expect(saved.playbackSource).toBe('internal');
    expect(saved.rundown[0]?.title).toBe('歌曲原名');
    expect(saved.rundown[0]?.p1Media?.midiStartTime).toBe('120');
    expect(saved.rundown[0]?.referenceAudio?.durationMs).toBe(1500);
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '节目单', exact: true }).click();
    await expect(page.locator('.p1-media-card').getByText('歌曲原名', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '导入歌曲 / P1', exact: true }).click();
    await expect(songs.getByRole('button', { name: '导入 P1 歌曲（.hia）', exact: true })).toBeVisible();
    await expect(songs.locator('.p1-sync-path:visible')).toContainText('已保存 P1 歌曲');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await expect(page.locator('.settings-location-highlight')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('song-workflow-light.png'), animations: 'disabled' });
  } finally { await closeDiscarding(application); }
});

test('小红花入口可导入自有音频并明确不支持备份包和播放跟随', async ({}, info) => {
  const audio = info.outputPath('自有音效.wav'); await audioFixture(audio);
  const target = info.outputPath('音效节目.tblink');
  const application = await electron.launch({ env: { ...process.env, TBLINK_LOCAL_TEST_ACCESS: '1' }, args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')] });
  try {
    const page = await application.firstWindow();
    await page.getByRole('button', { name: '导入歌曲 / P1', exact: true }).click();
    const songs = page.getByRole('region', { name: '歌曲导入', exact: true });
    await songs.getByRole('button', { name: /小红花音效助手/ }).click();
    await expect(songs.getByText(/尚未接入：小红花备份包/)).toBeVisible();
    await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath }); }, target);
    await answerSaveQuestions(application);
    await songs.getByLabel('导入本地音频文件', { exact: true }).setInputFiles(audio);
    await expect(songs.getByRole('status')).toContainText('已添加 1 个节目');
    await saveProject(page);
    await expect.poll(async () => parseLinkProject(JSON.parse(await readFile(target, 'utf8'))).rundown.length).toBe(1);
    const saved = parseLinkProject(JSON.parse(await readFile(target, 'utf8')));
    expect(saved.playbackSource).toBe('internal'); expect(saved.rundown[0]?.title).toBe('自有音效.wav');
    expect(saved.rundown[0]?.p1Media).toBeUndefined();
    await page.screenshot({ path: info.outputPath('xiaohonghua-scope.png') });
  } finally { await closeDiscarding(application); }
});
