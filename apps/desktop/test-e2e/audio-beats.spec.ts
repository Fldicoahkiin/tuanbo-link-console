import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { acceptMusicStructure, songBeats, songBeatsAtDensity } from '@tb/core/link';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject, type AutomaticMusicCandidates, type RundownItem } from '@tb/schema';
import { saveProject } from './save-questions';

/** The beats the editor shows at 每两拍, on song time. */
function shownBeats(item: RundownItem): number[] {
  const beats = songBeats(item);
  return beats.state === 'ready' ? songBeatsAtDensity(beats.beats, 'standard').map(beat => beat.atMs) : [];
}

/** Whether every group of the timeline toolbar sits on its first row. */
async function toolbarRows(page: Page): Promise<number> {
  return page.locator('.timeline-workbench .timeline-toolbar').evaluate(toolbar => new Set([...toolbar.children].filter(child => child instanceof HTMLElement && child.offsetWidth > 0).map(child => Math.round((child as HTMLElement).offsetTop / 8))).size);
}

test('灯光工作台识别过的节拍，编辑器直接显示、按间隔切换、点击定位；工具栏一行；灯光放置与拖动吸附', async ({}, testInfo) => {
  const directory = testInfo.outputPath('project'); await mkdir(directory, { recursive: true });
  const audio = drumAudio(); const sha256 = createHash('sha256').update(audio).digest('hex');
  await mkdir(join(directory, 'assets', 'reference-audio'), { recursive: true });
  await writeFile(join(directory, 'assets', 'reference-audio', 'drums.wav'), audio);
  const lighting = createLightingDocument();
  lighting.tracks.push({ id: 'track', name: '灯光', kind: 'ma2', color: '#aa88ff', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: 'clip', name: '灯光编排', start: 0, duration: 6000, timeLock: 'time', muted: false, events: [] }] });
  const source = { assetId: 'audio', relativePath: 'assets/reference-audio/drums.wav', sha256, durationMs: 6000 };
  // The song as the lighting workbench left it: recognised once (beats every 500 ms, a bar every 2 s).
  const candidates: AutomaticMusicCandidates = { sourceSha256: sha256, durationMs: 6000, bpm: 120, items: [
    ...Array.from({ length: 12 }, (_, i) => ({ id: `beat:${i}`, kind: 'beat' as const, name: '拍点', startMs: i * 500, endMs: null })),
    ...Array.from({ length: 3 }, (_, i) => ({ id: `down:${i}`, kind: 'downbeat' as const, name: '强拍', startMs: i * 2000, endMs: null }))
  ] };
  const item = { id: 'song', title: '鼓点测试', referenceAudio: source, lighting };
  const project = parseLinkProject({ ...createEmptyLinkProject('节拍辅助灯光验收'), schemaVersion: 3, rundown: [{ ...item, music: acceptMusicStructure({}, source, candidates, 'workbench') }] });
  const path = join(directory, 'beat.tblink'); await writeFile(path, JSON.stringify(project));
  const application = await electron.launch({ args: [`--user-data-dir=${testInfo.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')], env: { ...process.env, TBLINK_LOCAL_TEST_ACCESS: '1' } });
  const page = await application.firstWindow();
  try {
    await application.evaluate(({ dialog, ipcMain }, path) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] });
      // A start of the recognition would show here: the song has beats, so neither page starts one.
      ipcMain.removeHandler('link:automatic-music-start');
      Reflect.set(globalThis, '__musicStarts', 0);
      ipcMain.handle('link:automatic-music-start', () => { Reflect.set(globalThis, '__musicStarts', Number(Reflect.get(globalThis, '__musicStarts')) + 1); throw new Error('这首歌已经有节拍，不应该再识别'); });
    }, path);
    const starts = () => application.evaluate(() => Number(Reflect.get(globalThis, '__musicStarts')));
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('button', { name: '编辑器', exact: true }).click();
    const load = async () => parseLinkProject(JSON.parse(await readFile(path, 'utf8')));
    const song = (await load()).rundown[0]!;
    // The toolbar shows the song's BPM, and it stays one row at 1280×720.
    await expect(page.getByRole('button', { name: '音乐分析', exact: true })).toContainText('BPM');
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 720));
    await expect.poll(() => toolbarRows(page)).toBe(1);
    await page.screenshot({ path: testInfo.outputPath('editor-1280x720.png') });
    await page.locator('.audio-track-edit').first().click();
    await expect(page.getByRole('button', { name: '检测节拍', exact: true })).toHaveCount(0);
    const counts: number[] = [];
    for (const name of ['每小节', '每两拍', '每拍']) {
      await page.getByRole('button', { name, exact: true }).click();
      counts.push(await page.locator('.audio-beat-marker').count());
    }
    expect(counts[0]).toBeGreaterThan(0); expect(counts[1]).toBeGreaterThanOrEqual(counts[0]!); expect(counts[2]).toBeGreaterThanOrEqual(counts[1]!);
    await page.getByRole('button', { name: '每两拍', exact: true }).click();
    const saved = shownBeats(song);
    await expect(page.locator('.audio-beat-marker')).toHaveCount(saved.length);
    // The inspector's 音乐识别 opens the same panel as the toolbar button, with the song's sections.
    await page.getByRole('button', { name: '音乐识别', exact: true }).click();
    await expect(page.locator('.cue-inspector .music-analysis-panel')).toBeVisible();
    await page.getByRole('button', { name: '关闭节拍分段', exact: true }).click();
    const markers = await page.locator('.audio-beat-marker').evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().x));
    const clip = page.locator('.lighting-clip').first(); const bounds = await clip.boundingBox();
    if (!bounds || markers.length < 3) throw new Error('测试节拍点或灯光轨道缺失');
    await page.mouse.dblclick(markers[1]! + 3, bounds.y + 28);
    await expect(page.locator('.lighting-timeline-point')).toHaveCount(1);
    await saveProject(page);
    await expect.poll(async () => (await load()).rundown[0]!.lighting!.tracks[0]!.clips[0]!.events[0]?.at ?? -1).toBe(saved[1]);
    const cue = await page.locator('.lighting-timeline-point').boundingBox(); if (!cue) throw new Error('灯光点未显示');
    await page.mouse.move(cue.x + 3, cue.y + 8); await page.mouse.down();
    await page.mouse.move(cue.x + 3 + markers[2]! - markers[1]! + 2, cue.y + 8, { steps: 6 }); await page.mouse.up();
    await saveProject(page);
    await expect.poll(async () => (await load()).rundown[0]!.lighting!.tracks[0]!.clips[0]!.events[0]?.at ?? -1).toBe(saved[2]);
    await page.getByRole('button', { name: '关闭吸附', exact: true }).click();
    const currentBounds = await clip.boundingBox(); if (!currentBounds) throw new Error('灯光轨道未显示');
    await page.mouse.dblclick(markers[1]! + 8, currentBounds.y + currentBounds.height - 6);
    await saveProject(page);
    await expect.poll(async () => (await load()).rundown[0]!.lighting!.tracks[0]!.clips[0]!.events.length).toBe(2);
    expect((await load()).rundown[0]!.lighting!.tracks[0]!.clips[0]!.events.at(-1)!.at).not.toBe(saved[1]);
    // The beats were never recognised again and are the same on the song as before.
    expect((await load()).rundown[0]!.music).toEqual(song.music);
    expect(await starts()).toBe(0);
    await page.screenshot({ path: testInfo.outputPath('audio-beat-lighting.png') });
    await page.reload(); await page.getByRole('button', { name: '编辑器', exact: true }).click();
    await expect(page.locator('.audio-beat-marker')).toHaveCount(saved.length);
  } finally { await page.evaluate(() => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null })); await application.close(); }
});

function drumAudio(): Buffer {
  const rate = 22050; const samples = rate * 6; const data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) { const t = i / rate; const beat = Math.floor(t / 0.5); const value = Math.sin(i * Math.PI * 2 * 100 / rate) * (beat % 2 ? 0.35 : 0.9) * Math.exp(-(t - beat * 0.5) * 40); data.writeInt16LE(Math.round(value * 30000), 44 + i * 2); }
  return data;
}
