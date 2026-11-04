import { test, expect, _electron as electron } from '@playwright/test';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEmptyLinkProject, createLightingDocument, lightingTrackSchema, parseLinkProject } from '@tb/schema';
import { saveProject, closeDiscarding } from './save-questions';
import { stubMidiPorts } from './midi-ports';

// 2026-11-01 only timecode remains: projects written by older versions store one of three modes. Each must open
// on a computer without MIDI, keep its lighting, and save back as timecode.
for (const native of [false, true]) test(`无 MIDI 设备时打开存着旧灯光模式的工程，灯光原样保留，保存后都是时间码，原生绑定=${native}`, async ({}, info) => {
  test.setTimeout(180_000);
  const lighting = createLightingDocument();
  lighting.tracks = [lightingTrackSchema.parse({ id: 'track', name: '灯光', kind: 'ma2', color: '#68c9ed', group: 'effect-canvas', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: 'clip', name: '灯光', start: 0, duration: 6000, timeLock: 'time', muted: false, events: [{ id: 'cue', kind: 'ma2', at: 1000, sequence: 168, cue: '1.000', executor: '', action: 'goto', label: '1' }] }] })];
  if (native) lighting.ma2Bindings = [{ id: 'native', name: '保留控台时间线', timecode: 2, readAt: new Date().toISOString(), sourceXml: '<MA><unknown/></MA>', baselineTracks: [], mappings: [], nativeEvents: [{ path: 'unknown', reason: '不可转换参数' }], playback: 'native-timecode', timeOriginMs: 0 }];
  const project = parseLinkProject({ ...createEmptyLinkProject('模式切换回归'), schemaVersion: 2, playbackSource: 'internal', rundown: [{ id: 'song', title: '模式切换歌曲', cues: [], lighting }] });
  const path = info.outputPath('mode.tblink');
  await writeFile(path, JSON.stringify(project));
  const errors: string[] = [];
  const launch = async () => {
    const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')], env: { ...process.env, TBLINK_LOCAL_TEST_ACCESS: '1' } });
    const page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForLoadState('domcontentloaded');
    // The test computer has no MIDI.
    await stubMidiPorts(app);
    return { app, page };
  };
  const stored = (mode: string) => JSON.stringify({ ...project, rundown: [{ ...project.rundown[0]!, lighting: { ...lighting, outputMode: mode } }] });
  await writeFile(path, stored('timecode'));
  let current = await launch();
  try {
    await current.app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [file] }); }, path);
    await current.page.getByRole('button', { name: '打开工程', exact: true }).click();
    for (const mode of ['timecode', 'direct', 'network'] as const) {
      if (mode !== 'timecode') {
        // Rewritten while the app is closed, so the project restored on the next launch stores this mode.
        await closeDiscarding(current.app);
        await writeFile(path, stored(mode));
        current = await launch();
      }
      await current.page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
      // The song's lighting state shows once the project has opened; saving before that saves nothing.
      await expect(current.page.locator('.lighting-output-route')).toBeVisible();
      await expect(current.page.getByRole('combobox', { name: '灯光输出方式' })).toHaveCount(0);
      await expect(current.page.getByText('界面暂时无法显示', { exact: true })).toHaveCount(0);
      await saveProject(current.page);
      await closeDiscarding(current.app);
      current = await launch();
      await current.page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
      await expect(current.page.locator('.lighting-output-route')).toBeVisible();
      const file = JSON.parse(await readFile(path, 'utf8')) as { rundown: Array<{ lighting: { outputMode: string } }> };
      expect(file.rundown[0]!.lighting.outputMode).toBe('timecode');
      const saved = parseLinkProject(file).rundown[0]!.lighting!;
      expect(saved.ma2Bindings).toEqual(project.rundown[0]!.lighting!.ma2Bindings);
      expect(saved.tracks).toEqual(project.rundown[0]!.lighting!.tracks);
      await expect(current.page.getByText('界面暂时无法显示', { exact: true })).toHaveCount(0);
    }
    expect(errors).toEqual([]);
    await current.page.screenshot({ path: info.outputPath('mode-restored.png') });
    await current.page.evaluate(file => localStorage.setItem('tblink.failed-render-project-path.v1', file), path);
    await closeDiscarding(current.app);
    current = await launch();
    await expect(current.page.getByText('上次的工程打开后显示异常', { exact: false })).toBeVisible();
    await expect(current.page.getByRole('button', { name: '打开工程', exact: true })).toBeVisible();
    await current.app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [file] }); }, path);
    await current.page.getByRole('button', { name: '打开工程', exact: true }).click();
    await current.page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
    await expect(current.page.locator('.lighting-output-route')).toBeVisible();
    await expect(current.page.getByText('界面暂时无法显示', { exact: true })).toHaveCount(0);
    expect(await current.page.evaluate(() => localStorage.getItem('tblink.failed-render-project-path.v1'))).toBeNull();
  } finally { await closeDiscarding(current.app); }
});
