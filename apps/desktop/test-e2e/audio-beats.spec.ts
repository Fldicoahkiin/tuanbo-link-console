import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { songBeats, songBeatsAtDensity } from '@tb/core/link';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject, type RundownItem } from '@tb/schema';
import { answerOlderFormatQuestion, saveProject } from './save-questions';

/** The beats the editor shows at 每两拍, on song time. */
function shownBeats(item: RundownItem): number[] {
  const beats = songBeats(item);
  return beats.state === 'ready' ? songBeatsAtDensity(beats.beats, 'standard').map(beat => beat.atMs) : [];
}

test('真实音频检测三级节拍、标记存到歌上、第一次保存先问并留旧版本能打开的备份、灯光放置与拖动吸附', async ({}, testInfo) => {
  const directory = testInfo.outputPath('project'); await mkdir(directory, { recursive: true });
  const audio = drumAudio(); const sha256 = createHash('sha256').update(audio).digest('hex');
  await mkdir(join(directory, 'assets', 'reference-audio'), { recursive: true });
  await writeFile(join(directory, 'assets', 'reference-audio', 'drums.wav'), audio);
  const project = createEmptyLinkProject('节拍辅助灯光验收'); project.schemaVersion = 2;
  const lighting = createLightingDocument();
  lighting.tracks.push({ id: 'track', name: '灯光', kind: 'ma2', color: '#aa88ff', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: 'clip', name: '灯光编排', start: 0, duration: 6000, timeLock: 'time', muted: false, events: [] }] });
  project.rundown.push({ id: 'song', title: '鼓点测试', enabled: true, notes: '', referenceAudio: { assetId: 'audio', relativePath: 'assets/reference-audio/drums.wav', sha256, durationMs: 6000 }, cues: [], referenceMediaClips: [], visualLayers: [], lighting });
  const path = join(directory, 'beat.tblink'); await writeFile(path, JSON.stringify(project));
  const application = await electron.launch({ args: [`--user-data-dir=${testInfo.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')] });
  const page = await application.firstWindow();
  const asked = await answerOlderFormatQuestion(application);
  try {
    await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, path);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('button', { name: '编辑器', exact: true }).click();
    await page.locator('.audio-track-edit').first().click();
    await page.getByRole('button', { name: '检测节拍', exact: true }).click();
    await expect(page.getByRole('button', { name: '应用标记', exact: true })).toBeEnabled();
    const counts: number[] = [];
    for (const name of ['每四拍', '每两拍', '每拍']) {
      await page.getByRole('button', { name, exact: true }).click();
      counts.push(await page.locator('.audio-beat-marker').count());
    }
    expect(counts[0]).toBeGreaterThan(0); expect(counts[1]).toBeGreaterThanOrEqual(counts[0]!); expect(counts[2]).toBeGreaterThanOrEqual(counts[1]!);
    await page.getByRole('button', { name: '每两拍', exact: true }).click();
    await page.getByRole('button', { name: '应用标记', exact: true }).click();
    const load = async () => parseLinkProject(JSON.parse(await readFile(path, 'utf8')));
    await expect(page.locator('.audio-beat-marker')).toHaveCount(counts[1]!);
    const original = await readFile(path, 'utf8');
    await saveProject(page);
    // The beats belong to the song now: the file is the newer format, asked once, the old file kept beside it.
    expect(await asked()).toBe(1);
    await expect.poll(async () => (await load()).rundown[0]!.music?.structure.beats.length ?? 0).toBe(counts[2]);
    expect(await readFile(join(directory, 'beat（旧版本可打开的备份）.tblink'), 'utf8')).toBe(original);
    const song = (await load()).rundown[0]!;
    expect(song.music).toMatchObject({ method: 'ibt', sourceSha256: sha256, sourceDurationMs: 6000 });
    expect(song.referenceAudio).toEqual({ assetId: 'audio', relativePath: 'assets/reference-audio/drums.wav', sha256, durationMs: 6000 });
    expect((await load()).schemaVersion).toBe(3);
    const saved = shownBeats(song);
    expect(saved).toHaveLength(counts[1]!);
    const markers = await page.locator('.audio-beat-marker').evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().x));
    const clip = page.locator('.lighting-clip').first(); const bounds = await clip.boundingBox();
    if (!bounds || markers.length < 2) throw new Error('测试节拍点或灯光轨道缺失');
    await page.mouse.dblclick(markers[0]! + 3, bounds.y + 28);
    await expect(page.locator('.lighting-timeline-point')).toHaveCount(1);
    await saveProject(page);
    await expect.poll(async () => (await load()).rundown[0]!.lighting!.tracks[0]!.clips[0]!.events[0]?.at ?? -1).toBe(saved[0]);
    const cue = await page.locator('.lighting-timeline-point').boundingBox(); if (!cue) throw new Error('灯光点未显示');
    await page.mouse.move(cue.x + 3, cue.y + 8); await page.mouse.down();
    await page.mouse.move(cue.x + 3 + markers[1]! - markers[0]! + 2, cue.y + 8, { steps: 6 }); await page.mouse.up();
    await saveProject(page);
    await expect.poll(async () => (await load()).rundown[0]!.lighting!.tracks[0]!.clips[0]!.events[0]?.at ?? -1).toBe(saved[1]);
    await page.getByRole('button', { name: '关闭吸附', exact: true }).click();
    const currentBounds = await clip.boundingBox(); if (!currentBounds) throw new Error('灯光轨道未显示');
    await page.mouse.dblclick(markers[0]! + 8, currentBounds.y + currentBounds.height - 6);
    await saveProject(page);
    await expect.poll(async () => (await load()).rundown[0]!.lighting!.tracks[0]!.clips[0]!.events.length).toBe(2);
    expect((await load()).rundown[0]!.lighting!.tracks[0]!.clips[0]!.events.at(-1)!.at).not.toBe(saved[0]);
    await page.screenshot({ path: testInfo.outputPath('audio-beat-lighting.png') });
    await page.reload(); await page.getByRole('button', { name: '编辑器', exact: true }).click();
    await expect(page.locator('.audio-beat-marker')).toHaveCount(counts[1]!);
    // Once the file is the newer format, saving asks nothing more.
    expect(await asked()).toBe(1);
  } finally { await page.evaluate(() => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null })); await application.close(); }
});

function drumAudio(): Buffer {
  const rate = 22050; const samples = rate * 6; const data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) { const t = i / rate; const beat = Math.floor(t / 0.5); const value = Math.sin(i * Math.PI * 2 * 100 / rate) * (beat % 2 ? 0.35 : 0.9) * Math.exp(-(t - beat * 0.5) * 40); data.writeInt16LE(Math.round(value * 30000), 44 + i * 2); }
  return data;
}
