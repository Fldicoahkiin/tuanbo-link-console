import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { musicStructureSegments } from '@tb/core/link';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject, type MusicStructure } from '@tb/schema';
import { answerOlderFormatQuestion, closeDiscarding, savedValue } from './save-questions';

async function openProject(app: ElectronApplication, file: string, first: boolean) {
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, file);
  if (!first) { await page.getByRole('button', { name: '节目单', exact: true }).click(); await page.getByLabel('工程菜单', { exact: true }).click(); }
  await page.getByRole(first ? 'button' : 'menuitem', { name: '打开工程', exact: true }).click();
  await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
  // The workbench timeline appears once the project has loaded; a Ctrl+S before that has no document to save.
  await expect(page.getByRole('button', { name: '音乐分析', exact: true })).toBeVisible();
  return page;
}

/** The BPM heading shows the segment under the playhead, estimated from that segment's beats; the playhead is at 0 here. */
function headingAtStart(analysis: MusicStructure): string {
  const segment = musicStructureSegments(analysis)[0]!;
  return segment.bpm === null ? '无可测 BPM' : `约 ${segment.bpm}${segment.endBpm === null ? '' : ` → ${segment.endBpm}`} BPM`;
}

for (const device of ['cuda', 'cpu'] as const) test(`自动识别 ${device}：静音识别并保存、清除、重新分析`, async ({}, info) => {
  const wav = Buffer.alloc(44 + 48000 * 3 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await mkdir(info.outputPath('assets/reference-audio'), { recursive: true });
  await writeFile(info.outputPath('assets/reference-audio/静音.wav'), wav);
  const lighting = createLightingDocument();
  const project = parseLinkProject({ ...createEmptyLinkProject('静音自动分析'), schemaVersion: 2, rundown: [{ id: 'song', title: '静音', lighting, referenceAudio: { assetId: 'audio', relativePath: 'assets/reference-audio/静音.wav', durationMs: 3000, sha256: createHash('sha256').update(wav).digest('hex') } }] });
  const file = info.outputPath('silence.tblink'); await writeFile(file, JSON.stringify(project));
  const song = async () => parseLinkProject(JSON.parse(await readFile(file, 'utf8'))).rundown[0]!;
  const saved = async () => (await song()).lighting!;
  // The recognized music belongs to the song, shared with the editor, not to the lighting document.
  const music = async () => (await song()).music?.structure;
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')], env: { ...process.env, TBLINK_LOCAL_TEST_ACCESS: '1' } });
  try {
    const asked = await answerOlderFormatQuestion(app);
    const page = await openProject(app, file, true);
    const savedAnalysis = () => savedValue(page, music);
    // No Analyze/Apply click: opening the workbench starts analysis; its result is a document edit written by the next save.
    await expect.poll(async () => (await savedAnalysis())?.state, { timeout: 45000 }).toBe('ready');
    expect(await music()).toMatchObject({ bpm: null, beats: [], segments: [] });
    expect(await asked()).toBe(1);
    expect((await saved()).musicAnalysis).toBeUndefined();
    await page.getByRole('button', { name: '音乐分析', exact: true }).click();
    const panel = page.locator('.music-analysis-panel');
    await expect(panel).toContainText('未识别到稳定节拍');
    await panel.locator('summary').click();
    await panel.getByLabel('音乐分析计算设备').selectOption(device);
    await panel.getByRole('button', { name: '重新分析', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.tbLink.getAutomaticMusicStatus())).jobs.at(-1)?.state, { timeout: 30000 }).toBe('completed');
    expect((await page.evaluate(() => window.tbLink.getAutomaticMusicStatus())).jobs.at(-1)?.device).toBe(device);
    await panel.getByRole('button', { name: '清除标记', exact: true }).click();
    await expect.poll(async () => (await savedAnalysis())?.state).toBe('cleared');
    await openProject(app, file, false);
    expect((await page.evaluate(() => window.tbLink.getAutomaticMusicStatus())).jobs).toHaveLength(2);
    expect((await saved()).tracks).toEqual(lighting.tracks);
  } finally { await closeDiscarding(app); }
});

test('真实短歌：自动识别分段、旧编号隐藏、纠错、保存恢复和重分析', async ({}, info) => {
  test.setTimeout(180000);
  const audio = process.env['TBLINK_ANALYSIS_ACCEPTANCE_AUDIO'], durationMs = Number(process.env['TBLINK_ANALYSIS_ACCEPTANCE_DURATION_MS']);
  test.skip(!audio || !Number.isFinite(durationMs) || durationMs <= 0, '指定真实测试音乐');
  await mkdir(info.outputPath('assets/reference-audio'), { recursive: true });
  await copyFile(audio!, info.outputPath('assets/reference-audio/真实音乐.wav'));
  const bytes = await readFile(info.outputPath('assets/reference-audio/真实音乐.wav')), hash = createHash('sha256').update(bytes).digest('hex');
  const lighting = createLightingDocument(); lighting.version = 2;
  lighting.markers = Array.from({ length: 65 }, (_, index) => ({ id: `analysis:${hash}:beat:${index}`, name: `节拍 ${index + 1}`, startMs: index * durationMs / 65, endMs: null, kind: 'custom', color: '#68c9ed', notes: '旧版已应用结果' }));
  const project = parseLinkProject({ ...createEmptyLinkProject('自动音乐结构验收'), schemaVersion: 2, rundown: [{ id: 'song', title: '387 · 真实短歌', lighting, referenceAudio: { assetId: 'audio', relativePath: 'assets/reference-audio/真实音乐.wav', durationMs, sha256: hash } }] });
  const file = info.outputPath('actual.tblink'); await writeFile(file, JSON.stringify(project));
  const song = async () => parseLinkProject(JSON.parse(await readFile(file, 'utf8'))).rundown[0]!;
  const saved = async () => (await song()).lighting!;
  // The recognized music belongs to the song, shared with the editor, not to the lighting document.
  const music = async () => (await song()).music?.structure;
  const launch = () => electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')], env: { ...process.env, TBLINK_LOCAL_TEST_ACCESS: '1' } });
  let app = await launch(); const errors: string[] = [];
  const olderFile = await readFile(file, 'utf8');
  try {
    let asked = await answerOlderFormatQuestion(app);
    let page = await openProject(app, file, true); page.on('pageerror', error => errors.push(error.message));
    const savedAnalysis = () => savedValue(page, music);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: '适合节目时长', exact: true }).click();
    await expect.poll(async () => (await savedAnalysis())?.state, { timeout: 90000 }).toBe('ready');
    const original = (await music())!;
    expect(original.bpm).toBeGreaterThan(60); expect(original.bpm).toBeLessThan(240);
    expect(original.beats.length).toBeGreaterThan(30); expect(original.segments.length).toBeGreaterThanOrEqual(2);
    await expect(page.locator('.analysis-point-marker')).toHaveCount(0);
    await expect(page.locator('.music-tempo-segment')).toHaveCount(original.segments.length);
    await expect(page.locator('.music-detected-beat').first()).toBeVisible();
    expect((await saved()).markers).toEqual(lighting.markers); expect((await saved()).tracks).toEqual(lighting.tracks);
    // The first save into the newer format asked once and kept the file 0.5.8 opens beside it.
    expect(await asked()).toBe(1);
    expect(await readFile(info.outputPath('actual（旧版本可打开的备份）.tblink'), 'utf8')).toBe(olderFile);
    await page.getByRole('button', { name: '音乐分析', exact: true }).click();
    let panel = page.locator('.music-analysis-panel');
    await expect(panel.locator('.music-bpm')).toHaveText(headingAtStart(original));
    await expect(panel.getByLabel('节拍分段间隔')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: /应用选中|保存标记/ })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('automatic-structure.png') });
    await page.locator('.music-tempo-segment').first().click();
    await panel.getByLabel('段落名称').fill('核对段落');
    await panel.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect.poll(async () => (await savedAnalysis())?.segments[0]?.name).toBe('核对段落');
    await page.locator('.music-detected-beat').nth(4).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '删除拍点', exact: true }).click();
    await expect.poll(async () => (await savedAnalysis())?.beats.length).toBe(original.beats.length - 1);
    await page.locator('.music-tempo-segment').last().click({ button: 'right' });
    await page.getByRole('menu', { name: '音乐段落菜单' }).getByRole('menuitem', { name: '删除此段', exact: true }).click();
    await expect.poll(async () => (await savedAnalysis())?.segments.length).toBe(original.segments.length - 1);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect.poll(async () => (await savedAnalysis())?.segments.length).toBe(original.segments.length);
    await panel.getByRole('button', { name: '重新分析', exact: true }).click();
    await expect.poll(async () => (await savedAnalysis())?.taskId, { timeout: 60000 }).not.toBe(original.taskId);
    expect((await music())?.segments[0]?.name).toBe('核对段落');
    expect((await music())?.beats.length).toBe(original.beats.length - 1);
    await page.setViewportSize({ width: 1060, height: 720 });
    await expect(panel.getByRole('button', { name: '清除标记', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('automatic-structure-compact.png') });
    await closeDiscarding(app);
    // Older short-section results stored null BPM. Resolve from their saved beat
    // evidence on reopening, without rerunning models or rewriting user edits.
    const oldProject = parseLinkProject(JSON.parse(await readFile(file, 'utf8')));
    const oldAnalysis = oldProject.rundown[0]!.music!.structure;
    const reopenedHeading = headingAtStart(oldAnalysis);
    oldAnalysis.segments.forEach(segment => { segment.bpm = null; segment.endBpm = null; });
    await writeFile(file, JSON.stringify(oldProject));
    app = await launch(); asked = await answerOlderFormatQuestion(app); page = await openProject(app, file, true);
    await expect(page.locator('.music-analysis-button .music-bpm')).toHaveText(reopenedHeading);
    expect((await page.evaluate(() => window.tbLink.getAutomaticMusicStatus())).jobs).toHaveLength(0);
    await page.getByRole('button', { name: '音乐分析', exact: true }).click(); panel = page.locator('.music-analysis-panel');
    await expect(panel.getByText('速度待核对', { exact: true })).toHaveCount(0);
    await expect(panel.locator('.music-recognized-sections strong')).toHaveCount(oldAnalysis.segments.length);
    await panel.getByRole('button', { name: '清除标记', exact: true }).click();
    await expect.poll(async () => (await savedAnalysis())?.state).toBe('cleared');
    await expect(page.locator('.music-tempo-segment')).toHaveCount(0);
    await expect(page.locator('.music-detected-beat')).toHaveCount(0);
    await expect(panel.locator('.music-bpm')).toHaveText('标记已清除');
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect.poll(async () => (await savedAnalysis())?.state).toBe('ready');
    expect(await asked()).toBe(0);
    await writeFile(info.outputPath('report.json'), JSON.stringify({ bpm: original.bpm, beatsPerBar: original.beatsPerBar, beats: original.beats.length, segments: original.segments, errors }, null, 2));
    expect(errors).toEqual([]);
  } finally { await closeDiscarding(app); }
});
