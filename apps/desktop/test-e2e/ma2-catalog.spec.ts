import { test, expect, _electron as electron, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { answerOlderFormatQuestion, closeDiscarding, savedValue } from './save-questions';

function songAudio(): Buffer {
  const wav = Buffer.alloc(44 + 40000, 128);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34);
  wav.write('data', 36); wav.writeUInt32LE(40000, 40);
  return wav;
}

async function openFixture(info: TestInfo, destination: string): Promise<ElectronApplication> {
  const profile = info.outputPath('profile');
  await mkdir(join(profile, 'link-integrations'), { recursive: true });
  await writeFile(join(profile, 'link-integrations', 'last-project.json'), JSON.stringify({ version: 1, projectPath: destination }));
  const executable = process.env.TBLINK_MA2_PACKAGED_EXE;
  return electron.launch({ ...(executable ? { executablePath: executable } : {}), args: [`--user-data-dir=${info.outputPath('profile')}`, ...executable ? [] : [join(process.cwd(), process.env.TBLINK_E2E_BUILD_DIR ?? 'out', 'main/index.cjs')]] });
}

async function connectFixture(application: ElectronApplication, page: Page): Promise<void> {
  await answerOlderFormatQuestion(application);
  await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
  await page.getByRole('navigation', { name: '设置子子菜单' }).getByRole('button', { name: 'MA2 控台', exact: true }).click();
  await page.getByLabel('MA2 连接方式').selectOption('local');
  await page.getByRole('button', { name: '连接本机 onPC', exact: true }).click();
  await expect(page.getByLabel('MA2 连接方式')).toHaveValue('network', { timeout: 30000 });
  await page.getByText('歌曲导入与同步', { exact: true }).click();
}

test('真实 P1 文件和音频按起始码配对 onPC 时间线并保留小数 Cue', async ({}, info) => {
  test.skip(!process.env.MA2_ONPC_CATALOG_ACCEPTANCE, '需要带验收时间线的本机 onPC');
  const startSeconds = process.env.MA2_ONPC_FRACTIONAL_START_SECONDS ?? '0';
  test.setTimeout(180000);
  const wav = songAudio();
  const audio = info.outputPath('song.wav'); await writeFile(audio, wav);
  const p1 = info.outputPath('show.hia');
  await writeFile(p1, `<playerRoot><PlayerOptions Voice="100" AudioVoice="100" AudioMode="0"/><audioPlayList CurrentList="0"><audioPlayElement caption="现场" type="0"/></audioPlayList><videoPlayList CurrentList="0"><videoPlayElement caption="现场" type="0"><media mediaType="4" resourceFilePath="${audio.replaceAll('\\', '/')}" playEndAction="0" cut_start="0" cut_end="5" volume="100" mute="0" shortcut="" MidiStartTime="${startSeconds}" audio_caption_="TBLINK_FRACTIONAL_TIMECODE"/></videoPlayElement></videoPlayList></playerRoot>`);
  const destination = info.outputPath('migration.tblink'); await writeFile(destination, JSON.stringify(createEmptyLinkProject('一键迁移验收')));
  const application = await openFixture(info, destination);
  const page = await application.firstWindow();
  try {
    await connectFixture(application, page);
    await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [file] }); }, p1);
    const section = page.getByLabel('MA2 现场节目导入');
    await section.getByText('从 P1 工程导入歌曲', { exact: true }).click();
    await section.getByRole('button', { name: '导入 P1 音乐并匹配控台 Cue', exact: true }).click();
    await expect(section.getByText('P1 歌曲和原始时间码已经存在工程里，不用重新选 .hia。')).toBeVisible({ timeout: 120000 });
    await expect.poll(() => savedValue(page, async () => parseLinkProject(JSON.parse(await readFile(destination, 'utf8'))).rundown[0]?.lighting?.ma2Bindings?.[0]?.timecode)).toBe(9902);
    const saved = parseLinkProject(JSON.parse(await readFile(destination, 'utf8')));
    expect(saved.rundown).toHaveLength(1);
    expect(await readFile(join(info.outputDir, saved.rundown[0]!.referenceAudio!.relativePath))).toEqual(wav);
    expect(saved.rundown[0]!.p1Media?.midiStartTime).toBe(startSeconds);
    expect(saved.rundown[0]!.lighting?.tracks[0]?.clips[0]?.events.map(event => event.kind === 'ma2' ? event.cue : '')).toEqual(['1.250', '7.500']);
    await page.screenshot({ path: info.outputPath('one-click.png') });
  } finally { await closeDiscarding(application); }
});

test('真实 onPC 读取小数 Cue，手动同步后控台和保存的时间点一致', async ({}, info) => {
  const show = process.env.MA2_ONPC_DISPOSABLE_SHOW;
  test.skip(!process.env.MA2_ONPC_CATALOG_ACCEPTANCE || !show, '需要指定隔离验收 Show');
  test.setTimeout(180000);
  const project = createEmptyLinkProject('现场扫描验收');
  const start = Number(process.env.MA2_ONPC_FRACTIONAL_START_SECONDS ?? '0') * 1000;
  const wav = songAudio();
  await mkdir(info.outputPath('assets', 'reference-audio'), { recursive: true });
  await writeFile(info.outputPath('assets', 'reference-audio', 'song.wav'), wav);
  project.rundown.push({ id: 'song', title: '验收歌曲', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [],
    referenceAudio: { assetId: 'audio', relativePath: 'assets/reference-audio/song.wav', durationMs: 5000, sha256: createHash('sha256').update(wav).digest('hex') },
    playback: { volume: 100, startMs: 0, endMs: 0, endAction: 'stop', mtcOffsetMs: start, shortcut: '' } });
  const file = info.outputPath('catalog.tblink');
  await writeFile(file, JSON.stringify(project));
  const application = await openFixture(info, file);
  const page = await application.firstWindow();
  const stored = async () => parseLinkProject(JSON.parse(await readFile(file, 'utf8')));
  try {
    await expect(page.getByText('验收歌曲', { exact: true }).first()).toBeVisible();
    await connectFixture(application, page);
    const section = page.getByLabel('MA2 现场节目导入');
    await expect(section.getByRole('button', { name: '查看控台时间线' })).toBeVisible({ timeout: 90000 });
    await expect.poll(() => savedValue(page, async () => (await stored()).rundown[0]?.lighting?.ma2Bindings?.[0]?.timecode)).toBe(9902);
    const saved = await stored();
    expect(saved.ma2ReadState?.catalog.directory.show).toBe(show);
    const events = saved.rundown[0]?.lighting?.tracks[0]?.clips[0]?.events;
    expect(events?.map(e => e.kind === 'ma2' ? [e.cue, e.at] : null)).toEqual([['1.250', 0], ['7.500', 1500]]);
    const reportPath = info.outputPath('site.tbdiag.gz');
    await application.evaluate(({ dialog }, path) => { dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: path }); }, reportPath);
    await section.getByRole('button', { name: '导出控台数据包', exact: true }).click();
    await expect(page.getByText(/控台数据包已导出/).first()).toBeVisible({ timeout: 30000 });
    const report = gunzipSync(await readFile(reportPath)).toString('utf8');
    for (const content of ['TBLINK_FRACTIONAL_TIMECODE', '1.250', '<Timecode']) expect(report).toContain(content);
    const audition = page.getByRole('switch', { name: '时间线选中 Cue 试听' });
    await expect(audition).not.toBeChecked();
    await audition.check();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
    const points = page.locator('.waveform-cue-point:visible');
    await expect(points).toHaveCount(2);
    await points.first().click();
    const first = await points.first().boundingBox(), last = await points.last().boundingBox();
    if (!first || !last || last.x <= first.x) throw new Error('无法定位两个灯光点');
    const x = last.x + last.width / 2, y = last.y + last.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x - (last.x - first.x) / 5, y, { steps: 8 }); await page.mouse.up();
    const baseline = async () => (await stored()).rundown[0]?.lighting?.ma2Bindings?.[0]?.baselineTracks[0]?.clips[0]?.events[1]?.at;
    await expect.poll(() => savedValue(page, baseline)).toBe(1500);
    const changed = (await stored()).rundown[0]!.lighting!.tracks[0]!.clips[0]!.events[1]!.at;
    expect(changed).toBeLessThan(1500);
    await page.getByRole('button', { name: '同步', exact: true }).click();
    await expect(page.locator('.lighting-sync-result')).toHaveText('已同步', { timeout: 30000 });
    await expect.poll(() => savedValue(page, baseline)).toBeCloseTo(changed, 0);
    await page.screenshot({ path: info.outputPath('manual-song-sync.png') });
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
    const editorPoints = page.locator('.lighting-timeline-point:visible');
    await expect(editorPoints).toHaveCount(2);
    await editorPoints.last().click();
    const opening = await editorPoints.first().boundingBox();
    if (!opening) throw new Error('编辑器无法定位首个 Cue');
    const left = opening.x + opening.width / 2, top = opening.y + opening.height / 2;
    await page.mouse.move(left, top); await page.mouse.down();
    await page.mouse.move(left + 25, top, { steps: 6 }); await page.mouse.up();
    await expect.poll(() => savedValue(page, async () => (await stored()).rundown[0]?.lighting?.tracks[0]?.clips[0]?.events[0]?.at)).toBeGreaterThan(0);
  } finally { await closeDiscarding(application); }
});
