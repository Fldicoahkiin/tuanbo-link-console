import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { test, expect, _electron as electron } from '@playwright/test';
import { createEmptyLinkProject, createLightingDocument, createLightingMusic, parseLinkProject } from '@tb/schema';
import { closeDiscarding } from './save-questions';

for (const dense of [false, true]) test(`底部时间线：${dense ? '密集' : '常规'} Cue 拖动、吸附、撤销，上方布局保持原样`, async ({}, info) => {
  const wav = Buffer.alloc(44 + 48000 * 51 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 0; i < 48000 * 51; i++) { const t = i / 48000; wav.writeInt16LE(Math.round(Math.sin(t * Math.PI * 180) * Math.exp(-(t % .48) * 13) * (.4 + .3 * Math.sin(t * .15) ** 2) * 28000), 44 + i * 2); }
  await mkdir(info.outputPath('assets/reference-audio'), { recursive: true }); await writeFile(info.outputPath('assets/reference-audio/reference.wav'), wav);
  const lighting = createLightingDocument();
  if (dense) { lighting.version = 2; lighting.music = { ...createLightingMusic(), ruler: 'beats' }; }
  lighting.tracks = [{ id: 'track', name: '灯光', kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false, channel: 1, controller: 7, portProfileId: '', noteNames: {}, clips: [{ id: 'clip', name: '灯光编排', start: 0, duration: 51000, timeLock: 'time', muted: false, events: Array.from({ length: 10 }, (_, i) => ({ id: `cue-${i}`, kind: 'ma2', at: 1300 + i * (dense ? 5 : 4800), sequence: 101, executor: '', cue: `${i + 1}.000`, action: 'goto', label: `灯光 ${i + 1}` })) }] }];
  const project = parseLinkProject({ ...createEmptyLinkProject('时间线布局验收'), schemaVersion: 2, rundown: [{ id: 'song', title: '团播音乐 · 时间线样例', enabled: true, notes: '合成测试音频，不是识别精度样本', cues: [], visualLayers: [], referenceMediaClips: [], lighting, referenceAudio: { assetId: 'audio', relativePath: 'assets/reference-audio/reference.wav', durationMs: 51000, sha256: createHash('sha256').update(wav).digest('hex') } }] });
  const file = info.outputPath('timeline.tblink');
  await writeFile(file, JSON.stringify(project));
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')], env: { ...process.env, TBLINK_LOCAL_TEST_ACCESS: '1' } });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const saved = async () => parseLinkProject(JSON.parse(await readFile(file, 'utf8'))).rundown[0]!.lighting!;
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
    const timeline = page.locator('.reference-timeline');
    const dock = page.getByRole('region', { name: '灯光效果库', exact: true });
    await expect(timeline).toHaveAttribute('data-lighting-timeline', 'true');
    const upper = (await dock.boundingBox())!;
    const bottom = (await timeline.boundingBox())!;
    expect(upper.y + upper.height).toBeLessThanOrEqual(bottom.y);
    expect(upper.x).toEqual(bottom.x);
    expect(upper.width).toEqual(bottom.width);
    expect((await timeline.locator('.timeline-toolbar').boundingBox())!.height).toBeLessThanOrEqual(52);
    await expect(page.getByRole('navigation', { name: '灯光素材主菜单' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cue 编辑器', exact: true })).toHaveCount(0);
    await expect(timeline.getByRole('button', { name: /BPM|敲击测速/ })).toHaveCount(0);
    await expect(timeline.locator('.music-grid-line')).toHaveCount(0);
    expect(await timeline.locator('.timeline-ruler > span').count()).toBeGreaterThan(0);
    await page.getByRole('button', { name: '适合节目时长', exact: true }).click();
    await expect(page.locator('.wavesurfer-surface[data-ready=true]').first()).toBeVisible({ timeout: 20000 });
    for (const close of await page.getByRole('button', { name: '关闭通知', exact: true }).all()) await close.click();
    await timeline.screenshot({ path: info.outputPath('timeline.png') });
    await page.screenshot({ path: info.outputPath('workspace.png') });
    await timeline.getByRole('button', { name: '时间线显示', exact: true }).click();
    await expect(page.getByRole('switch', { name: '原有参考网格' })).toHaveCount(0);
    await expect(page.getByRole('switch', { name: '歌曲段落' })).toBeVisible();
    await timeline.getByRole('button', { name: '音乐分析', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '时间线显示', exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: '音乐节拍分段', exact: true })).toBeVisible();
    await timeline.screenshot({ path: info.outputPath('timeline-analysis.png') });
    await page.getByRole('button', { name: '关闭节拍分段', exact: true }).click();
    await expect(page.getByRole('region', { name: '音乐节拍分段', exact: true })).toHaveCount(0);
    await page.locator('.lighting-playback-settings > summary').click();
    await page.getByRole('switch', { name: '选中 Cue 实时播放', exact: true }).uncheck();
    await page.locator('.lighting-playback-settings > summary').click();
    const lane = page.getByLabel('Cue 框选画布');
    if (dense) {
      await expect(page.locator('.waveform-cue-point')).toHaveCount(10);
      await expect(page.locator('.cue-cluster-trigger')).toHaveCount(0);
      const boxes = await page.locator('.waveform-cue-point').evaluateAll(nodes => nodes.map(node => {
        const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, right: box.right, bottom: box.bottom };
      }));
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!; const b = boxes[j]!;
        expect(a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y).toBe(true);
      }
      const last = page.getByRole('button', { name: '音频 Cue 10', exact: true });
      await last.scrollIntoViewIfNeeded();
      await last.click();
      await expect(last).toHaveAttribute('aria-pressed', 'true');
      await page.screenshot({ path: info.outputPath('dense-direct.png') });
    }
    const first = page.getByRole('button', { name: '音频 Cue 1', exact: true });
    await first.scrollIntoViewIfNeeded();
    expect((await first.boundingBox())!.y - (await lane.boundingBox())!.y).toBeLessThan(64);
    await first.click();
    await expect(page.getByLabel('当前 Cue 时间', { exact: true })).toContainText('01:09');
    await timeline.screenshot({ path: info.outputPath('timeline-selected.png') });
    await page.getByRole('button', { name: '关闭吸附', exact: true }).click();
    const marker = (await first.boundingBox())!;
    await page.mouse.move(marker.x + marker.width / 2, marker.y + 14);
    await page.mouse.down();
    await page.mouse.move(marker.x + marker.width / 2 + 43, marker.y + 14, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.press('Control+s');
    await expect.poll(async () => (await saved()).tracks[0]!.clips[0]!.events[0]!.at).toBeGreaterThan(1300);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await page.keyboard.press('Control+s');
    await expect.poll(async () => (await saved()).tracks[0]!.clips[0]!.events.map(event => event.at)).toEqual(lighting.tracks[0]!.clips[0]!.events.map(event => event.at));
    expect((await saved()).tempos).toEqual(lighting.tempos);
    expect((await saved()).tracks[0]!.clips[0]!.events[0]).toMatchObject({ cue: '1.000' });
    await page.getByRole('button', { name: '开启吸附', exact: true }).click();
    if (!dense) {
      const from = (await first.boundingBox())!;
      const to = (await page.getByRole('button', { name: '音频 Cue 2', exact: true }).boundingBox())!;
      await page.mouse.move(from.x + from.width / 2, from.y + 14);
      await page.mouse.down();
      await page.mouse.move(to.x + from.width / 2 - 4, from.y + 14, { steps: 10 });
      await page.mouse.up();
      await page.keyboard.press('Control+s');
      await expect.poll(async () => (await saved()).tracks[0]!.clips[0]!.events[0]!.at).toBe(6100);
      await page.getByRole('button', { name: '撤销', exact: true }).click();
      await page.keyboard.press('Control+s');
      await expect.poll(async () => (await saved()).tracks[0]!.clips[0]!.events[0]!.at).toBe(1300);
    }
    await page.setViewportSize({ width: 1180, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    await expect(page.getByRole('button', { name: '播放时间线', exact: true })).toBeVisible();
    expect((await timeline.locator('.timeline-toolbar').boundingBox())!.height).toBeLessThanOrEqual(52);
    const analysisButton = (await timeline.getByRole('button', { name: '音乐分析', exact: true }).boundingBox())!;
    const fitButton = (await page.getByRole('button', { name: '适合节目时长', exact: true }).boundingBox())!;
    expect(analysisButton.x).toBeGreaterThan((await page.getByRole('button', { name: '播放时间线', exact: true }).boundingBox())!.x);
    expect(fitButton.x + fitButton.width).toBeLessThanOrEqual((await timeline.boundingBox())!.x + (await timeline.boundingBox())!.width);
    for (const close of await page.getByRole('button', { name: '关闭通知', exact: true }).all()) await close.click();
    await page.mouse.move(0, 0);
    await timeline.screenshot({ path: info.outputPath('timeline-compact.png') });
    expect(errors).toEqual([]);
  } catch (error) {
    await page.screenshot({ path: info.outputPath('failure.png') });
    throw error;
  } finally { await closeDiscarding(app); }
});
