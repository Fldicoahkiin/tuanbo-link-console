import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';
import { createEmptyLinkProject, createLightingDocument, type Ma2TimecodePreview } from '@tb/schema';
import { importMa2ProgramsCommand } from '@tb/core/link';

function preview(target: number, cue: string, label: string): Ma2TimecodePreview {
  const document = createLightingDocument();
  const trackId = `track-${target}`;
  const clipId = `clip-${target}`;
  const eventId = `event-${target}`;
  document.tracks.push({
    id: trackId, kind: 'ma2', name: `控台轨道 ${target}`, color: '#ba8fff', group: '', muted: false,
    solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {},
    clips: [{ id: clipId, name: 'MA2', start: 0, duration: 3000, timeLock: 'time', muted: false,
      events: [{ id: eventId, kind: 'ma2', at: 1500, sequence: target, cue, executor: '1.101', label, action: 'goto' }] }]
  });
  return { target, name: label, readAt: '2026-09-23T00:00:00.000Z', document, sourceXml: '<MA/>',
    mappings: [{ eventId, trackId, clipId, path: `Timecode:${target}/Track:0/SubTrack:0/Event:1`, sequence: target, cueIndex: 1, executor: '1.101' }],
    warnings: [], unconverted: [] };
}

test('两首歌分别导入控台时间线后，编辑器仅显示当前歌曲的 Cue', async ({}, info) => {
  const project = createEmptyLinkProject('歌曲 Cue 对应验收');
  project.rundown = [
    { id: 'song-a', title: '歌曲甲', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [] },
    { id: 'song-b', title: '歌曲乙', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [] }
  ];
  const imported = importMa2ProgramsCommand([
    { itemId: 'song-a', preview: preview(101, '1.250', '甲的开场 Cue') },
    { itemId: 'song-b', preview: preview(102, '2.500', '乙的副歌 Cue') }
  ]).execute(project);
  const path = info.outputPath('song-cues.tblink');
  await writeFile(path, JSON.stringify(imported));
  const executable = process.env.TBLINK_MA2_PACKAGED_EXE;
  const application = await electron.launch({ ...(executable ? { executablePath: executable } : {}),
    args: [`--user-data-dir=${info.outputPath('profile')}`, ...executable ? [] : [join(process.cwd(), 'out/main/index.cjs')]] });
  const page = await application.firstWindow();
  if (process.env.TBLINK_MA2_TEST_HIDDEN) await application.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.hide();
  });
  try {
    await application.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [file] });
    }, path);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    const navigation = page.getByRole('navigation', { name: '主要工作区' });
    await navigation.getByRole('button', { name: '编辑器', exact: true }).click();
    await expect(page.getByRole('button', { name: '修改节目名称：歌曲甲' })).toBeVisible();
    await expect(page.locator('.lighting-timeline-point')).toHaveCount(1);
    await expect(page.locator('.lighting-timeline-point')).toHaveAttribute('title', /甲的开场 Cue · Cue 1\.250/);
    await navigation.getByRole('button', { name: '灯光工作台', exact: true }).click();
    await expect(page.getByRole('region', { name: '灯光节目列表' })).toHaveCount(0);
    await navigation.getByRole('button', { name: '节目单', exact: true }).click();
    await page.locator('.rundown-row').filter({ hasText: '歌曲乙' }).click();
    await navigation.getByRole('button', { name: '编辑器', exact: true }).click();
    await expect(page.getByRole('button', { name: '修改节目名称：歌曲乙' })).toBeVisible();
    await expect(page.locator('.lighting-timeline-point')).toHaveCount(1);
    await expect(page.locator('.lighting-timeline-point')).toHaveAttribute('title', /乙的副歌 Cue · Cue 2\.500/);
    await expect(page.locator('.lighting-timeline-point')).not.toHaveAttribute('title', /甲的开场 Cue/);
  } finally {
    if (!page.isClosed()) await page.evaluate(() => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null }));
    if (application.process().exitCode === null) await application.close();
  }
});
