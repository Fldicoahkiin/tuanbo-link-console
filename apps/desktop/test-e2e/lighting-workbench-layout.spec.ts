import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { createEmptyLinkProject, createLightingDocument, createLightingUserLibrary, parseLinkProject, type LightingTrack } from '@tb/schema';
import { closeDiscarding } from './save-questions';

/** Elements that scroll sideways; the timeline scrolls along time on purpose. */
const sidewaysScroll = (page: Page): Promise<string[]> => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.app-shell *')].filter(element => {
  const style = getComputedStyle(element);
  if (element.clientWidth === 0 || style.display === 'none' || !['auto', 'scroll'].includes(style.overflowX)) return false;
  return element.scrollWidth > element.clientWidth + 1 && !element.closest('.timeline-viewport, .reference-timeline, .timeline-scroll');
}).map(element => `${element.tagName.toLowerCase()}.${[...element.classList].join('.')} ${element.scrollWidth}>${element.clientWidth}`));

test('灯光工作台在 1280×720 和 1180×720 下：不横向滚动，时间线留够高度，侧栏菜单完整，提示在时间线上方', async ({}, info) => {
  const wav = Buffer.alloc(44 + 24000 * 30 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await mkdir(info.outputPath('assets/reference-audio'), { recursive: true }); await writeFile(info.outputPath('assets/reference-audio/song.wav'), wav);
  const sequences = Array.from({ length: 40 }, (_, index) => ({ sequence: index + 1, name: `素材 ${index + 1}`, cues: Array.from({ length: index % 3 ? 1 : 6 }, (_, step) => ({ index: step, number: `${step + 1}.000`, name: `素材 ${index + 1} 第 ${step + 1} 步` })) }));
  const template = (sequence: number): LightingTrack => ({ id: `track-${sequence}`, name: '灯光', kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false, channel: 1, controller: 7, portProfileId: '', noteNames: {}, clips: [], cueStamp: { mode: 'fixed', sequence, cue: '1.000', executor: '' } });
  const library = createLightingUserLibrary();
  library.entries = sequences.slice(0, 8).map(value => ({ id: `entry-${value.sequence}`, name: value.name, originalName: value.name, revision: 1, kind: 'single', categoryIds: ['front:bright:3:front'], favorite: false, source: { endpoint: '192.0.2.1:30000', show: 'test', verified: true }, track: template(value.sequence) }));
  const lighting = createLightingDocument();
  lighting.tracks = [{ ...template(1), clips: [{ id: 'clip', name: '编排', start: 0, duration: 30_000, timeLock: 'time', muted: false, events: Array.from({ length: 12 }, (_, index) => ({ id: `cue-${index}`, kind: 'ma2' as const, at: 1000 + index * 2400, sequence: (index % 8) + 1, executor: '', cue: '1.000', action: 'goto' as const, label: `点 ${index + 1}` })) }] }];
  const project = parseLinkProject({ ...createEmptyLinkProject('灯光工作台尺寸验收'), schemaVersion: 2, ma2MaterialLibrary: { version: 2, source: '192.0.2.1:30000', userLibrary: library, library: { directory: { show: 'test', version: '3.7.0.5', generation: 'test', entries: [] }, readAt: new Date().toISOString(), fixtureUsage: [], errors: [], sequences } },
    rundown: [{ id: 'song', title: '尺寸验收', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting, referenceAudio: { assetId: 'audio', relativePath: 'assets/reference-audio/song.wav', durationMs: 30_000, sha256: createHash('sha256').update(wav).digest('hex') } }] });
  const file = info.outputPath('layout.tblink'); await writeFile(file, JSON.stringify(project));
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')], env: { ...process.env, TBLINK_LOCAL_TEST_ACCESS: '1' } });
  const page = await app.firstWindow(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
    await expect(page.locator('.audio-segment-canvas[data-ready="true"]').first()).toBeVisible();
    const menu = page.getByRole('navigation', { name: '灯光素材主菜单' });
    const timeline = page.locator('.lighting-workbench .reference-timeline');
    for (const [width, height] of [[1280, 720], [1180, 720]] as const) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height), { width, height });
      await menu.getByRole('button', { name: '控台素材', exact: true }).click();
      for (const view of ['单步', '全部', '控台页面'] as const) {
        await page.getByRole('region', { name: 'MA2 序列预览' }).getByRole('button', { name: view, exact: true }).click();
        await expect.poll(() => sidewaysScroll(page), { message: `${width}×${height} ${view}` }).toEqual([]);
      }
      await menu.getByRole('button', { name: '面光', exact: true }).click();
      await expect.poll(() => sidewaysScroll(page), { message: `${width}×${height} 面光` }).toEqual([]);
      // The timeline keeps its toolbar, ruler, Cue rows and some waveform.
      expect((await timeline.boundingBox())!.height).toBeGreaterThanOrEqual(240);
      // The console reading buttons left the sidebar, so its menu fits above the sync controls.
      await expect(page.locator('.app-sidebar').getByText('更多', { exact: true })).toBeInViewport({ ratio: 1 });
      await expect(page.locator('.app-sidebar').getByRole('button', { name: '刷新素材目录' })).toHaveCount(0);
      await page.screenshot({ path: info.outputPath(`workbench-${width}x${height}.png`) });
    }
    // A notice opens above the timeline, never over its Cues.
    await page.getByRole('region', { name: '灯光同步操作' }).getByRole('button', { name: '保存', exact: true }).click();
    const notices = page.getByRole('region', { name: '通知' });
    await expect(notices.getByText('本地已保存并创建存档')).toBeVisible();
    const notice = (await notices.boundingBox())!;
    expect(notice.y + notice.height).toBeLessThanOrEqual((await timeline.boundingBox())!.y);
    await page.screenshot({ path: info.outputPath('notice.png') });
    expect(errors).toEqual([]);
  } finally { await closeDiscarding(app); }
});
