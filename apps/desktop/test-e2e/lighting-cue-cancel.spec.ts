import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { createEmptyLinkProject, createLightingDocument, lightingTrackSchema, parseLinkProject } from '@tb/schema';

test('波形 Cue 拖动可用 Escape 或失焦取消，正常拖动和撤销保持有效', async ({}, info) => {
  const wav = Buffer.alloc(44 + 8000 * 4, 128);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await writeFile(info.outputPath('audio.wav'), wav);
  const lighting = createLightingDocument();
  lighting.tracks = [lightingTrackSchema.parse({ id: 'track', name: '灯光', kind: 'ma2', color: '#68c9ed', group: 'effect-canvas', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: 'clip', name: '灯光', start: 0, duration: 4000, timeLock: 'time', muted: false,
    events: [{ id: 'point', kind: 'ma2', action: 'goto', at: 1000, cue: '1.000', sequence: 1, executor: '1.101', label: '第一步' }] }] })];
  const project = parseLinkProject({ ...createEmptyLinkProject('取消卡点移动'), schemaVersion: 2, rundown: [{ id: 'song', title: '歌曲', cues: [], lighting,
    referenceAudio: { assetId: 'audio', relativePath: 'audio.wav', sha256: createHash('sha256').update(wav).digest('hex'), durationMs: 4000 } }] });
  const file = info.outputPath('cue.tblink'); await writeFile(file, JSON.stringify(project));
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')], env: { ...process.env, TBLINK_LOCAL_TEST_ACCESS: '1' } });
  const page = await app.firstWindow();
  const saved = async () => parseLinkProject(JSON.parse(await readFile(file, 'utf8'))).rundown[0]!.lighting!;
  try {
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('button', { name: '灯光工作台', exact: true }).click();
    await page.getByRole('button', { name: '关闭吸附', exact: true }).click();
    const point = page.getByRole('button', { name: '音频 Cue 1', exact: true });
    const drag = async () => {
      const box = (await point.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 45, box.y + box.height / 2, { steps: 6 });
    };
    for (const action of ['escape', 'blur'] as const) {
      await drag();
      if (action === 'escape') await page.keyboard.press('Escape');
      else await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      await page.mouse.up(); await page.keyboard.press('Control+s');
      await expect.poll(async () => (await saved()).tracks).toEqual(lighting.tracks);
      await expect(point).toHaveAttribute('title', /Cue 1 · .*01:00/);
    }
    await drag(); await page.mouse.up();
    await expect.poll(async () => (await saved()).tracks[0]!.clips[0]!.events[0]!.at).toBeGreaterThan(1000);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect.poll(async () => (await saved()).tracks).toEqual(lighting.tracks);
    await page.reload(); await page.getByRole('button', { name: '灯光工作台', exact: true }).click();
    await expect(point).toBeVisible();
    expect((await saved()).tracks).toEqual(lighting.tracks);
  } finally { if (!page.isClosed()) await page.evaluate(() => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null })); await app.close(); }
});
