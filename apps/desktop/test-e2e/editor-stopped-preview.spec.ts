import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpeg from 'ffmpeg-static';
import OBSWebSocket from 'obs-websocket-js';
import { materialSceneNames } from '@tb/core/link';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { createDefaultIntegrationProfile } from '../src/renderer/src/link/view-models/local-integration-profile';
import { closeDiscarding } from './save-questions';

test('停止时拖动黄线显示实际 OBS 视频帧，机位切回后定位正确且不锁编辑器', async ({}, info) => {
  test.skip(!process.env.TBLINK_OVERLAY_OBS_EXE || !process.env.TBLINK_OVERLAY_OBS_URL, '需要独立测试 OBS，禁止使用现场 OBS');
  test.setTimeout(90000);
  if (!ffmpeg) throw new Error('缺少测试媒体生成工具');
  const video = info.outputPath('assets', 'reference-media', 'video.mp4'); await mkdir(dirname(video), { recursive: true });
  await promisify(execFile)(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30', '-t', '10', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', video], { windowsHide: true });
  const project = parseLinkProject({ ...createEmptyLinkProject('停止拖动验收'), playbackSource: 'internal', obsOutputMode: 'scenes',
    mediaAssets: [{ id: 'video', name: '运动画面', kind: 'video', relativePath: 'assets/reference-media/video.mp4', width: 360, height: 640, durationMs: 10000,
      sha256: createHash('sha256').update(await readFile(video)).digest('hex'), byteLength: (await stat(video)).size }],
    rundown: [{ id: 'song', title: '无音频拖动验收', visualLayers: [{ id: 'camera-layer', name: '机位' }, { id: 'video-layer', name: '视频' }],
      referenceMediaClips: [{ id: 'clip', assetId: 'video', layerId: 'video-layer', label: '运动画面', startTimecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, durationMs: 10000 }],
      cues: [{ id: 'camera', name: '机位', layerId: 'camera-layer', timecode: { hours: 0, minutes: 0, seconds: 4, frames: 0 }, durationMs: 2000,
        actions: [{ id: 'scene', label: '机位', kind: 'obs.setProgramScene', sceneName: 'Bridge' }] }] }] });
  const file = info.outputPath('preview.tblink'); await writeFile(file, JSON.stringify(project));
  const app = await electron.launch({ env: { ...process.env, TBLINK_LOCAL_TEST_ACCESS: '1' },
    args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')] });
  const socket = new OBSWebSocket();
  try {
    await socket.connect(process.env.TBLINK_OVERLAY_OBS_URL);
    const page = await app.firstWindow();
    const profile = createDefaultIntegrationProfile();
    profile.obs.executablePath = process.env.TBLINK_OVERLAY_OBS_EXE!; profile.obs.webSocketUrl = process.env.TBLINK_OVERLAY_OBS_URL!;
    await page.evaluate(value => window.tbLink.saveIntegrationProfile({ profile: value, obsPassword: '' }), profile);
    await page.reload();
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
    await expect(page.locator('canvas[aria-label="OBS 实时画面"]')).toBeVisible();
    await expect.poll(async () => (await page.evaluate(() => window.tbLink.getObsSnapshot())).status).toBe('connected');
    const names = materialSceneNames(project.projectId, project.mediaAssets[0]!);
    const ruler = page.locator('.timeline-ruler');
    const seek = async (seconds: number): Promise<void> => {
      const tick = page.locator('.timeline-ruler');
      const dimensions = await tick.boundingBox(); if (!dimensions) throw new Error('缺少标尺');
      const scale = await page.locator('.timeline-clip.video').first().evaluate(element => element.getBoundingClientRect().width / 10);
      await ruler.click({ position: { x: seconds * scale, y: 12 } });
    };
    await seek(2);
    await expect.poll(async () => (await socket.call('GetCurrentProgramScene')).currentProgramSceneName, { timeout: 30000 }).toBe(names.sceneName);
    await expect.poll(async () => (await socket.call('GetMediaInputStatus', { inputName: names.sourceName })).mediaState).toBe('OBS_MEDIA_STATE_PAUSED');
    const canvas = page.locator('canvas[aria-label="OBS 实时画面"]');
    const pixels = () => canvas.evaluate(element => { const target = element as HTMLCanvasElement; const context = target.getContext('2d')!; return Array.from(context.getImageData(target.width / 2 - 50, target.height / 2 - 50, 100, 100).data).filter((_, index) => index % 4 !== 3).reduce((sum, value) => sum + value, 0); });
    await expect.poll(pixels).toBeGreaterThan(1000);
    const first = await canvas.screenshot();
    await seek(5);
    await expect.poll(async () => (await socket.call('GetCurrentProgramScene')).currentProgramSceneName).toBe('Bridge');
    await seek(8);
    await expect.poll(async () => (await socket.call('GetMediaInputStatus', { inputName: names.sourceName })).mediaCursor).toBeGreaterThan(7800);
    await expect.poll(async () => (await socket.call('GetCurrentProgramScene')).currentProgramSceneName).toBe(names.sceneName);
    await expect.poll(pixels).toBeGreaterThan(1000);
    expect((await canvas.screenshot()).equals(first)).toBe(false);
    const rulerBox = await ruler.boundingBox(); if (!rulerBox) throw new Error('缺少拖动标尺');
    const scale = await page.locator('.timeline-clip.video').first().evaluate(element => element.getBoundingClientRect().width / 10);
    await page.mouse.move(rulerBox.x + 8 * scale, rulerBox.y + 12); await page.mouse.down();
    for (const seconds of [7, 3, 9, 2, 1]) await page.mouse.move(rulerBox.x + seconds * scale, rulerBox.y + 12, { steps: 3 });
    await page.mouse.up();
    await expect.poll(async () => (await socket.call('GetMediaInputStatus', { inputName: names.sourceName })).mediaCursor).toBeLessThan(1200);
    await expect(page.getByRole('button', { name: '播放时间线', exact: true })).toBeVisible();
    await expect(page.locator('.toast.error')).toHaveCount(0);
    await expect(page.locator('.stage-error')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('stopped-preview.png') });
    await page.locator('.timeline-clip.video').first().click();
    await page.getByRole('button', { name: '从时间线移除', exact: true }).click();
    await expect(page.locator('.timeline-clip.video')).toHaveCount(0);
    await expect(page.locator('.toast.error')).toHaveCount(0);
  } finally { await socket.disconnect(); await closeDiscarding(app); }
});
