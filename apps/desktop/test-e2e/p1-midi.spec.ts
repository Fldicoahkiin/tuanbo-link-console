import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createEmptyLinkProject, parseLinkProject, createLightingDocument, lightingTrackSchema } from '@tb/schema';
import { answerSaveQuestions, saveProject, savedValue } from './save-questions';

test('一键识别 MIDI 输出，点击 Cue 发包，关闭开关不发包', async ({}, info) => {
  const wav = Buffer.alloc(44 + 8000 * 10, 128);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await mkdir(info.outputPath('assets/reference-audio'), { recursive: true });
  await writeFile(info.outputPath('assets/reference-audio/song.wav'), wav);
  const lighting = createLightingDocument();
  lighting.tracks = [lightingTrackSchema.parse({ id: 'track', name: '灯光', kind: 'ma2', color: '#ffffff', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: 'clip', name: '灯光', start: 0, duration: 10000, timeLock: 'time', muted: false, events: [{ id: 'a', kind: 'ma2', action: 'goto', cue: '1', sequence: 1, executor: '2.101', label: 'A', at: 2000 }, { id: 'b', kind: 'ma2', action: 'goto', cue: '2', sequence: 1, executor: '2.101', label: 'B', at: 4000 }] }] })];
  const project = parseLinkProject({ ...createEmptyLinkProject('MIDI Cue 验收'), schemaVersion: 2, playbackSource: 'internal', rundown: [{ id: 'song', title: '歌曲', cues: [], referenceAudio: { assetId: 'audio', relativePath: 'assets/reference-audio/song.wav', durationMs: 10000, sha256: createHash('sha256').update(wav).digest('hex') }, lighting }] });
  const path = info.outputPath('show.tblink'); await writeFile(path, JSON.stringify(project));
  const executable = process.env.TBLINK_MA2_PACKAGED_EXE;
  const app = await electron.launch({ ...(executable ? { executablePath: executable } : {}), args: [`--user-data-dir=${info.outputPath('profile')}`, ...executable ? [] : [join(process.cwd(), 'out/main/index.cjs')]] });
  const page = await app.firstWindow();
  await answerSaveQuestions(app);
  try {
    await app.evaluate(({ ipcMain, dialog }, file) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [file] });
      ipcMain.removeHandler('link:detect-local-integrations');
      ipcMain.handle('link:detect-local-integrations', () => ({ detectedAt: new Date().toISOString(), applications: Object.fromEntries(['obs', 'p1'].map(id => [id, { id, executablePath: null, workingDirectory: null, processName: null, windowTitle: null, version: null, running: false }])) }));
      ipcMain.removeHandler('link:midi-recheck'); ipcMain.handle('link:midi-recheck', () => undefined);
      ipcMain.removeHandler('link:obs-connect'); ipcMain.handle('link:obs-connect', () => { throw new Error('隔离 MIDI 测试不连接 OBS'); });
      // Connect-all stops at the first failed step; isolated OBS steps succeed so the MIDI steps run.
      ipcMain.removeHandler('link:obs-connect-local'); ipcMain.handle('link:obs-connect-local', () => ({ version: 1, address: 'ws://127.0.0.1:4455', password: '',
        snapshot: { status: 'connected', obsVersion: '32.2.2', webSocketVersion: '5.7.4', error: null } }));
      ipcMain.removeHandler('link:obs-inventory'); ipcMain.handle('link:obs-inventory', () => ({ scenes: [], inputs: [], inputKinds: {}, inputAudioStates: {}, sceneItems: {}, filters: {}, transitions: [], sourceSizes: {} }));
      ipcMain.removeHandler('link:obs-live-frame'); ipcMain.handle('link:obs-live-frame', () => ({ width: 1, height: 1, rgba: new Uint8Array(4), sequence: 1, timestampNs: '1' }));
      ipcMain.removeHandler('link:obs-live-close'); ipcMain.handle('link:obs-live-close', () => undefined);
      ipcMain.removeHandler('link:process-start'); ipcMain.handle('link:process-start', () => { throw new Error('隔离测试不启动外部程序'); });
    }, path);
    await page.evaluate(() => {
      const packets: number[][] = []; Reflect.set(window, '__cuePackets', packets);
      const port = Object.assign(new EventTarget(), { id: 'usb', name: 'USB MIDI', manufacturer: 'Test', type: 'output', state: 'connected', connection: 'closed', open() { this.connection = 'open'; return Promise.resolve(this); }, close() { this.connection = 'closed'; return Promise.resolve(this); }, send(bytes: number[]) { packets.push([...bytes]); }, clear() { packets.length = 0; } });
      const access = Object.assign(new EventTarget(), { inputs: new Map(), outputs: new Map([['usb', port]]), sysexEnabled: true });
      Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: () => Promise.resolve(access) });
    });
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('button', { name: '顶部一键连接', exact: true }).click();
    await expect.poll(async () => {
      const saved = await page.evaluate(() => window.tbLink.loadIntegrationProfile());
      return saved?.midiPortProfiles.find(port => port.id === 'lighting-events-output')?.portName;
    }).toBe('USB MIDI');
    await expect(page.getByRole('button', { name: '顶部一键连接', exact: true })).toBeEnabled();
    await expect(page.getByRole('dialog', { name: '设备连接检查结果', exact: true })).toHaveCount(0);
    const connectionResult = page.getByLabel('全部连接状态', { exact: true });
    await page.getByRole('button', { name: '详细', exact: true }).click();
    await expect(connectionResult.getByRole('button', { name: '灯光 Cue 输出：已连接', exact: true })).toBeVisible();
    await connectionResult.getByRole('button', { name: 'OBS 控制：已连接', exact: true }).click();
    await page.getByRole('region', { name: '连接详情' }).getByRole('button', { name: '前往设置', exact: true }).click();
    await expect(page.getByRole('navigation', { name: '设置子子菜单' })).toBeVisible();
    const packets = () => page.evaluate(() => Reflect.get(window, '__cuePackets') as number[][]);
    expect(await packets()).toEqual([]);
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
    await page.getByRole('button', { name: '音频 Cue 1', exact: true }).click();
    await expect.poll(packets).toEqual([[0xf0, 0x7f, 127, 2, 1, 1, ...Array.from('1.000\0' + '101.2', char => char.charCodeAt(0)), 0xf7]]);
    await page.locator('.lighting-playback-settings > summary').click();
    await page.getByLabel('选中 Cue 实时播放', { exact: true }).uncheck();
    await page.getByRole('button', { name: '音频 Cue 2', exact: true }).click();
    expect(await packets()).toHaveLength(1);
    await page.getByLabel('选中 Cue 实时播放', { exact: true }).check();
    await page.getByRole('button', { name: '音频 Cue 2', exact: true }).click();
    await expect.poll(async () => (await packets()).length).toBe(2);
    await expect(page.getByText('已发送 1 条 Cue 指令（MIDI 无回执）', { exact: true })).toBeVisible();
  } finally { await page.evaluate(() => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null })); await app.close(); }
});

test('纯 MIDI 无网络前置：裁剪 P1 导入、保存重开、未启动 P1 导出', async ({}, info) => {
  const wav = Buffer.alloc(44 + 8000 * 3, 128);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  const audio = info.outputPath('song.wav'); await writeFile(audio, wav);
  const source = info.outputPath('show.hia');
  await writeFile(source, `<playerRoot><videoPlayList><videoPlayElement caption="现场"><media mediaType="4" resourceFilePath="${audio.replaceAll('\\', '/')}" playEndAction="2" cut_start="1.25" cut_end="2.5" volume="100" mute="0" shortcut="" MidiStartTime="120" audio_caption_="裁剪歌曲"/></videoPlayElement></videoPlayList></playerRoot>`);
  const path = info.outputPath('show.tblink'); await writeFile(path, JSON.stringify(createEmptyLinkProject('纯 MIDI 验收')));
  await writeFile(source, (await readFile(source, 'utf8')).replace('</videoPlayList>', `<videoPlayElement caption="列表2"><media mediaType="4" resourceFilePath="${audio.replaceAll('\\', '/')}" playEndAction="2" cut_start="0" cut_end="0" volume="100" mute="0" MidiStartTime="180" audio_caption_="异常歌曲"/></videoPlayElement></videoPlayList>`));
  await writeFile(source, (await readFile(source, 'utf8')).replace('</videoPlayList>', `<videoPlayElement caption="缺文件列表"><media mediaType="4" resourceFilePath="${info.outputPath('missing.wav').replaceAll('\\', '/')}" playEndAction="2" cut_start="0" cut_end="0" volume="100" mute="0" MidiStartTime="200" audio_caption_="待补歌曲"/></videoPlayElement></videoPlayList>`));
  const executable = process.env.TBLINK_MA2_PACKAGED_EXE;
  const app = await electron.launch({ ...(executable ? { executablePath: executable } : {}), args: [`--user-data-dir=${info.outputPath('profile')}`, ...executable ? [] : [join(process.cwd(), 'out/main/index.cjs')]] });
  const page = await app.firstWindow();
  await answerSaveQuestions(app);
  const pick = async (file: string): Promise<void> => { await app.evaluate(({ dialog }, value) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [value] }); }, file); };
  const settings = async (): Promise<void> => {
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
    await page.getByRole('navigation', { name: '设置子子菜单' }).getByRole('button', { name: 'MA2 控台', exact: true }).click();
  };
  try {
    await pick(path); await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await settings();
    await expect(page.getByLabel('MA2 连接方式')).toHaveValue('midi');
    await expect(page.getByLabel('MA2 控台 IP')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '扫描控台全部时间线', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '详细', exact: true }).click();
    await expect(page.getByLabel('全部连接状态').getByRole('button', { name: 'MA2 网络：未启用', exact: true })).toBeVisible();
    await expect(page.getByLabel('全部连接状态').getByRole('button', { name: 'MA2 工程通信：未启用', exact: true })).toBeVisible();
    await page.getByLabel('MA2 连接方式').selectOption('local');
    await pick(info.outputDir);
    await page.getByText('控台插件与安装说明', { exact: true }).click();
    await page.getByRole('button', { name: '导出控台插件', exact: true }).click();
    await expect.poll(async () => (await readdir(info.outputDir)).filter(name => name.startsWith('TBLINK-MA2-Bridge-')).length).toBe(1);
    const pluginDirectory = (await readdir(info.outputDir)).find(name => name.startsWith('TBLINK-MA2-Bridge-'))!;
    await expect.poll(async () => (await readdir(join(info.outputDir, pluginDirectory))).length).toBe(3);
    expect(await readFile(join(info.outputDir, pluginDirectory, 'tblink_bridge.lua'), 'utf8')).toBe(await readFile(join(process.cwd(), '../../tools/ma2/tblink_bridge.lua'), 'utf8'));
    await page.getByLabel('MA2 连接方式').selectOption('midi');
    await page.getByText('控台 MIDI 地址与配置说明', { exact: true }).click();
    await page.getByLabel('MA2 MSC 设备号').fill('5'); await page.getByLabel('MA2 MSC 设备号').press('Tab');
    await expect(page.getByLabel('MA2 MSC 设备号')).toHaveValue('5');
    await pick(source);
    const panel = page.getByLabel('MA2 设备面板');
    await panel.getByText('MIDI 连接说明', { exact: true }).click();
    await panel.getByLabel('导入 P1 工程').click();
    await panel.getByRole('button', { name: '选择 .hia 文件', exact: true }).click();
    await expect(panel.getByText('已建立映射', { exact: true })).toBeVisible();
    await expect(panel.getByText('已恢复的歌曲：请核对裁剪范围', { exact: true })).toBeVisible();
    await expect.poll(() => savedValue(page, async () => parseLinkProject(JSON.parse(await readFile(path, 'utf8'))).playbackSource)).toBe('internal');
    await expect.poll(() => savedValue(page, async () => parseLinkProject(JSON.parse(await readFile(path, 'utf8'))).rundown[0]?.playback?.mtcOffsetMs)).toBe(120000);
    const summaries = await panel.locator('.p1-sync-summary, .p1-sync-issues').evaluateAll(elements => elements.map(element => { const box = element.getBoundingClientRect(); return { top: box.top, bottom: box.bottom }; }));
    for (let i = 0; i < summaries.length; i++) for (let j = i + 1; j < summaries.length; j++) expect(Math.min(summaries[i]!.bottom, summaries[j]!.bottom) - Math.max(summaries[i]!.top, summaries[j]!.top)).toBeLessThanOrEqual(0);
    await panel.locator('.p1-sync-issues').last().scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('midi-p1.png') });
    for (const width of [1200, 1440, 1920]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setBounds({ width, height: 900 }), width);
      const sync = panel.locator('.p1-sync-layout');
      await expect.poll(() => sync.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      const boxes = await sync.locator(':scope > *').evaluateAll(elements => elements.filter(element => element.getBoundingClientRect().height > 0).map(element => { const box = element.getBoundingClientRect(); return { top: box.top, bottom: box.bottom }; }));
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(Math.min(boxes[i]!.bottom, boxes[j]!.bottom) - Math.max(boxes[i]!.top, boxes[j]!.top)).toBeLessThanOrEqual(0);
      await sync.screenshot({ path: info.outputPath(`p1-sync-${width}.png`) });
    }
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
    await page.getByLabel('灯光输出方式').selectOption('direct');
    await expect.poll(() => savedValue(page, async () => parseLinkProject(JSON.parse(await readFile(path, 'utf8'))).rundown[0]?.lighting?.outputMode)).toBe('direct');

    await page.reload();
    await expect(page.getByLabel('当前工程')).toContainText('纯 MIDI 验收');
    await settings(); await pick(source);
    await panel.getByText('MIDI 连接说明', { exact: true }).click();
    page.on('dialog', dialog => void dialog.accept());
    await panel.getByRole('button', { name: '同步回 P1 工程', exact: true }).click();
    await expect(panel.locator('.p1-sync-summary').first()).toBeVisible();
    await saveProject(page);
    const saved = parseLinkProject(JSON.parse(await readFile(path, 'utf8')));
    expect(saved.rundown[0]?.referenceAudio?.durationMs).toBe(1250);
    expect(saved.rundown[0]?.p1Media?.midiStartTime).toBe('120');
    expect(saved.rundown).toHaveLength(3);
    expect(saved.rundown[1]?.referenceAudio?.durationMs).toBe(3000);
    expect(saved.rundown[1]?.notes).toContain('完整原音频');
    expect(saved.p1Sync?.skippedItems ?? []).toHaveLength(1);
    expect(saved.rundown[2]).toMatchObject({ title: '待补歌曲', enabled: false });
    expect(saved.rundown[2]?.referenceAudio).toBeUndefined();
    const exported = await page.locator('.p1-sync-path').filter({ hasText: /联动|linked/ }).first().innerText();
    expect(exported).toContain('.hia');
    expect(await readFile(exported.trim(), 'utf8')).toContain('audio_caption_="异常歌曲"');
    expect(await readFile(exported.trim(), 'utf8')).toContain('audio_caption_="待补歌曲"');
  } finally { await page.evaluate(() => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null })); await app.close(); }
});
