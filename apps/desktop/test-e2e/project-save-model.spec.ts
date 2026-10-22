import { chmod, cp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { createEmptyLinkProject, parseLinkProject, serializeLinkProject } from '@tb/schema';

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

test('进程被强制结束后重新打开工程：提示恢复，恢复后内容回来且标记未保存，保存后副本清除', async ({}, info) => {
  const crashed = info.outputPath('crashed-profile'); const userData = info.outputPath('profile'); const path = info.outputPath('crash.tblink');
  await showFile(path);
  const first = await launch(crashed);
  await openFile(first.app, first.page, path);
  await renameProgram(first.page, '崩溃前的修改');
  await expect.poll(() => recoveryCopies(crashed)).toHaveLength(1);
  const killed = first.app.waitForEvent('close');
  first.app.process().kill('SIGKILL');
  await killed;
  expect(await savedTitle(path)).toBe('原节目');
  // A fresh profile with only the recovery copies: the restart must not reopen the
  // file by itself before the dialog answers are in place.
  await cp(join(crashed, 'link-recovery'), join(userData, 'link-recovery'), { recursive: true });

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
    await page.getByRole('button', { name: '另存为', exact: true }).click();
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
