import { chmod, cp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { _electron as electron, expect, test, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createEmptyLinkProject, parseLinkProject, serializeLinkProject } from '@tb/schema';
import { createDefaultIntegrationProfile } from '../src/renderer/src/link/view-models/local-integration-profile';

const execFileAsync = promisify(execFile);
const desktopEntry = join(process.cwd(), process.env.TBLINK_E2E_BUILD_DIR ?? 'out', 'main/index.cjs');
type Shown = { title: string; detail: string };

async function launch(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [`--user-data-dir=${userData}`, desktopEntry] });
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.tbLink));
  return { app, page };
}

/** Answers native message boxes by title, in order; any other box is cancelled and recorded. */
async function answerDialogs(app: ElectronApplication, answers: Record<string, number[]>, savePath?: string): Promise<void> {
  await app.evaluate(({ dialog }, { answers, savePath }) => {
    const shown: Array<{ title: string; detail: string }> = [];
    Reflect.set(globalThis, '__shownDialogs', shown);
    const queues = new Map(Object.entries(answers));
    const showMessageBox = (...args: unknown[]): Promise<{ response: number; checkboxChecked: boolean }> => {
      const options = args.at(-1) as { title?: string; detail?: string; cancelId?: number };
      shown.push({ title: options.title ?? '', detail: options.detail ?? '' });
      const queue = queues.get(options.title ?? '');
      return Promise.resolve({ response: queue?.length ? queue.shift()! : options.cancelId ?? 0, checkboxChecked: false });
    };
    Reflect.set(dialog, 'showMessageBox', showMessageBox);
    if (savePath) Reflect.set(dialog, 'showSaveDialog', () => Promise.resolve({ canceled: false, filePath: savePath }));
  }, { answers, savePath });
}
const shownDialogs = (app: ElectronApplication): Promise<Shown[]> => app.evaluate(() => [...(Reflect.get(globalThis, '__shownDialogs') as Shown[])]);

async function recoveryCopies(userData: string): Promise<string[]> {
  try { return (await readdir(join(userData, 'link-recovery'))).filter(name => name.endsWith('.tblink')); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []; throw error; }
}

function showFile(path: string, name = '原节目'): Promise<void> {
  const project = createEmptyLinkProject('保存模型');
  project.obsOutputMode = 'scenes';
  project.rundown.push({ id: 'song', title: name, enabled: true, notes: '', referenceMediaClips: [], cues: [],
    visualLayers: [{ id: 'visual', name: '画面 1', visible: true, locked: false }] });
  return writeFile(path, serializeLinkProject(project));
}

async function openFile(app: ElectronApplication, page: Page, path: string): Promise<void> {
  await app.evaluate(({ dialog }, file) => { Reflect.set(dialog, 'showOpenDialog', () => Promise.resolve({ canceled: false, filePaths: [file] })); }, path);
  // Every test opens its file from the welcome screen of a fresh window.
  await page.getByRole('button', { name: '打开工程', exact: true }).click();
}

async function renameProgram(page: Page, title: string): Promise<void> {
  const button = page.getByRole('button', { name: '节目属性', exact: true });
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
  const name = page.locator('.p1-item-inspector').getByLabel('节目名称', { exact: true });
  await name.fill(title); await name.press('Tab');
}

const savedTitle = async (path: string): Promise<string | undefined> => parseLinkProject(JSON.parse(await readFile(path, 'utf8'))).rundown[0]?.title;
const unsaved = (page: Page) => page.locator('.project-save-status');

async function closeWithoutSaving(app: ElectronApplication, page: Page): Promise<void> {
  if (!page.isClosed()) await page.evaluate(() => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null }));
  await app.close();
}

test('编辑只写恢复副本、不写工程文件；Ctrl+S 写入工程文件并清除副本，撤销回到保存点不再算改动', async ({}, info) => {
  const userData = info.outputPath('profile'); const path = info.outputPath('show.tblink');
  await showFile(path);
  const { app, page } = await launch(userData);
  try {
    await openFile(app, page, path);
    await renameProgram(page, '只在内存');
    await expect(unsaved(page)).toBeVisible();
    await expect.poll(() => recoveryCopies(userData)).toHaveLength(1);
    expect(await savedTitle(path)).toBe('原节目');
    await page.keyboard.press('Control+S');
    await expect(unsaved(page)).toBeHidden();
    expect(await savedTitle(path)).toBe('只在内存');
    await expect.poll(() => recoveryCopies(userData)).toHaveLength(0);
    await renameProgram(page, '临时修改');
    await expect(unsaved(page)).toBeVisible();
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(unsaved(page)).toBeHidden();
  } finally { await closeWithoutSaving(app, page); }
});

test('关闭时询问：保存失败留在对话框并说明原因，取消后软件保持打开；再次退出选择保存后写入并退出', async ({}, info) => {
  const userData = info.outputPath('profile'); const path = info.outputPath('readonly.tblink');
  await showFile(path);
  const { app, page } = await launch(userData);
  let exited = false; app.on('close', () => { exited = true; });
  try {
    await openFile(app, page, path);
    await renameProgram(page, '关闭前修改');
    await expect(unsaved(page)).toBeVisible();
    await chmod(path, 0o444);
    await answerDialogs(app, { 工程尚未保存: [0, 2] });
    await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
    await expect.poll(async () => (await shownDialogs(app)).length).toBe(2);
    const shown = await shownDialogs(app);
    expect(shown.map(value => value.title)).toEqual(['工程尚未保存', '工程尚未保存']);
    expect(shown[1]!.detail).toContain('上次保存失败');
    await page.waitForTimeout(500);
    expect(exited).toBe(false);
    await expect(unsaved(page)).toBeVisible();
    expect(await savedTitle(path)).toBe('原节目');

    await chmod(path, 0o666);
    await answerDialogs(app, { 工程尚未保存: [0] });
    const closed = app.waitForEvent('close');
    await app.evaluate(({ app: electronApp }) => { electronApp.quit(); });
    await closed;
    expect(await savedTitle(path)).toBe('关闭前修改');
    expect(await recoveryCopies(userData)).toHaveLength(0);
  } finally {
    await chmod(path, 0o666);
    if (!exited) await closeWithoutSaving(app, page);
  }
});

test('不保存后退出流程被取消（灯光试听未停止，返回软件）：修改和恢复副本都保留，再次关闭仍询问；完成退出后副本清除', async ({}, info) => {
  const sockets = new Set<Socket>();
  const own = (socket: Socket): void => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); };
  const monitor = createServer(own);
  const command = createServer(socket => {
    own(socket); socket.write("Logged in as User 'guest'\r\n [Channel]>Please login !\r\n"); let buffer = '';
    socket.on('data', (data: Buffer) => {
      buffer += data.toString();
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (line.startsWith('Login ')) { socket.write('\r\n [Channel]>'); continue; }
        const auth = /TBLINK_AUTH_[a-f0-9]{32}/.exec(line)?.[0], boot = /TBLINK_BOOT_[a-f0-9]{32}/.exec(line)?.[0];
        if (auth) { socket.write(`\r\n${auth}:3.9.60.74\r\n`); continue; }
        if (boot) { socket.write(`\r\n${boot}:ready\r\n`); continue; }
        const play = /TBLINK_PLAY_[a-f0-9]{32}/.exec(line)?.[0];
        // Goto is confirmed; Off never is, so the quit flow stops at the audition question.
        if (play) socket.write(`\r\n${play}:${line.includes("gma.cmd('Off ") ? 'LOST' : 'SENT'}\r\n`);
      }
    });
  });
  const listen = async (server: Server): Promise<number> => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('测试端口未就绪'); return address.port;
  };
  const network = { host: '127.0.0.1', port: await listen(command), monitorPort: await listen(monitor), username: 'test' };
  const userData = info.outputPath('profile'); const path = info.outputPath('audition.tblink');
  await showFile(path);
  const { app, page } = await launch(userData);
  let exited = false; app.on('close', () => { exited = true; });
  try {
    await openFile(app, page, path);
    await renameProgram(page, '放弃但未退出');
    await expect.poll(() => recoveryCopies(userData)).toHaveLength(1);
    await page.evaluate(async settings => {
      await window.tbLink.saveMa2Network({ settings });
      const result = await window.tbLink.connectMa2Network();
      if (result.state !== 'connected') throw new Error(result.error ?? '测试连接失败');
    }, { ...network, autoConnect: false });
    await page.evaluate(async target => {
      const { generation } = await window.tbLink.controlMa2Audition({ version: 1, action: 'status' });
      await window.tbLink.playMa2Audition({ version: 1, generation, network: target, sessionId: crypto.randomUUID(),
        deadlineAt: Date.now() + 5000, action: { target: 'sequence', sequence: 168, cue: '1.000', action: 'goto' } });
    }, network);
    // 不保存, then 返回软件 at the audition question: the quit is cancelled.
    await answerDialogs(app, { 工程尚未保存: [1, 1], 灯光试听未能停止: [0, 1] });
    await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
    await expect.poll(async () => (await shownDialogs(app)).map(value => value.title)).toEqual(['工程尚未保存', '灯光试听未能停止']);
    await page.waitForTimeout(500);
    expect(exited).toBe(false);
    await expect(unsaved(page)).toBeVisible();
    expect(await recoveryCopies(userData)).toHaveLength(1);
    // Asked again; 不保存 and 仍然退出 complete the quit, and the copy goes with it.
    const closed = app.waitForEvent('close');
    await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
    await closed;
    expect(await recoveryCopies(userData)).toHaveLength(0);
    expect(await savedTitle(path)).toBe('原节目');
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all([command, monitor].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    if (!exited) await closeWithoutSaving(app, page);
  }
});

/**
 * Edits the project, then force-ends the app as a crash would, and puts its recovery copy
 * into a fresh profile: the restart must not reopen the file by itself before the dialog answers are in place.
 */
async function crashWithUnsavedEdit(info: TestInfo, path: string, userData: string): Promise<void> {
  const crashed = info.outputPath('crashed-profile');
  await showFile(path);
  const first = await launch(crashed);
  await openFile(first.app, first.page, path);
  await renameProgram(first.page, '崩溃前的修改');
  await expect.poll(() => recoveryCopies(crashed)).toHaveLength(1);
  const killed = first.app.waitForEvent('close');
  // Playwright starts Electron through a shell on Windows: end the whole tree, as a crash would.
  const pid = first.app.process().pid;
  if (process.platform === 'win32' && pid) await execFileAsync('taskkill', ['/F', '/T', '/PID', String(pid)]);
  else first.app.process().kill('SIGKILL');
  await killed;
  expect(await savedTitle(path)).toBe('原节目');
  await cp(join(crashed, 'link-recovery'), join(userData, 'link-recovery'), { recursive: true });
}

test('进程被强制结束后重新打开工程：提示恢复，恢复后内容回来且标记未保存，保存后副本清除', async ({}, info) => {
  const userData = info.outputPath('profile'); const path = info.outputPath('crash.tblink');
  await crashWithUnsavedEdit(info, path, userData);

  const { app, page } = await launch(userData);
  try {
    await answerDialogs(app, { 发现未保存的改动: [0] });
    await openFile(app, page, path);
    await expect(page.getByText('崩溃前的修改').first()).toBeVisible();
    expect((await shownDialogs(app)).map(value => value.title)).toEqual(['发现未保存的改动']);
    await expect(unsaved(page)).toBeVisible();
    expect(await savedTitle(path)).toBe('原节目');
    await page.keyboard.press('Control+S');
    await expect(unsaved(page)).toBeHidden();
    expect(await savedTitle(path)).toBe('崩溃前的修改');
    await expect.poll(() => recoveryCopies(userData)).toHaveLength(0);
  } finally { await closeWithoutSaving(app, page); }
});

test('启动时把超过 30 天的恢复副本移到回收站，打开工程不再提示', async ({}, info) => {
  const userData = info.outputPath('profile'); const path = info.outputPath('expired.tblink');
  await crashWithUnsavedEdit(info, path, userData);
  const directory = join(userData, 'link-recovery');
  const [record] = (await readdir(directory)).filter(name => name.endsWith('.json'));
  const manifest = JSON.parse(await readFile(join(directory, record!), 'utf8')) as Record<string, unknown>;
  await writeFile(join(directory, record!), JSON.stringify({ ...manifest, savedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString() }));
  const { app, page } = await launch(userData);
  try {
    // An interrupted write's temporary file stays for an hour; only copies and records count here.
    await expect.poll(async () => (await readdir(directory)).filter(name => !name.endsWith('.tmp'))).toEqual([]);
    await answerDialogs(app, {});
    await openFile(app, page, path);
    await expect(page.getByText('原节目').first()).toBeVisible();
    expect(await shownDialogs(app)).toEqual([]);
  } finally { await closeWithoutSaving(app, page); }
});

test('未命名工程的未保存修改在界面重新载入后提示恢复', async ({}, info) => {
  const userData = info.outputPath('profile');
  const { app, page } = await launch(userData);
  try {
    await page.getByRole('button', { name: '新建工程', exact: true }).click();
    await page.getByLabel('工程名称').fill('未命名恢复');
    await page.getByRole('button', { name: '创建工程', exact: true }).click();
    const grid = page.locator('.p1-media-grid');
    const box = await grid.boundingBox();
    await grid.click({ button: 'right', position: { x: 10, y: box!.height - 10 } });
    await page.getByRole('menuitem', { name: '新建空白节目', exact: true }).click();
    await expect(page.locator('.p1-media-card')).toHaveCount(1);
    await expect.poll(() => recoveryCopies(userData)).toHaveLength(1);
    await answerDialogs(app, { 发现未保存的改动: [0] });
    await page.reload();
    await expect(page.locator('.p1-media-card')).toHaveCount(1);
    expect((await shownDialogs(app)).map(value => value.title)).toEqual(['发现未保存的改动']);
    await expect(unsaved(page)).toBeVisible();
  } finally { await closeWithoutSaving(app, page); }
});

test('另存为写到新位置，原文件不变；之后的保存写新位置', async ({}, info) => {
  const userData = info.outputPath('profile'); const path = info.outputPath('original.tblink'); const copy = info.outputPath('copy.tblink');
  await showFile(path);
  const { app, page } = await launch(userData);
  try {
    await openFile(app, page, path);
    await renameProgram(page, '另存的修改');
    await answerDialogs(app, {}, copy);
    await page.locator('.project-file-menu > summary').click();
    await page.getByRole('button', { name: '另存为…', exact: true }).click();
    await expect(unsaved(page)).toBeHidden();
    expect(await savedTitle(copy)).toBe('另存的修改');
    expect(await savedTitle(path)).toBe('原节目');
    await renameProgram(page, '另存后再改');
    await page.keyboard.press('Control+S');
    await expect(unsaved(page)).toBeHidden();
    expect(await savedTitle(copy)).toBe('另存后再改');
    expect(await savedTitle(path)).toBe('原节目');
  } finally { await closeWithoutSaving(app, page); }
});

test('打开旧格式工程：只在内存升级、标记未保存、不写回；第一次保存在原位置留下 .bak', async ({}, info) => {
  const userData = info.outputPath('profile'); const path = info.outputPath('legacy.tblink');
  const legacy: Record<string, unknown> = { ...createEmptyLinkProject('旧格式工程'), rundown: [{ id: 'song', title: '旧节目', enabled: true, notes: '', referenceMediaClips: [], cues: [], visualLayers: [] }] };
  delete legacy['mediaFolders'];
  const original = JSON.stringify(legacy);
  await writeFile(path, original);
  const before = (await stat(path)).mtimeMs;
  const { app, page } = await launch(userData);
  try {
    await openFile(app, page, path);
    await expect(page.getByText('尚未写回').first()).toBeVisible();
    await expect(unsaved(page)).toBeVisible();
    await page.waitForTimeout(2000);
    expect(await readFile(path, 'utf8')).toBe(original);
    expect((await stat(path)).mtimeMs).toBe(before);
    await page.keyboard.press('Control+S');
    await expect(unsaved(page)).toBeHidden();
    const backups = async (): Promise<string[]> => (await readdir(info.outputPath())).filter(name => name.startsWith('legacy.tblink.') && name.endsWith('.before-upgrade.bak'));
    expect(await backups()).toHaveLength(1);
    expect(await readFile(info.outputPath((await backups())[0]!), 'utf8')).toBe(original);
    expect(parseLinkProject(JSON.parse(await readFile(path, 'utf8'))).mediaFolders).toEqual([]);
    await renameProgram(page, '再次保存');
    await page.keyboard.press('Control+S');
    await expect(unsaved(page)).toBeHidden();
    expect(await backups()).toHaveLength(1);
  } finally { await closeWithoutSaving(app, page); }
});

test('播放中按 Ctrl+S 写入工程文件，播放不中断', async ({}, info) => {
  test.skip(process.env.TBLINK_NATIVE_ENGINE_TEST !== '1', '需要真实 WASAPI；不占用 MIDI 端口');
  const wav = Buffer.alloc(44 + 48000 * 4 * 10);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(192000, 28);
  wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await writeFile(info.outputPath('tone.wav'), wav);
  const sha256 = createHash('sha256').update(wav).digest('hex');
  // No visual layers: the file opens upgraded in memory, so it is unsaved before playback starts.
  const project = parseLinkProject({ ...createEmptyLinkProject('播放中保存'), playbackSource: 'internal', obsOutputMode: 'scenes',
    rundown: [{ id: 'song', title: '静音音频', referenceAudio: { assetId: 'audio', relativePath: 'tone.wav', sha256, durationMs: 10000 },
      playback: { startMs: 0, endMs: 10000, mtcOffsetMs: 0, volume: 0, endAction: 'pause', shortcut: '' } }] });
  const path = info.outputPath('playing.tblink'); const original = JSON.stringify(project);
  await writeFile(path, original);
  const profile = createDefaultIntegrationProfile(); profile.obs.autoConnectOnLaunch = false;
  profile.internalPlayer = { audioEngine: 'native', nativeAudioOutputDeviceId: 'default', audioOutputDeviceId: 'default', mtcOutputPortProfileId: null, audioSampleRate: 48000, fadeInMs: 300 };
  const { app, page } = await launch(info.outputPath('profile'));
  try {
    await page.evaluate(value => window.tbLink.saveIntegrationProfile({ profile: value }), profile); await page.reload();
    await page.waitForFunction(() => Boolean(window.tbLink));
    await page.evaluate(({ path, sha256 }) => window.tbLink.saveWaveformCache({ projectPath: path, sha256, peaks: Array.from({ length: 1200 }, () => 0) }), { path, sha256 });
    await openFile(app, page, path);
    await expect(unsaved(page)).toBeVisible();
    await page.locator('.player-transport .primary-button').click();
    await expect(page.locator('.player-transport.status-playing')).toBeVisible();
    const before = await page.evaluate(() => window.tbLink.getNativePlaybackStatus());
    expect(before).toMatchObject({ status: 'playing', audioError: null });
    await page.keyboard.press('Control+S');
    await expect(unsaved(page)).toBeHidden();
    expect(await readFile(path, 'utf8')).not.toBe(original);
    expect(parseLinkProject(JSON.parse(await readFile(path, 'utf8'))).rundown[0]!.visualLayers.length).toBeGreaterThan(0);
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => window.tbLink.getNativePlaybackStatus());
    expect(after).toMatchObject({ status: 'playing', audioError: null, underruns: 0 });
    expect(after!.positionMs).toBeGreaterThan(before!.positionMs + 400);
  } finally {
    // Playback must stop before quitting; the quit only offers 返回软件 while it runs.
    await page.getByRole('button', { name: '停止播放', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.tbLink.getNativePlaybackStatus()))?.status).toBe('stopped');
    await page.evaluate(() => window.tbLink.setRuntimeActive(false));
    await closeWithoutSaving(app, page);
  }
});
