import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject } from '@tb/schema';

test('时间线更换工程后音源缺失，不沿用上一首音频或空跑', async ({}, info) => {
  const wav = Buffer.alloc(44 + 24000 * 4 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await writeFile(info.outputPath('song.wav'), wav);
  const files: string[] = [];
  for (const missing of [false, true]) {
    const file = info.outputPath(missing ? 'missing.tblink' : 'valid.tblink');
    const project = parseLinkProject({ ...createEmptyLinkProject(missing ? '音源缺失' : '有效音源'), schemaVersion: 2, playbackSource: 'p1', rundown: [{
      id: 'song', title: missing ? '音源缺失' : '有效音源', cues: [], lighting: createLightingDocument(),
      referenceAudio: { assetId: 'audio', relativePath: missing ? 'missing.wav' : 'song.wav', durationMs: 4000, sha256: createHash('sha256').update(wav).digest('hex') }
    }] });
    await writeFile(file, JSON.stringify(project)); files.push(file);
  }
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')], env: { ...process.env, TBLINK_LOCAL_TEST_ACCESS: '1' } });
  const page = await app.firstWindow();
  page.on('dialog', dialog => void dialog.accept());
  try {
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [file] }); }, files[0]!);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
    await expect(page.locator('.timeline-audio-engine')).toHaveCount(1);
    await expect.poll(() => page.locator('.timeline-audio-engine').evaluate(element => (element as HTMLAudioElement).readyState)).toBeGreaterThan(0);
    const oldSource = await page.locator('.timeline-audio-engine').getAttribute('src');
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [file] }); }, files[1]!);
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '节目单', exact: true }).click();
    await page.getByLabel('工程菜单', { exact: true }).click();
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await expect(page.locator('.p1-project-ribbon')).toHaveAttribute('title', files[1]!);
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
    await expect(page.getByRole('button', { name: '修改节目名称：音源缺失', exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('当前音频无法读取或解码');
    await expect(page.locator('.timeline-audio-engine')).not.toHaveAttribute('src', oldSource!);
    await expect.poll(() => page.locator('.timeline-audio-engine').evaluate(element => (element as HTMLAudioElement).error?.code)).toBe(4);
    await page.getByRole('button', { name: '播放时间线', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('当前音频无法读取或解码');
    await expect(page.getByRole('button', { name: '暂停时间线', exact: true })).toHaveCount(0);
    await page.waitForTimeout(250);
    await expect(page.locator('.timeline-transport code')).toHaveText('00:00');
  } finally { await page.evaluate(() => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null })); await app.close(); }
});
