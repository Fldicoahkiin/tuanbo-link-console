import { test, expect, _electron as electron } from '@playwright/test';
import { copyFile, readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpeg from 'ffmpeg-static';
import OBSWebSocket from 'obs-websocket-js';
import { materialSceneNames } from '@tb/core/link';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { createDefaultIntegrationProfile } from '../src/renderer/src/link/view-models/local-integration-profile';

test('真实 OBS 透明叠加播放与编辑器预览连续响应', async ({}, info) => {
  test.skip(!process.env.TBLINK_OVERLAY_OBS_EXE || !process.env.TBLINK_OVERLAY_OBS_URL || !process.env.TBLINK_OVERLAY_VIDEO, '需专用隔离 OBS 和透明素材，不使用现场 OBS');
  test.setTimeout(90_000);
  if (!ffmpeg) throw new Error('缺少音频测试工具');
  const audio = info.outputPath('silence.wav'), video = info.outputPath('cards.mov');
  await copyFile(process.env.TBLINK_OVERLAY_VIDEO!, video);
  await promisify(execFile)(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '6', audio], { windowsHide: true });
  const hash = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
  const project = parseLinkProject({ ...createEmptyLinkProject('透明叠加播放验收'), playbackSource: 'internal', mediaAssets: [{ id: 'cards', name: '透明扑克牌', kind: 'video', relativePath: 'cards.mov', width: 1080, height: 1920, durationMs: 2200, sha256: await hash(video), byteLength: (await stat(video)).size }], rundown: [{
    id: 'song', title: '叠加与预览测试', referenceAudio: { assetId: 'audio', relativePath: 'silence.wav', durationMs: 6000, sha256: await hash(audio) },
    visualLayers: [{ id: 'top', name: '透明特效', visible: true, locked: false }, { id: 'bottom', name: '机位', visible: true, locked: false }],
    referenceMediaClips: [{ id: 'clip', assetId: 'cards', label: '扑克牌', layerId: 'top', startTimecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, durationMs: 2200, embeddedAudioEnabled: false }],
    cues: [{ id: 'camera', name: '底层机位', layerId: 'bottom', timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, durationMs: 6000, actions: [{ id: 'scene', label: '机位', kind: 'obs.setProgramScene', sceneName: 'Bridge' }] }]
  }] });
  const file = info.outputPath('overlay.tblink'); await writeFile(file, JSON.stringify(project));
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')] });
  const page = await app.firstWindow();
  try {
    const profile = createDefaultIntegrationProfile();
    profile.obs.executablePath = process.env.TBLINK_OVERLAY_OBS_EXE!;
    profile.obs.webSocketUrl = process.env.TBLINK_OVERLAY_OBS_URL!;
    await page.evaluate(value => window.tbLink.saveIntegrationProfile({ profile: value, obsPassword: '' }), profile);
    await page.reload();
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
    await expect(page.locator('canvas[aria-label="OBS 实时画面"]')).toBeVisible();
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
    await page.keyboard.press('Control+m');
    await page.getByRole('button', { name: '播放时间线', exact: true }).click();
    await expect(page.getByRole('button', { name: '暂停时间线', exact: true })).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => parseTimelineSeconds(await page.locator('.timeline-transport code').innerText())).toBeGreaterThan(0.8);
    await page.getByRole('button', { name: '暂停时间线', exact: true }).click();
    await expect(page.getByRole('button', { name: '播放时间线', exact: true })).toBeVisible();
    const paused = await page.locator('.timeline-transport code').innerText();
    await page.screenshot({ path: info.outputPath('alpha-paused.png') });
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 800)));
    await expect(page.locator('.timeline-transport code')).toHaveText(paused);
    const scene = await page.evaluate(() => window.tbLink.readObsLiveScene());
    expect(scene.sceneName).toBe(`团播联动台·叠加·${project.projectId}`);
    expect(scene.items.filter(item => item.sceneItemEnabled).map(item => item.sourceName)).toContain(materialSceneNames(project.projectId, project.mediaAssets[0]!).sceneName);
    await page.getByRole('button', { name: '播放时间线', exact: true }).click();
    await expect.poll(async () => parseTimelineSeconds(await page.locator('.timeline-transport code').innerText())).toBeGreaterThan(parseTimelineSeconds(paused) + 0.3);
    await app.evaluate(({ app: desktop }) => desktop.getAppMetrics());
    const metrics = await page.evaluate(async () => {
      const context = document.querySelector<HTMLCanvasElement>('canvas[aria-label="OBS 实时画面"]')!.getContext('2d')!;
      const original = context.putImageData.bind(context);
      let frames = 0, maximumDelayMs = 0;
      context.putImageData = (data: ImageData, x: number, y: number): void => { frames++; original(data, x, y); };
      const start = performance.now(); let previous = start;
      const timer = window.setInterval(() => { const now = performance.now(); maximumDelayMs = Math.max(maximumDelayMs, now - previous); previous = now; }, 50);
      try { await new Promise(resolve => setTimeout(resolve, 4000)); return { frames, maximumDelayMs, seconds: (performance.now() - start) / 1000 }; }
      finally { clearInterval(timer); context.putImageData = original; }
    });
    const processes = await app.evaluate(({ app: desktop }) => desktop.getAppMetrics().map(process => ({ type: process.type, cpu: process.cpu.percentCPUUsage, workingSetKiB: process.memory.workingSetSize })));
    await writeFile(info.outputPath('preview-metrics.json'), JSON.stringify({ ...metrics, processes }, null, 2));
    expect(metrics.frames / metrics.seconds).toBeGreaterThan(20);
    expect(metrics.maximumDelayMs).toBeLessThan(500);
    await expect(page.locator('.toast.error')).toHaveCount(0);
    await expect(page.locator('.stage-error')).toHaveCount(0);
    await expect(page.locator('.timeline-transport code')).not.toHaveText('00:00');
    await page.getByRole('button', { name: '停止时间线', exact: true }).click();
    await expect(page.getByRole('button', { name: '播放时间线', exact: true })).toBeVisible();
    await expect(page.locator('.timeline-transport code')).toHaveText('00:00');
    // Leave a real decoder at EOF before starting a second session from the middle.
    // Fresh playback alone misses terminal states left by earlier application sessions.
    const names = materialSceneNames(project.projectId, project.mediaAssets[0]!);
    const pausedSource = new OBSWebSocket();
    try {
      await pausedSource.connect(process.env.TBLINK_OVERLAY_OBS_URL);
      const item = await pausedSource.call('GetSceneItemId', { sceneName: names.sceneName, sourceName: names.sourceName });
      await pausedSource.call('SetSceneItemEnabled', { sceneName: names.sceneName, sceneItemId: item.sceneItemId, sceneItemEnabled: true });
      await pausedSource.call('SetCurrentProgramScene', { sceneName: names.sceneName });
      await pausedSource.call('TriggerMediaInputAction', { inputName: names.sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' });
      await expect.poll(async () => (await pausedSource.call('GetMediaInputStatus', { inputName: names.sourceName })).mediaState).toBe('OBS_MEDIA_STATE_ENDED');
    } finally { await pausedSource.disconnect(); }
    for (let frame = 0; frame < 24; frame++) {
      await page.getByRole('button', { name: '下一帧', exact: true }).click();
      await expect(page.locator('.timeline-transport code')).toHaveText(`00:${String(frame + 1).padStart(2, '0')}`);
    }
    await expect(page.locator('.timeline-transport code')).toHaveText('00:24');
    await page.getByRole('button', { name: '播放时间线', exact: true }).click();
    await expect.poll(async () => parseTimelineSeconds(await page.locator('.timeline-transport code').innerText()), { timeout: 15_000 }).toBeGreaterThan(1.2);
    await page.getByRole('button', { name: '暂停时间线', exact: true }).click();
    await expect(page.getByRole('button', { name: '播放时间线', exact: true })).toBeVisible();
    const inventory = await page.evaluate(() => window.tbLink.readObsInventory());
    expect(inventory.sceneItemTransforms?.[names.sceneName]?.[names.sourceName]?.sourceWidth).toBe(1080);
    await page.screenshot({ path: info.outputPath('alpha-middle.png') });
    await expect(page.locator('.toast.error')).toHaveCount(0);
    await page.getByRole('button', { name: '停止时间线', exact: true }).click();
    await page.screenshot({ path: info.outputPath('overlay-editor.png') });
  } catch (error) {
    await page.screenshot({ path: info.outputPath('failure.png') });
    await writeFile(info.outputPath('failure-ui.txt'), await page.locator('body').innerText());
    throw error;
  } finally {
    await app.evaluate(({ app: desktop }) => desktop.exit());
    await app.close();
    const socket = new OBSWebSocket();
    try {
      await socket.connect(process.env.TBLINK_OVERLAY_OBS_URL);
      const names = materialSceneNames(project.projectId, project.mediaAssets[0]!);
      if ((await socket.call('GetInputList')).inputs.some(input => input.inputName === names.sourceName)) {
        await socket.call('SetInputSettings', { inputName: names.sourceName, inputSettings: { local_file: '', close_when_inactive: true }, overlay: true });
      }
    } finally { await socket.disconnect(); }
  }
});

function parseTimelineSeconds(value: string): number {
  const [frames = 0, seconds = 0, minutes = 0, hours = 0] = value.split(':').map(Number).reverse();
  return hours * 3600 + minutes * 60 + seconds + frames / 30;
}

test('第二段透明视频进入与退出时底层视频连续前进', async ({}, info) => {
  test.skip(!process.env.TBLINK_OVERLAY_OBS_EXE || !process.env.TBLINK_OVERLAY_OBS_URL || !process.env.TBLINK_OVERLAY_VIDEO, '需隔离 OBS 与透明素材');
  test.setTimeout(90_000);
  if (!ffmpeg) throw new Error('缺少测试媒体生成工具');
  const audio = info.outputPath('silence.wav'), cards = info.outputPath('cards.mov'), base = info.outputPath('base.mp4');
  await copyFile(process.env.TBLINK_OVERLAY_VIDEO!, cards);
  await promisify(execFile)(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '12', audio], { windowsHide: true });
  await promisify(execFile)(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30', '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', base], { windowsHide: true });
  const hash = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
  const project = parseLinkProject({ ...createEmptyLinkProject('双层连续播放'), playbackSource: 'internal', obsOutputMode: 'scenes', mediaAssets: [
    { id: 'cards', name: '透明牌', kind: 'video', relativePath: 'cards.mov', width: 1080, height: 1920, durationMs: 2200, sha256: await hash(cards), byteLength: (await stat(cards)).size },
    { id: 'base', name: '运动背景', kind: 'video', relativePath: 'base.mp4', width: 360, height: 640, durationMs: 12000, sha256: await hash(base), byteLength: (await stat(base)).size }
  ], rundown: [{ id: 'song', title: '连续底层', referenceAudio: { assetId: 'audio', relativePath: 'silence.wav', durationMs: 12000, sha256: await hash(audio) },
    visualLayers: [{ id: 'top', name: '特效', visible: true, locked: false }, { id: 'bottom', name: '视频', visible: true, locked: false }],
    referenceMediaClips: [
      ...[0, 4].map(seconds => ({ id: `cards-${seconds}`, assetId: 'cards', label: '透明牌', layerId: 'top', startTimecode: { hours: 0, minutes: 0, seconds, frames: 0 }, durationMs: 2200, embeddedAudioEnabled: false })),
      { id: 'base-clip', assetId: 'base', label: '持续背景', layerId: 'bottom', startTimecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, durationMs: 12000, embeddedAudioEnabled: false }
    ]
  }] });
  const file = info.outputPath('continuous.tblink'); await writeFile(file, JSON.stringify(project));
  const socket = new OBSWebSocket();
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')] });
  const page = await app.firstWindow();
  const baseName = materialSceneNames(project.projectId, project.mediaAssets[1]!).sourceName;
  const samples: Array<{ elapsed: number; cursor: number; state: string }> = [];
  const playbackStarts: string[] = [];
  const backgroundFrames: string[] = [];
  try {
    await socket.connect(process.env.TBLINK_OVERLAY_OBS_URL);
    socket.on('MediaInputPlaybackStarted', event => { if (event.inputName === baseName) playbackStarts.push('started'); });
    const profile = createDefaultIntegrationProfile();
    profile.obs.executablePath = process.env.TBLINK_OVERLAY_OBS_EXE!; profile.obs.webSocketUrl = process.env.TBLINK_OVERLAY_OBS_URL!;
    await page.evaluate(value => window.tbLink.saveIntegrationProfile({ profile: value, obsPassword: '' }), profile);
    await page.reload();
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
    await page.keyboard.press('Control+m');
    await page.getByRole('button', { name: '播放时间线', exact: true }).click();
    await expect.poll(async () => parseTimelineSeconds(await page.locator('.timeline-transport code').innerText()), { timeout: 30_000 }).toBeGreaterThan(2.8);
    playbackStarts.length = 0;
    const started = performance.now();
    do {
      const state = await socket.call('GetMediaInputStatus', { inputName: baseName });
      samples.push({ elapsed: performance.now() - started, cursor: state.mediaCursor, state: state.mediaState });
      if (backgroundFrames.length < 2 && state.mediaCursor >= 4600 + backgroundFrames.length * 500) {
        const frame = await socket.call('GetSourceScreenshot', { sourceName: baseName, imageFormat: 'png', imageWidth: 180, imageHeight: 320 });
        backgroundFrames.push(frame.imageData);
      }
      await new Promise(resolve => setTimeout(resolve, 60));
    } while (performance.now() - started < 4800);
    await writeFile(info.outputPath('base-continuity.json'), JSON.stringify({ samples, playbackStartedEvents: playbackStarts, frameHashes: backgroundFrames.map(frame => createHash('sha256').update(frame).digest('hex')) }, null, 2));
    expect(samples.every(sample => sample.state === 'OBS_MEDIA_STATE_PLAYING')).toBe(true);
    expect(playbackStarts).toEqual([]);
    expect(backgroundFrames).toHaveLength(2);
    expect(backgroundFrames[0]).not.toBe(backgroundFrames[1]);
    const first = samples[0]!;
    for (const sample of samples) {
      expect(Math.abs((sample.cursor - first.cursor) - (sample.elapsed - first.elapsed))).toBeLessThan(180);
    }
    await expect(page.locator('.toast.error')).toHaveCount(0);
    await page.getByRole('button', { name: '停止时间线', exact: true }).click();
  } finally {
    await app.evaluate(({ app: desktop }) => desktop.exit()); await app.close();
    for (const asset of project.mediaAssets) {
      const names = materialSceneNames(project.projectId, asset);
      if ((await socket.call('GetInputList')).inputs.some(input => input.inputName === names.sourceName)) {
        await socket.call('SetInputSettings', { inputName: names.sourceName, inputSettings: { local_file: '', close_when_inactive: true }, overlay: true });
      }
    }
    await socket.disconnect();
  }
});
