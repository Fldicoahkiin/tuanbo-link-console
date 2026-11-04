import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';

const pickPath = (app: ElectronApplication, path: string): Promise<void> =>
  app.evaluate(({ dialog }, value) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [value] }); }, path);

test('只挪动 .tblink 后打开：列出缺失素材，选择原工程文件夹一次找回', async ({}, info) => {
  if (!ffmpegPath) throw new Error('缺少 FFmpeg');
  const audio = info.outputPath('music.wav'), video = info.outputPath('video.mp4');
  await promisify(execFile)(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=2', audio], { windowsHide: true });
  await promisify(execFile)(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'color=s=64x64:r=30:d=2', '-i', audio, '-c:v', 'mpeg4', '-c:a', 'aac', video], { windowsHide: true });
  const original = info.outputPath('原工程'), moved = info.outputPath('挪到这里'), unrelated = info.outputPath('无关文件夹');
  for (const folder of [original, moved, unrelated]) await mkdir(folder, { recursive: true });
  const path = join(original, '挪动验收.tblink'), movedPath = join(moved, '挪动验收.tblink');
  await writeFile(path, JSON.stringify(parseLinkProject({ ...createEmptyLinkProject('挪动验收'), playbackSource: 'internal', rundown: [{ id: 'p0', title: '占位节目', cues: [] }] })));
  const launch = (): Promise<ElectronApplication> => electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')] });

  let app = await launch();
  try {
    const page = await app.firstWindow();
    await pickPath(app, path);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await expect(page.locator('.home-grid')).toBeVisible();
    await page.evaluate(() => { const input = document.createElement('input'); input.id = 'test-drop-files'; input.type = 'file'; input.multiple = true; input.hidden = true; document.body.append(input); });
    await page.locator('#test-drop-files').setInputFiles([audio, video]);
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('#test-drop-files')!;
      const transfer = new DataTransfer(); for (const file of input.files!) transfer.items.add(file);
      document.querySelector('.home-grid')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await expect(page.locator('.home-card')).toHaveCount(3);
    await page.keyboard.press('Control+S'); await expect(page.locator('.titlebar-save-state')).toBeHidden();
    await expect.poll(async () => parseLinkProject(JSON.parse(await readFile(path, 'utf8'))).mediaAssets.length).toBe(1);
    await expect.poll(async () => parseLinkProject(JSON.parse(await readFile(path, 'utf8'))).rundown.filter(item => item.referenceAudio).length).toBe(2);
    await expect(page.getByRole('dialog', { name: '找回缺失素材' })).toHaveCount(0);
    await page.evaluate(() => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null }));
  } finally { await app.close(); }

  const saved = parseLinkProject(JSON.parse(await readFile(path, 'utf8')));
  const files = [...saved.rundown.flatMap(item => item.referenceAudio ? [item.referenceAudio.relativePath] : []), ...saved.mediaAssets.map(asset => asset.relativePath)];
  expect(files).toHaveLength(3);
  const songSha = saved.rundown.find(item => item.title === 'music.wav')!.referenceAudio!.sha256;
  const waveform = (root: string): string => join(root, 'cache', 'waveforms', `${songSha}.json`);
  await mkdir(join(original, 'cache', 'waveforms'), { recursive: true });
  await writeFile(waveform(original), '[0,0.5,-0.5]\n');
  await copyFile(path, movedPath);
  app = await launch();
  try {
    const page = await app.firstWindow();
    await expect(page.getByLabel('当前工程', { exact: true })).toHaveText('挪动验收');
    await pickPath(app, movedPath);
    await page.getByLabel('工程菜单', { exact: true }).click();
    await page.getByRole('menuitem', { name: '打开工程', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '找回缺失素材' });
    await expect(dialog.getByRole('heading', { name: '找不到 3 个素材' })).toBeVisible();
    await expect(dialog.getByRole('list', { name: '缺失的素材' }).getByRole('listitem')).toHaveText([/歌曲音频 · music\.wav/, /歌曲音频 · video\.mp4/, /视频素材 · video\.mp4/]);
    await page.screenshot({ path: info.outputPath('missing-assets.png') });

    await pickPath(app, unrelated);
    await dialog.getByRole('button', { name: '选择原工程文件夹' }).click();
    await expect(dialog.getByRole('status')).toContainText('所选文件夹里没有可用的文件');
    await expect(dialog.getByRole('listitem').filter({ hasText: '未找到' })).toHaveCount(3);

    await pickPath(app, original);
    await dialog.getByRole('button', { name: '选择原工程文件夹' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('已找回 3 个素材', { exact: true })).toBeVisible();
    for (const relativePath of files) expect(await readFile(join(moved, relativePath))).toEqual(await readFile(join(original, relativePath)));
    expect(await readFile(waveform(moved), 'utf8')).toBe('[0,0.5,-0.5]\n');
    expect(parseLinkProject(JSON.parse(await readFile(movedPath, 'utf8')))).toEqual(saved);

    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
    await expect(page.locator('.media-table-row.asset-row .media-status')).toHaveText('就绪');
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '节目单', exact: true }).click();
    await page.getByLabel('工程菜单', { exact: true }).click();
    await page.getByRole('menuitem', { name: '找回缺失素材', exact: true }).click();
    await expect(page.getByText('工程用到的素材都在工程文件夹内', { exact: true })).toBeVisible();
    await expect(dialog).toHaveCount(0);
  } finally {
    const page = await app.firstWindow();
    await page.evaluate(() => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null }));
    await app.close();
  }
});
