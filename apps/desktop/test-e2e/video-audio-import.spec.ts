import { test, expect, _electron as electron, type Page } from '@playwright/test';
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
    await page.locator('.audio-timeline-segment').click({ position: { x: 30, y: 35 } });
    await expect(page.getByLabel('音频片段位置', { exact: true })).toBeVisible();
    await page.getByLabel('音频片段位置', { exact: true }).fill('5');
    await page.getByLabel('音频片段位置', { exact: true }).press('Enter');
    await expect.poll(async () => parseLinkProject(JSON.parse(await readFile(file, 'utf8'))).rundown[0]?.referenceAudio?.timeline?.tracks?.[0]?.segments[0]?.startMs).toBe(5000);
    await page.locator('.audio-timeline-segment').click({ position: { x: 30, y: 35 } });
    await page.keyboard.press('Delete');
    await expect(page.locator('.audio-timeline-segment')).toHaveCount(0);
    await expect(page.locator('.timeline-clip')).toHaveCount(1);
    await expect.poll(async () => parseLinkProject(JSON.parse(await readFile(file, 'utf8'))).rundown[0]?.referenceAudio).toBeUndefined();
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(page.locator('.audio-timeline-segment')).toHaveCount(1);
    await expect(page.locator('.timeline-clip')).toHaveCount(1);
  } finally { await page.evaluate(() => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null })); await app.close(); }
});

for (const dimensions of [{ width: 1920, height: 1080 }, { width: 3840, height: 2160 }]) {
test(`40 秒 ${dimensions.width} 视频打开后立即拖入与缓存复用：真实音画片段出现耗时、撤销及保存恢复`, async ({}, info) => {
  if (!ffmpegPath) throw new Error('缺少 FFmpeg');
  const video = info.outputPath('forty-seconds.mp4');
  await promisify(execFile)(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${dimensions.width}x${dimensions.height}:r=30:d=40`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=40', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', video], { windowsHide: true });
  const project = parseLinkProject({ ...createEmptyLinkProject('拖入速度验收'), playbackSource: 'internal',
    mediaAssets: [{ id: 'video', name: 'forty-seconds.mp4', relativePath: 'forty-seconds.mp4', kind: 'video', durationMs: 40000, ...dimensions,
      byteLength: (await stat(video)).size, sha256: createHash('sha256').update(await readFile(video)).digest('hex') }],
    rundown: [{ id: 'song', title: '40 秒节目', cues: [] }] });
  const file = info.outputPath('show.tblink'); await writeFile(file, JSON.stringify(project));
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')] });
  const page = await app.firstWindow();
  try {
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
    const immediateDropMs = await timedVideoDrop(page);
    const warmMs: number[] = [];
    for (let index = 0; index < 10; index++) {
      await page.getByRole('button', { name: '撤销', exact: true }).click();
      await expect(page.locator('.timeline-clip')).toHaveCount(0);
      await expect(page.locator('.audio-timeline-segment')).toHaveCount(0);
      warmMs.push(await timedVideoDrop(page));
    }
    await expect.poll(async () => parseLinkProject(JSON.parse(await readFile(file, 'utf8'))).rundown[0]?.referenceAudio?.timeline?.tracks?.length).toBe(1);
    const saved = parseLinkProject(JSON.parse(await readFile(file, 'utf8'))).rundown[0]!;
    expect(saved.referenceMediaClips).toHaveLength(1);
    expect(saved.referenceAudio!.durationMs).toBe(40000);
    await page.reload();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
    await expect(page.locator('.timeline-clip')).toHaveCount(1);
    await expect(page.locator('.audio-timeline-segment')).toHaveCount(1);
    const preparationMs = await page.evaluate(async ({ file, video, tracks }) => {
      const start = performance.now();
      const source = await window.tbLink.importReferenceAudio({ projectPath: file, sourcePath: video, durationMs: 40000 });
      const extracted = performance.now();
      await window.tbLink.renderAudioSegments({ projectPath: file, source, segments: tracks[0]!.segments, tracks });
      return { extractedAudio: extracted - start, composedAudio: performance.now() - extracted };
    }, { file, video, tracks: saved.referenceAudio!.timeline!.tracks! });
    const result = { video: `${dimensions.width}x${dimensions.height} 30fps 40s`, immediateDropMs, warmMs, preparationMs,
      warmP95Ms: [...warmMs].sort((a, b) => a - b)[Math.ceil(warmMs.length * 0.95) - 1],
      scope: '真实拖放事件到视频与独立音轨可见；不包含 OBS 首帧显示和正式声光输出' };
    await writeFile(info.outputPath('drop-latency.json'), JSON.stringify(result, null, 2));
    await info.attach('拖入耗时', { body: JSON.stringify(result), contentType: 'application/json' });
    expect(result.warmP95Ms).toBeLessThanOrEqual(100);
  } finally { await page.evaluate(() => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null })); await app.close(); }
});
}

test('已有音乐时首次拖入 4K 视频：十个不同落点不复用混音结果', async ({}, info) => {
  if (!ffmpegPath) throw new Error('缺少 FFmpeg');
  const video = info.outputPath('video.mp4'); const music = info.outputPath('music.wav');
  await promisify(execFile)(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=3840x2160:r=30:d=40',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=40', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', video], { windowsHide: true });
  await promisify(execFile)(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=40',
    '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', music], { windowsHide: true });
  const project = parseLinkProject({ ...createEmptyLinkProject('多轨拖入验收'), playbackSource: 'internal',
    mediaAssets: [{ id: 'video', name: 'video.mp4', relativePath: 'video.mp4', kind: 'video', durationMs: 40000, width: 3840, height: 2160,
      byteLength: (await stat(video)).size, sha256: createHash('sha256').update(await readFile(video)).digest('hex') }],
    rundown: [{ id: 'song', title: '已有音乐', cues: [], referenceAudio: { assetId: 'music', relativePath: 'music.wav', durationMs: 40000,
      sha256: createHash('sha256').update(await readFile(music)).digest('hex') } }] });
  const file = info.outputPath('show.tblink'); await writeFile(file, JSON.stringify(project));
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')] });
  const page = await app.firstWindow();
  try {
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
    // Original audio has been prepared in the library. No target-position mix
    // exists: each drop is deliberately at a previously unused position.
    const manifest = info.outputPath('cache', 'reference-audio', `${project.mediaAssets[0]!.sha256}.json`);
    await expect.poll(async () => {
      try { return (await stat(manifest)).size > 0; }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error; }
    }, { timeout: 10000 }).toBe(true);
    const firstMixMs: number[] = [];
    const positions: string[] = [];
    for (let index = 0; index < 10; index++) {
      firstMixMs.push(await timedVideoDrop(page, { audioCount: 2, offset: index * 35 }));
      positions.push(await page.locator('.timeline-clip').evaluate(element => (element as HTMLElement).style.left));
      if (index < 9) {
        await page.getByRole('button', { name: '撤销', exact: true }).click();
        await expect(page.locator('.timeline-clip')).toHaveCount(0);
        await expect(page.locator('.audio-timeline-segment')).toHaveCount(1);
      }
    }
    await expect.poll(async () => parseLinkProject(JSON.parse(await readFile(file, 'utf8'))).rundown[0]?.referenceAudio?.timeline?.tracks?.length).toBe(2);
    await page.reload();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
    await expect(page.locator('.timeline-clip')).toHaveCount(1);
    await expect(page.locator('.audio-timeline-segment')).toHaveCount(2);
    expect(new Set(positions).size).toBe(10);
    const result = { firstMixMs, positions, p95Ms: [...firstMixMs].sort((a, b) => a - b)[9],
      scope: '40 秒已有音乐 + 40 秒 4K 视频，源音轨已准备；十个新落点首次混音，计时至音画片段出现，不代表 OBS 首帧' };
    await writeFile(info.outputPath('multitrack-drop-latency.json'), JSON.stringify(result, null, 2));
    await info.attach('已有音乐拖入耗时', { body: JSON.stringify(result), contentType: 'application/json' });
  } finally { await page.evaluate(() => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null })); await app.close(); }
});

async function timedVideoDrop(page: Page, options = { audioCount: 1, offset: 0 }): Promise<number> {
  await expect(page.locator('.timeline-new-layer-drop')).toBeVisible();
  // Use the same MIME payload as the material drag source and the actual empty
  // lane's React drop handler; timing starts before dispatch, not after IPC.
  return page.evaluate(({ audioCount, offset }) => new Promise<number>((resolve, reject) => {
    const lane = document.querySelector('.timeline-new-layer-drop');
    if (!lane) { reject(new Error('没有可拖入的轨道')); return; }
    const started = performance.now();
    const observer = new MutationObserver(() => {
      if (document.querySelector('.timeline-clip') && document.querySelectorAll('.audio-timeline-segment').length === audioCount) {
        observer.disconnect(); clearTimeout(timeout); resolve(performance.now() - started);
      }
    });
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('拖入素材后 10 秒内未生成音画片段')); }, 10000);
    observer.observe(document.body, { childList: true, subtree: true });
    const transfer = new DataTransfer(); transfer.setData('application/x-tblink-media-asset', 'video');
    lane.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true, clientX: lane.getBoundingClientRect().left + offset }));
  }), options);
}
