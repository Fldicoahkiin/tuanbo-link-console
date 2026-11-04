import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createEmptyLinkProject, createLightingDocument, lightingTrackSchema, parseLinkProject } from '@tb/schema';
import { answerSaveQuestions, closeDiscarding } from './save-questions';

// 2026-11-01: 埋步 only ran in the removed direct and network playback, and the console timeline cannot hold it.
// A Cue that still has one says so and offers to take it off; there is no way to add a new one.
test('旧工程里带埋步的 Cue：提示写不进控台，一键去掉并保存，不能再新加埋步', async ({}, info) => {
  const wav = Buffer.alloc(44 + 48000 * 12 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await mkdir(info.outputPath('assets/reference-audio'), { recursive: true }); await writeFile(info.outputPath('assets/reference-audio/dance.wav'), wav);
  const track = lightingTrackSchema.parse({ id: 'track', name: '灯光', kind: 'ma2', color: '#68c9ed', group: 'effect-canvas', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, cueStamp: { mode: 'fixed', sequence: 168, cue: '2', executor: '' }, clips: [{ id: 'clip', name: '副歌', start: 0, duration: 12000, timeLock: 'time', muted: false, events: [{ id: 'cue', at: 5000, kind: 'ma2', action: 'goto', sequence: 168, cue: '2', executor: '', label: '副歌蓝光', preparation: { cue: '1', leadMs: 2000 } }, { id: 'plain', at: 9000, kind: 'ma2', action: 'goto', sequence: 168, cue: '3', executor: '', label: '尾声' }] }] });
  const project = parseLinkProject({ ...createEmptyLinkProject('埋步验收'), schemaVersion: 2, playbackSource: 'p1', rundown: [{ id: 'dance', title: '埋步验收', cues: [], referenceAudio: { assetId: 'audio', relativePath: 'assets/reference-audio/dance.wav', sha256: createHash('sha256').update(wav).digest('hex'), durationMs: 12000 }, lighting: { ...createLightingDocument(), tracks: [track] } }] });
  const file = info.outputPath('preparation.tblink'); await writeFile(file, JSON.stringify(project));
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')], env: { ...process.env, TBLINK_LOCAL_TEST_ACCESS: '1' } });
  try {
    const page = await app.firstWindow();
    await answerSaveQuestions(app);
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1400, 900); });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
    if (!await page.getByLabel('选中 Cue 实时播放', { exact: true }).isVisible()) await page.locator('.lighting-playback-settings summary').click();
    await page.getByLabel('选中 Cue 实时播放', { exact: true }).uncheck();
    await expect(page.locator('.waveform-cue-preparation')).toHaveCount(1);
    // A Cue without one shows nothing about 埋步 and has no way to add it.
    await page.getByRole('button', { name: '音频 Cue 2', exact: true }).click();
    await expect(page.getByRole('button', { name: '去掉埋步', exact: true })).toHaveCount(0);
    await expect(page.locator('.cue-composer').getByText('埋步', { exact: false })).toHaveCount(0);
    await page.getByRole('button', { name: '音频 Cue 1', exact: true }).click();
    await expect(page.getByText('这个 Cue 还带着以前的埋步', { exact: false })).toBeVisible();
    await page.screenshot({ path: info.outputPath('preparation-legacy.png') });
    await page.getByRole('button', { name: '去掉埋步', exact: true }).click();
    await expect(page.getByRole('button', { name: '去掉埋步', exact: true })).toHaveCount(0);
    await expect(page.locator('.waveform-cue-preparation')).toHaveCount(0);
    await page.keyboard.press('Control+s');
    const savedCue = async () => parseLinkProject(JSON.parse(await readFile(file, 'utf8'))).rundown[0]?.lighting?.tracks.flatMap(value => value.clips.flatMap(clip => clip.events)).find(event => event.kind === 'ma2' && event.cue === '2');
    await expect.poll(async () => { const cue = await savedCue(); return cue?.kind === 'ma2' ? cue.preparation ?? null : 'missing'; }).toBe(null);
    expect(errors).toEqual([]);
  } finally { await closeDiscarding(app); }
});
