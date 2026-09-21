import { test, expect, _electron as electron } from '@playwright/test';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';

test('44 秒 MP4 加入节目，短原声音轨及非整毫秒落点保存重开', async ({}, info) => {
  if (!ffmpegPath) throw new Error('缺少 FFmpeg');
  const video = info.outputPath('long-video.mp4');
  await promisify(execFile)(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=s=64x64:r=30:d=44.733', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=43.3', '-c:v', 'mpeg4', '-c:a', 'aac', video], { windowsHide: true });
  const project = parseLinkProject({ ...createEmptyLinkProject('长视频验收'), playbackSource: 'internal', mediaAssets: [{ id: 'video', name: 'long-video.mp4', relativePath: 'long-video.mp4', kind: 'video', durationMs: 44734, width: 64, height: 64, byteLength: (await stat(video)).size, sha256: createHash('sha256').update(await readFile(video)).digest('hex') }], rundown: [{ id: 'song', title: '长视频节目', cues: [] }] });
  const file = info.outputPath('show.tblink'); await writeFile(file, JSON.stringify(project));
  const executable = process.env.TBLINK_MA2_PACKAGED_EXE;
  const app = await electron.launch({ ...(executable ? { executablePath: executable } : {}), args: [`--user-data-dir=${info.outputPath('profile')}`, ...executable ? [] : [join(process.cwd(), 'out/main/index.cjs')]] });
  const page = await app.firstWindow();
  try {
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
    await page.locator('.timeline-ruler').click({ position: { x: 103, y: 10 } });
    await page.getByRole('button', { name: '添加素材 long-video.mp4 到时间线', exact: true }).click();
    await expect(page.locator('.timeline-clip')).toHaveCount(1);
    await expect.poll(async () => parseLinkProject(JSON.parse(await readFile(file, 'utf8'))).rundown[0]?.referenceAudio?.timeline?.tracks?.length).toBe(1);
    const saved = parseLinkProject(JSON.parse(await readFile(file, 'utf8'))).rundown[0]!;
    const track = saved.referenceAudio!.timeline!.tracks![0]!;
    expect(track.source.durationMs).toBeGreaterThan(43000); expect(track.source.durationMs).toBeLessThan(44000);
    expect(Number.isInteger(track.segments[0]!.startMs)).toBe(true);
    expect(saved.referenceMediaClips[0]!.durationMs).toBeGreaterThan(44000);
    await page.reload();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
    await expect(page.locator('.timeline-clip')).toHaveCount(1);
    await expect(page.locator('.audio-timeline-segment')).toHaveCount(1);
  } finally { await page.evaluate(() => window.tbLink.setDocumentDirty(false)); await app.close(); }
});
