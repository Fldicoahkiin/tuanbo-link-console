import { test, expect, _electron as electron } from '@playwright/test';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';

// Operator decision 2026-10-19: when the console cannot confirm Off on quit, the
// operator chooses between returning to the app and quitting anyway.
test('退出时灯光试听未能停止：可返回软件处理，也可明确选择仍然退出', async ({}, info) => {
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
        // Goto is confirmed; Off never is, as when the console has dropped off the network.
        if (play) socket.write(`\r\n${play}:${line.includes("gma.cmd('Off ") ? 'LOST' : 'SENT'}\r\n`);
      }
    });
  });
  const listen = async (server: Server): Promise<number> => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('测试端口未就绪'); return address.port;
  };
  const network = { host: '127.0.0.1', port: await listen(command), monitorPort: await listen(monitor), username: 'test' };
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')] });
  let exited = false; app.on('close', () => { exited = true; });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.tbLink));
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
    await app.evaluate(({ dialog }) => {
      const answers = [0, 1], titles: string[] = [];
      Reflect.set(globalThis, '__quitDialogs', titles);
      dialog.showMessageBox = (...args: unknown[]) => {
        const options = args.at(-1);
        titles.push(typeof options === 'object' && options !== null && 'title' in options ? String(options.title) : '');
        return Promise.resolve({ response: answers.shift() ?? 0, checkboxChecked: false });
      };
    });
    const titles = (): Promise<string[]> => app.evaluate(() => [...(Reflect.get(globalThis, '__quitDialogs') as string[])]);
    await app.evaluate(({ app: electronApp }) => { electronApp.quit(); });
    await expect.poll(titles).toEqual(['灯光试听未能停止']);
    await page.waitForTimeout(500);
    expect(exited).toBe(false);
    await expect(page.getByRole('button', { name: '打开工程', exact: true })).toBeVisible();
    await app.evaluate(({ app: electronApp }) => { electronApp.quit(); });
    await expect.poll(() => exited, { timeout: 15_000 }).toBe(true);
  } finally {
    if (!exited) await app.close();
    for (const socket of sockets) socket.destroy();
    command.close(); monitor.close();
  }
});
