import { test, expect, _electron as electron } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject, type Ma2Catalog, type Ma2TimecodePreview } from '@tb/schema';
import { importMa2TimecodeCommand, reconcileMa2ReadState } from '@tb/core/link';
import { closeDiscarding } from './save-questions';

/** A console show starting at `startMs` with one Goto a second after its start. */
function preview(target: number, startMs: number): Ma2TimecodePreview {
  const document = createLightingDocument();
  document.tracks.push({ id: `track-${target}`, kind: 'ma2', name: `序列 ${target}`, color: '#ba8fff', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {},
    clips: [{ id: `clip-${target}`, name: 'MA2', start: 0, duration: 1001, timeLock: 'time', muted: false, events: [{ id: `event-${target}`, kind: 'ma2', at: 1000, sequence: 600 + target, cue: '1', executor: '1.101', label: `Cue ${target}`, action: 'goto' }] }] });
  return { target, name: `灯光 ${target}`, readAt: '2026-11-04T00:00:00.000Z', document, sourceXml: `<MA><Timecode index="${target}"/></MA>`, timeOriginMs: startMs,
    mappings: [{ eventId: `event-${target}`, trackId: `track-${target}`, clipId: `clip-${target}`, path: `Timecode:${target}/Track:0/SubTrack:0/Event:0`, sequence: 600 + target, cueIndex: 1, executor: '1.101' }], warnings: [], unconverted: [] };
}
const entry = (target: number, startMs: number): Ma2Catalog['entries'][number] => ({ target, name: `灯光 ${target}`, eventCount: 1, frameFormat: '30 FPS', offset: String(startMs * 30 / 1000), slot: 'TC Slot 2',
  events: [{ path: '0', time: '30', action: 'Goto', executor: '1.101', cue: '1', name: null }], error: null, warnings: [], preview: preview(target, startMs) });

test('改了 MTC 起始码，灯光自动换到同起点的控台时间线；控台时间线里也能选给哪首歌用（2026-11-04）', async ({}, info) => {
  const wav = Buffer.alloc(44 + 8000 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await mkdir(info.outputPath('assets/reference-audio'), { recursive: true }); await writeFile(info.outputPath('assets/reference-audio/trip.wav'), wav);
  const base = parseLinkProject({ ...createEmptyLinkProject('换时间线'), schemaVersion: 2, playbackSource: 'internal', obsOutputMode: 'scenes',
    rundown: [{ id: 'trip', title: 'trip', cues: [], referenceAudio: { assetId: 'audio', relativePath: 'assets/reference-audio/trip.wav', durationMs: 1000, sha256: createHash('sha256').update(wav).digest('hex') },
      playback: { volume: 100, endAction: 'stop', startMs: 0, endMs: 0, mtcOffsetMs: 60_000, shortcut: '' } }] });
  const bound = importMa2TimecodeCommand('trip', preview(112, 60_000)).execute(base);
  const catalog: Ma2Catalog = { directory: { show: 'show', generation: '1', version: '3.3.4', entries: [{ target: 112, name: '灯光 112' }, { target: 121, name: '灯光 121' }] }, readAt: '2026-11-04T00:00:00.000Z', entries: [entry(112, 60_000), entry(121, 70_000)] };
  const project = { ...bound, ma2ReadState: reconcileMa2ReadState(bound, 'console', catalog) };
  const file = info.outputPath('switch.tblink'); await writeFile(file, JSON.stringify(project));
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')] });
  const page = await app.firstWindow();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '当前工程', exact: true }).click();
    await page.getByRole('navigation', { name: '设置子子菜单' }).getByRole('button', { name: '时间码', exact: true }).click();
    const start = page.getByRole('textbox', { name: 'trip 的 MTC 起始时间', exact: true });
    await expect(start).toHaveValue('00:01:00:00');
    await start.fill('00:01:10:00'); await start.press('Enter');
    await expect(start).toHaveValue('00:01:10:00');

    await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
    await page.getByRole('navigation', { name: '设置子子菜单' }).getByRole('button', { name: 'MA2 控台', exact: true }).click();
    await page.getByLabel('MA2 连接方式').selectOption('network');
    await page.getByText('歌曲导入与同步', { exact: true }).click();
    await page.getByRole('button', { name: '查看控台时间线', exact: true }).click();
    const browser = page.getByRole('region', { name: '控台时间线与歌曲', exact: true });
    const timelines = browser.getByRole('navigation', { name: '已读取时间线' });
    await expect(timelines.getByRole('button', { name: /121 · 灯光 121/ })).toContainText('对上「trip」 · Cue 已放进歌曲 · MTC 00:01:10:00');
    await timelines.getByRole('button', { name: /112 · 灯光 112/ }).click();
    await expect(browser.getByText(/已归档「trip」在这条时间线上的 Cue 和本地改动，这首歌现在用 Timecode 121/)).toBeVisible();

    // Back to Timecode 112 by hand: the song takes its start and gets its archived Cues back.
    await browser.getByRole('combobox', { name: 'Timecode 112 给哪首歌用', exact: true }).selectOption({ label: 'trip · MTC 00:01:10:00' });
    await browser.getByRole('button', { name: '用这条时间线', exact: true }).click();
    await expect(page.getByText('「trip」的起始码改成了 MTC 00:01:00:00，现在用 Timecode 112 跑灯')).toBeVisible();
    await expect(timelines.getByRole('button', { name: /112 · 灯光 112/ })).toContainText('对上「trip」 · Cue 已放进歌曲');
    await expect(browser.getByRole('button', { name: '用这条时间线', exact: true })).toBeDisabled();
    await page.screenshot({ path: info.outputPath('timeline-switch.png') });

    // The song's MTC start on the timeline toolbar opens and closes this page from the lighting workbench.
    const badge = page.getByRole('button', { name: /，查看控台时间线$/ });
    await expect(badge).toHaveAttribute('aria-pressed', 'true');
    await badge.click();
    await expect(browser).toHaveCount(0);
    await expect(badge).toHaveAttribute('aria-pressed', 'false');
    await badge.click();
    await expect(browser).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await closeDiscarding(app); }
});
