import { test, expect, _electron as electron } from '@playwright/test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEmptyLinkProject, parseLinkProject, type Ma2Catalog } from '@tb/schema';
import { convertMa2Timecode } from '../src/main/link/ma2-timecode-conversion';

// Network IPC is simulated; P1 parsing, media import, commands, editor and persistence are real.
for (const scenario of ['complete', 'unavailable', 'partial', 'offset']) test(`网络 P1 导入：${scenario}`, async ({}, info) => {
  const pluginAvailable = scenario !== 'unavailable';
  test.setTimeout(120000);
  const wav = Buffer.alloc(44 + 40000, 128);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34);
  wav.write('data', 36); wav.writeUInt32LE(40000, 40);
  const audio = info.outputPath('song.wav'); await writeFile(audio, wav);
  const p1 = info.outputPath('show.hia');
  const media = (title: string) => `<media mediaType="4" resourceFilePath="${audio.replaceAll('\\', '/')}" playEndAction="0" cut_start="0" cut_end="5" volume="100" mute="0" shortcut="" MidiStartTime="${scenario === 'offset' ? title.includes('甲') ? 3600 : 7200 : 0}" audio_caption_="${title}"/>`;
  await writeFile(p1, `<playerRoot><PlayerOptions Voice="100" AudioVoice="100" AudioMode="0"/><audioPlayList CurrentList="0"><audioPlayElement caption="现场" type="0"/></audioPlayList><videoPlayList CurrentList="0"><videoPlayElement caption="现场" type="0">${media('歌曲甲.mp4')}${media('歌曲乙.mp4')}</videoPlayElement></videoPlayList></playerRoot>`);
  const path = info.outputPath('network.tblink'); await writeFile(path, JSON.stringify(createEmptyLinkProject('网络导入验收')));
  const xml = await readFile(join(process.cwd(), 'src/main/link/fixtures/ma2-timecode-fractional-3.3.xml'), 'utf8');
  const sequence = await readFile(join(process.cwd(), 'src/main/link/fixtures/ma2-sequence-fractional-3.3.xml'), 'utf8');
  const previews = ['歌曲甲', '歌曲乙'].map((name, index) => convertMa2Timecode(xml.replace('index="9901" name="TBLINK_FRACTIONAL_TIMECODE"', `index="${9901 + index}" name="${scenario === 'offset' ? `控台时间线${index}` : name}"${scenario === 'offset' ? ` offset="${(index + 1) * 108000}"` : ''}`), [sequence], 9902 + index));
  const catalog: Ma2Catalog = {
    directory: { show: '测试 Show', generation: 'test', version: '3.3.4.3', entries: previews.map(preview => ({ target: preview.target, name: preview.name })) },
    readAt: new Date().toISOString(),
    entries: previews.map(preview => ({ target: preview.target, name: preview.name, eventCount: 2, frameFormat: '30 FPS', offset: String(scenario === 'offset' ? (preview.target - 9901) * 108000 : 0), slot: 'TC Slot 2', error: null, warnings: [], events: [0, 45].map((time, index) => ({ path: String(index), time: String(time), action: 'Goto', executor: '99.219', cue: index ? '9901 / 7.500' : '9901 / 1.250', name: null })) }))
  };
  const executable = process.env.TBLINK_MA2_PACKAGED_EXE;
  const app = await electron.launch({ ...(executable ? { executablePath: executable } : {}), args: [`--user-data-dir=${info.outputPath('profile')}`, ...executable ? [] : [join(process.cwd(), 'out/main/index.cjs')]] });
  const page = await app.firstWindow();
  try {
    await app.evaluate(({ ipcMain, dialog }, data) => {
      const status = { settings: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test', autoConnect: false }, state: 'connected', version: '3.3.4.3', passwordSaved: false, error: null };
      for (const channel of ['link:ma2-network-status', 'link:ma2-capabilities', 'link:ma2-exchange', 'link:ma2-catalog', 'link:ma2-preview']) ipcMain.removeHandler(channel);
      ipcMain.handle('link:ma2-network-status', () => status);
      ipcMain.handle('link:ma2-capabilities', () => status);
      ipcMain.handle('link:ma2-exchange', (_event, request: { operation: string }) => { if (request.operation !== 'PING') throw new Error('测试禁止写控台'); if (!data.pluginAvailable) throw new Error('请先运行控台插件'); return 'PONG'; });
      ipcMain.handle('link:ma2-catalog', () => { if (!data.pluginAvailable) throw new Error('请先运行控台插件'); return data.catalog; });
      ipcMain.handle('link:ma2-preview', async (_event, request: { target: number }) => {
        await new Promise(resolve => setTimeout(resolve, 800));
        const preview = data.previews.find(preview => preview.target === request.target);
        return data.scenario === 'partial' && request.target === 9902 && preview ? { ...preview, unconverted: [{ path: 'event', reason: '测试不支持的动作' }] } : preview;
      });
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [data.path] });
    }, { path, catalog, previews, pluginAvailable, scenario });
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '设备连接', exact: true }).click();
    await page.getByRole('navigation', { name: '设置子子菜单' }).getByRole('button', { name: 'MA2 控台', exact: true }).click();
    await page.getByLabel('MA2 连接方式').selectOption('network');
    await expect(page.getByLabel('MA2 现场节目导入')).toBeVisible();
    if (pluginAvailable) {
      await page.getByLabel('MA2 连接方式').selectOption('local');
      await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [directory] }); }, info.outputDir);
      await page.getByRole('button', { name: '导出控台插件', exact: true }).click();
      await expect.poll(async () => (await readdir(info.outputDir)).filter(name => name.startsWith('TBLINK-MA2-Bridge-')).length).toBe(1);
      const directory = (await readdir(info.outputDir)).find(name => name.startsWith('TBLINK-MA2-Bridge-'));
      if (!directory) throw new Error('插件未导出');
      await expect.poll(async () => (await readdir(join(info.outputDir, directory))).length).toBe(3);
      expect(await readFile(join(info.outputDir, directory, 'tblink_bridge.lua'), 'utf8')).toContain('LIST');
      expect(await readFile(join(info.outputDir, directory, 'tblink_bridge.xml'), 'utf8')).toContain('tblink_bridge.lua');
    }
    await page.getByLabel('MA2 连接方式').selectOption('network');
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [file] }); }, p1);
    const section = page.getByLabel('MA2 现场节目导入');
    await section.getByText('导入或更新 P1 音乐（可选）', { exact: true }).click();
    await section.getByRole('button', { name: '导入 P1 音乐并匹配控台 Cue', exact: true }).click();
    if (!pluginAvailable) {
      await expect(section.getByText(/灯光导入未完成：/)).toBeVisible();
      const saved = parseLinkProject(JSON.parse(await readFile(path, 'utf8')));
      expect(saved.rundown).toHaveLength(2);
      expect(saved.rundown.every(item => item.referenceAudio && !item.lighting?.ma2Bindings?.length)).toBe(true);
      expect(saved.playbackSource).toBe('internal');
      return;
    }
    if (scenario === 'partial') {
      await expect(section.getByText(/灯光读取完成，1 条灯光已导入，1 条读取失败/)).toBeVisible({ timeout: 60000 });
      await expect(section.getByRole('alert')).toContainText('测试不支持的动作');
      await expect.poll(async () => parseLinkProject(JSON.parse(await readFile(path, 'utf8'))).rundown.filter(item => item.lighting?.ma2Bindings?.length).length).toBe(1);
      await app.evaluate(({ dialog, ipcMain }, values) => {
        dialog.showOpenDialog = () => { throw new Error('读取现有歌曲灯光不得弹出 P1 文件选择'); };
        ipcMain.removeHandler('link:ma2-preview');
        ipcMain.handle('link:ma2-preview', async (_event, request: { target: number }) => { await new Promise(resolve => setTimeout(resolve, 800)); return values.find(value => value.target === request.target); });
      }, previews);
      await section.getByRole('button', { name: '读取控台灯光到现有歌曲', exact: true }).click();
      await expect(section.getByText(/正在读取 Timecode 9902/)).toBeVisible();
      await expect(section.getByLabel('音乐与灯光导入结果')).toHaveCount(0);
      await expect(section.getByText(/灯光读取完成，1 条灯光已导入，0 条读取失败/)).toBeVisible({ timeout: 60000 });
    } else await expect(section.getByText(/灯光读取完成，2 条灯光已导入/)).toBeVisible({ timeout: 60000 });
    await expect(section.getByLabel('音乐与灯光导入结果')).toContainText('已关联 2 / 2 首歌曲');
    await expect.poll(async () => parseLinkProject(JSON.parse(await readFile(path, 'utf8'))).rundown.filter(item => item.lighting?.ma2Bindings?.length).length).toBe(2);
    const saved = parseLinkProject(JSON.parse(await readFile(path, 'utf8')));
    expect(saved.playbackSource).toBe('internal');
    for (const item of saved.rundown) expect(item.lighting?.templates).toHaveLength(2);
    if (scenario === 'offset') for (const [index, item] of saved.rundown.entries()) {
      expect(item.p1Media?.midiStartTime).toBe(String((index + 1) * 3600));
      expect(item.playback?.mtcOffsetMs).toBe((index + 1) * 3600000);
      expect(item.lighting?.ma2Bindings?.[0]?.timeOriginMs).toBe((index + 1) * 3600000);
      expect(item.lighting?.tracks.flatMap(track => track.clips.flatMap(clip => clip.events.map(event => clip.start + event.at)))).toEqual([0, 1500]);
    }
    for (const item of saved.rundown) expect(item.lighting?.tracks.flatMap(track => track.clips.flatMap(clip => clip.events.map(event => event.kind === 'ma2' ? event.cue : '')))).toEqual(['1.250', '7.500']);
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
    await expect(page.locator('.lighting-timeline-point')).toHaveCount(2);
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
    await expect(page.locator('.lighting-timeline-point')).toHaveCount(2);
    await expect(page.locator('.lighting-effect-card')).toHaveCount(2);
    await page.screenshot({ path: info.outputPath('imported-cues.png') });
  } finally { await page.evaluate(() => window.tbLink.setDocumentDirty(false)); await app.close(); }
});
