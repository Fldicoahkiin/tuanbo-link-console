import { test, expect, _electron as electron } from '@playwright/test';
import { writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createEmptyLinkProject, createLightingUserLibrary, parseLinkProject, ma2AuditionRequestSchema } from '@tb/schema';

for (const playbackSource of ['p1', 'internal'] as const) {
test(`灯光工作台 ${playbackSource} 效果绑定、拖放打点与保存`, async ({}, info) => {
  const wav = Buffer.alloc(44 + 48000 * 12 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 0; i < 48000 * 12; i++) wav.writeInt16LE(Math.round(Math.sin(i / 48000 * 440 * Math.PI * 2) * 16000 * Math.exp(-(i % 24000) / 5000)), 44 + i * 2);
  const sha256 = createHash('sha256').update(wav).digest('hex');
  await writeFile(info.outputPath('dance.wav'), wav);
  const project = parseLinkProject({ ...createEmptyLinkProject('灯光工作台验收'), schemaVersion: 2, playbackSource, ma2MaterialLibrary: { version: 2, source: 'test', userLibrary: createLightingUserLibrary(), library: { directory: { show: '测试控台', generation: 'test', version: '3.9.60.74', entries: [] }, readAt: new Date().toISOString(), sequences: [{ sequence: 168, name: '开场', cues: [{ index: 0, number: '1.250', name: '蓝色扫光' }] }], fixtureUsage: [], errors: [] } }, rundown: [{ id: 'dance', title: '力量舞蹈片段', cues: [], referenceAudio: { assetId: 'audio', relativePath: 'dance.wav', sha256, durationMs: 12000 } }] });
  const file = info.outputPath('lighting.tblink'); await writeFile(file, JSON.stringify(project));
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), process.env.TBLINK_MTC_SOAK_BUILD_DIR ?? 'out', 'main/index.cjs')] });
  try {
    const page = await app.firstWindow();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    const nav = page.getByRole('navigation', { name: '主要工作区' });
    await nav.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
    await page.getByRole('navigation', { name: '设置子子菜单' }).getByRole('button', { name: 'MA2 控台', exact: true }).click();
    await page.getByLabel('MA2 连接方式').selectOption('network');
    await nav.getByRole('button', { name: '灯光工作台', exact: true }).click();
    await expect(page.getByRole('heading', { name: '跟着音乐编灯' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: '灯光效果库' })).toBeVisible();
    await expect(page.getByRole('button', { name: '切开音频', exact: true })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: '2 · 划段落' })).toHaveCount(0);
    await expect(page.locator('[data-waveform-engine="wavesurfer"][data-ready="true"]').first()).toBeVisible();
    await expect(page.locator('.lighting-effect-placeholder')).toHaveCount(0);
    await page.locator('.lighting-effect-dock').screenshot({ path: info.outputPath('empty-workbench.png') });
    await expect(page.getByRole('region', { name: '灯光节目列表' })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: '灯光素材主菜单' })).toBeVisible();
    const divider = page.getByRole('separator', { name: '调整效果库和时间线高度' });
    const oldHeight = (await page.locator('.reference-timeline').boundingBox())!.height;
    const oldWaveHeight = (await page.locator('.waveform-lane').first().boundingBox())!.height;
    const dividerBox = (await divider.boundingBox())!;
    await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y + 3); await page.mouse.down();
    await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y - 80, { steps: 5 }); await page.mouse.up();
    await expect.poll(async () => (await page.locator('.reference-timeline').boundingBox())!.height).toBeGreaterThan(oldHeight + 30);
    await expect.poll(async () => (await page.locator('.waveform-lane').first().boundingBox())!.height).toBeGreaterThan(oldWaveHeight + 30);
    await expect.poll(() => page.locator('.timeline-viewport').evaluate(element => element.clientHeight - element.querySelector('.waveform-lane')!.getBoundingClientRect().height - element.querySelector('.timeline-ruler')!.getBoundingClientRect().height)).toBeLessThanOrEqual(6);
    await divider.dblclick();
    const audioEdge = page.getByRole('separator', { name: '调整音频轨道高度', exact: true });
    await audioEdge.hover({ position: { x: 100, y: 4 } });
    const edgeBox = (await audioEdge.boundingBox())!;
    const waveHeight = (await page.locator('.waveform-lane').first().boundingBox())!.height;
    await page.mouse.move(edgeBox.x + 100, edgeBox.y + 4); await page.mouse.down();
    await page.mouse.move(edgeBox.x + 100, edgeBox.y - 76, { steps: 5 }); await page.mouse.up();
    await expect(audioEdge).toHaveAttribute('aria-valuenow', String(waveHeight - 80));
    expect((await page.locator('.waveform-lane').first().boundingBox())!.height).toBe(waveHeight - 80);
    await audioEdge.dblclick({ position: { x: 100, y: 4 } }); await expect(audioEdge).toHaveAttribute('aria-valuenow', String(waveHeight));
    expect(await page.locator('.timeline-viewport').evaluate(element => element.scrollHeight <= element.clientHeight)).toBe(true);
    // The operator arranges Cue references; analysis must never auto-create lighting.
    await expect(page.getByRole('button', { name: '自动打 Cue', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('音乐网格间隔')).toHaveCount(0);
    await page.locator('.lighting-playback-settings > summary').click();
    await page.getByRole('checkbox', { name: '选中 Cue 实时播放', exact: true }).uncheck();
    await page.locator('.lighting-playback-settings > summary').click();
    const source = page.getByRole('button', { name: '试听序列 168 灯光步 1.250', exact: true });
    const events = async () => parseLinkProject(JSON.parse(await readFile(file, 'utf8'))).rundown[0]!.lighting?.tracks.flatMap(track => track.clips.flatMap(clip => clip.events)) ?? [];
    await source.dragTo(page.locator('.waveform-lane'), { targetPosition: { x: 230, y: 80 } });
    await expect(page.getByRole('button', { name: '音频 Cue 1', exact: true })).toBeVisible();
    await expect.poll(async () => (await events()).length).toBe(1);
    expect((await events())[0]).toMatchObject({ kind: 'ma2', sequence: 168, cue: '1.250', executor: '' });
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(page.locator('.waveform-cue-point')).toHaveCount(0);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await page.locator('.waveform-cue-point').dblclick();
    await page.getByLabel('时间（秒）', { exact: true }).fill('2.5');
    await page.getByRole('button', { name: '保存卡点', exact: true }).click();
    await expect(page.getByRole('button', { name: '音频 Cue 1', exact: true })).toBeVisible();
    await expect.poll(async () => (await events())[0]).toMatchObject({ cue: '1.250', at: 2500 });
    await expect(page.locator('.lighting-lane:visible')).toHaveCount(0);
    await source.dragTo(page.locator('.waveform-lane'), { targetPosition: { x: 430, y: 80 } });
    await expect(page.locator('.waveform-cue-point')).toHaveCount(2);
    await page.locator('.waveform-cue-point').last().click();
    await page.locator('.reference-timeline').focus(); await page.keyboard.press('Backspace');
    await expect(page.locator('.waveform-cue-point')).toHaveCount(1);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(page.locator('.waveform-cue-point')).toHaveCount(2);
    await expect.poll(async () => (await events()).length).toBe(2);
    const savedEvents = await events();
    const savedTempos = parseLinkProject(JSON.parse(await readFile(file, 'utf8'))).rundown[0]!.lighting!.tempos;
    await page.reload();
    await nav.getByRole('button', { name: '灯光工作台', exact: true }).click();
    await expect(page.locator('.waveform-cue-point')).toHaveCount(2);
    expect(await events()).toEqual(savedEvents);
    expect(parseLinkProject(JSON.parse(await readFile(file, 'utf8'))).rundown[0]!.lighting!.tempos).toEqual(savedTempos);
    for (const width of [1200, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(() => page.locator('.lighting-effect-dock').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await page.locator('.timeline-viewport').evaluate(element => element.scrollHeight <= element.clientHeight)).toBe(true);
      const cue = (await page.getByRole('button', { name: '音频 Cue 1', exact: true }).boundingBox())!;
      const wave = (await page.locator('.waveform-lane').first().boundingBox())!;
      expect(cue.y - wave.y).toBeLessThan(60);
      await page.screenshot({ path: info.outputPath(`workbench-${width}.png`), fullPage: true });
    }
    expect(errors).toEqual([]);
  } catch (error) {
    await writeFile(info.outputPath('failure-ui.txt'), await (await app.firstWindow()).locator('body').innerText());
    throw error;
  } finally { await closeWorkbench(app); }
});
}

test('序列池素材无需执行器，编辑与重开保留编号，点击 Cue 经网络试听', async ({}, info) => {
  const wav = Buffer.alloc(44 + 48000 * 4 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await writeFile(info.outputPath('pool.wav'), wav);
  const file = info.outputPath('pool.tblink');
  await writeFile(file, JSON.stringify(parseLinkProject({ ...createEmptyLinkProject('序列池编辑'), schemaVersion: 2, playbackSource: 'internal',
    ma2MaterialLibrary: { version: 2, source: 'test', userLibrary: createLightingUserLibrary(), library: { directory: { show: '测试控台', generation: 'test', version: '3.9.60.74', entries: [] }, readAt: new Date().toISOString(), sequences: [{ sequence: 168, name: '序列池开场', cues: [{ index: 0, number: '1.250', name: '序列池灯光' }] }], fixtureUsage: [], errors: [] } },
    rundown: [{ id: 'pool-song', title: '序列池节目', cues: [], referenceAudio: { assetId: 'audio', relativePath: 'pool.wav', durationMs: 4000, sha256: createHash('sha256').update(wav).digest('hex') } }] })));
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), process.env.TBLINK_MTC_SOAK_BUILD_DIR ?? 'out', 'main/index.cjs')] });
  try {
    const page = await app.firstWindow(); const calls: unknown[] = [];
    await app.evaluate(({ ipcMain, dialog }, file) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [file] });
      ipcMain.removeHandler('link:ma2-network-status');
      ipcMain.handle('link:ma2-network-status', () => ({ state: 'connected', settings: { host: '192.168.0.10', port: 30000, monitorPort: 30001, username: 'operator', autoConnect: false }, passwordSaved: false, error: null, version: '3.9.60.74' }));
      ipcMain.removeHandler('link:ma2-play-cancel'); ipcMain.handle('link:ma2-play-cancel', () => undefined);
    }, file);
    app.on('console', message => { if (message.text().startsWith('POOL_CUE:')) calls.push(JSON.parse(message.text().slice(9))); });
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('link:ma2-audition-play'); ipcMain.handle('link:ma2-audition-play', (_event, payload: unknown) => console.log(`POOL_CUE:${JSON.stringify(payload)}`));
    });
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
    await expect(page.locator('.wavesurfer-surface[data-ready=true]').first()).toBeVisible();
    await page.getByRole('button', { name: '试听序列 168 灯光步 1.250', exact: true }).dragTo(page.locator('.waveform-lane'), { targetPosition: { x: 230, y: 80 } });
    await page.locator('.waveform-cue-point').click();
    await expect(page.getByRole('columnheader', { name: '执行器（可选）' })).toHaveCount(0);
    await page.getByLabel('Cue 名称', { exact: true }).fill('序列池灯光');
    await expect(page.locator('.waveform-cue-point')).toHaveCount(1);
    await page.getByLabel('灯光输出方式').selectOption('network');
    await page.locator('.waveform-cue-point').click();
    await expect.poll(() => calls.length).toBeGreaterThan(0);
    expect(ma2AuditionRequestSchema.parse(calls.at(-1)).action).toEqual({ target: 'sequence', sequence: 168, cue: '1.250', action: 'goto' });
    await page.locator('.cue-ingredient > details > summary').click();
    await expect(page.getByLabel('素材 1 执行器', { exact: true })).toHaveValue('');
    await page.getByLabel('素材 1 Cue 编号', { exact: true }).fill('8.5');
    await page.getByLabel('素材 1 Cue 编号', { exact: true }).press('Tab');
    await expect(page.locator('.cue-marker-number')).toHaveText('1');
    await page.keyboard.press('Control+s');
    await expect.poll(async () => parseLinkProject(JSON.parse(await readFile(file, 'utf8'))).rundown[0]?.lighting?.tracks.flatMap(track => track.clips.flatMap(clip => clip.events))[0]).toMatchObject({ sequence: 168, cue: '8.5', executor: '' });
    await page.reload();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
    await page.locator('.waveform-cue-point').click();
    await page.locator('.cue-ingredient > details > summary').click();
    await expect(page.getByLabel('素材 1 Cue 编号')).toHaveValue('8.5');
    await expect(page.locator('.waveform-cue-point')).toHaveCount(1);
    await page.screenshot({ path: info.outputPath('sequence-pool-editor.png'), fullPage: true });
  } catch (error) {
    await writeFile(info.outputPath('failure-ui.txt'), await (await app.firstWindow()).locator('body').innerText());
    throw error;
  } finally { await closeWorkbench(app); }
});

async function closeWorkbench(app: Awaited<ReturnType<typeof electron.launch>>): Promise<void> {
  const page = await app.firstWindow();
  if (!page.isClosed()) {
    const stop = page.getByRole('button', { name: '停止时间线', exact: true });
    if (await stop.isVisible()) await stop.click();
    await page.evaluate(() => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null }));
  }
  await app.close();
}
