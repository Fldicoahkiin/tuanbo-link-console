import { createServer, type Socket } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { Ma2Telnet, ma2ResponseLine, type Ma2TelnetState, type Ma2PeerValidator } from './ma2-telnet';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function peer(onLine: (line: string, socket: Socket, monitor: Socket) => void, banner?: string): Promise<{ port: number; monitorPort: number }> {
  const sockets = new Set<Socket>();
  let monitor: Socket | null = null;
  const monitorServer = createServer((socket) => { monitor = socket; sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => monitorServer.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => { for (const socket of sockets) socket.destroy(); monitorServer.close((error) => error ? reject(error) : resolve()); }));
  const server = createServer((socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    // Native onPC 3.3.4.3 says guest before login; this must not mean connected.
    socket.write(banner ?? "\u001b[37mLogged in as User 'guest'\n\r\n [Channel]>\u001b[KPlease login !\r\n\r [Channel]>\u001b[K\n");
    let buffer = '';
    socket.on('data', (data: Buffer) => {
      buffer += data.toString();
      while (buffer.includes('\r\n')) { const end = buffer.indexOf('\r\n'); const line = buffer.slice(0, end); buffer = buffer.slice(end + 2); if (monitor) onLine(line, socket, monitor); else socket.destroy(); }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => { for (const socket of sockets) socket.destroy(); server.close((error) => error ? reject(error) : resolve()); }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test listener unavailable');
  const monitorAddress = monitorServer.address();
  if (!monitorAddress || typeof monitorAddress === 'string') throw new Error('Monitor listener unavailable');
  return { port: address.port, monitorPort: monitorAddress.port };
}
function client(port: { port: number; monitorPort: number }, states: Ma2TelnetState[] = [], timeout = 300): Ma2Telnet {
  const connection = new Ma2Telnet({ host: '127.0.0.1', ...port }, (state) => states.push(state), timeout);
  cleanups.push(() => { connection.disconnect(); return Promise.resolve(); }); return connection;
}
function authenticate(line: string, socket: Socket, monitor: Socket): void {
  if (line.startsWith('Login ')) { socket.write('\r\n [Channel]>'); return; }
  const marker = /TBLINK_AUTH_[a-f0-9]{32}/.exec(line)?.[0];
  if (marker) { socket.write(`${line}\r\n [Channel]>`); monitor.write(`\r15h11m38.613s : \u001b[33m${marker}:3.3.`); monitor.write('4.3\u001b[37m\r\n'); }
}
it('登录前校验两个实际 TCP 通道，错误进程收不到凭证或命令', async () => {
  const sent: string[] = [];
  const ports = await peer(line => sent.push(line));
  const validate = vi.fn<Ma2PeerValidator>().mockRejectedValue(new Error('错误控台进程'));
  const connection = new Ma2Telnet({ host: '127.0.0.1', ...ports }, undefined, 300, validate);
  try {
    await expect(connection.connect('operator', 'test-value')).rejects.toThrow('错误控台进程');
    expect(sent).toEqual([]);
    const channels = validate.mock.calls[0]?.[0];
    expect(channels?.map(channel => channel.remotePort)).toEqual([ports.port, ports.monitorPort]);
    expect(channels?.every(channel => channel.localAddress === '127.0.0.1' && channel.localPort > 0)).toBe(true);
    expect(connection.state).toBe('disconnected');
  } finally { connection.disconnect(); }
});
it('校验完成前主动断开，不恢复登录或发送命令', async () => {
  const sent: string[] = [];
  const ports = await peer(line => sent.push(line));
  const validate = vi.fn(() => { connection.disconnect(); return Promise.resolve(); });
  const connection = new Ma2Telnet({ host: '127.0.0.1', ...ports }, undefined, 300, validate);
  await expect(connection.connect('operator', 'test-value')).rejects.toThrow('连接变了');
  expect(sent).toEqual([]);
});
it('命令与监视连接都绑定指定电脑地址', async () => {
  const sources: string[] = [];
  const ports = await peer((line, socket, monitor) => {
    sources.push(socket.remoteAddress ?? '', monitor.remoteAddress ?? '');
    authenticate(line, socket, monitor);
  });
  const connection = new Ma2Telnet({ host: '127.0.0.1', ...ports, localAddress: '127.0.0.1' });
  try { await expect(connection.connect('operator', 'test-value')).resolves.toBe('3.3.4.3'); expect(sources.length).toBeGreaterThan(0); expect(sources.every(source => source === '127.0.0.1')).toBe(true); }
  finally { connection.disconnect(); }
});
it('端口可达但没有 MA2 提示时说明阶段、端口及本机地址，不误报密码', async () => {
  const sent: string[] = [];
  const ports = await peer(line => sent.push(line), 'Other service\r\n');
  const connection = client(ports, [], 80);
  await expect(connection.connect('operator', 'test-value')).rejects.toThrow(`127.0.0.1:${ports.port} TCP 已连通（本机 127.0.0.1）`);
  expect(sent).toEqual([]);
});
it('实体控台关闭远程入口时明确提示首次开启，不发送登录或误报密码错误', async () => {
  const sent: string[] = [];
  const states: Ma2TelnetState[] = [];
  const ports = await peer((line) => sent.push(line), '\nRemote commandline disabled\n\r');
  const connection = client(ports, states);
  await expect(connection.connect('operator', 'test-value')).rejects.toThrow('控台还没开启远程连接');
  expect(sent).toEqual([]);
  expect(states).toEqual(['connecting', 'disconnected']);
});
it('只有登录后的关联响应可确认连接，支持分段帧和命令往返', async () => {
  const states: Ma2TelnetState[] = [];
  const port = await peer((line, socket, monitor) => { authenticate(line, socket, monitor); if (line === 'Test') socket.write('RESULT:ok\r\n'); });
  const connection = client(port, states);
  await expect(connection.connect('operator', 'test-value')).resolves.toBe('3.3.4.3');
  expect(states).toEqual(['connecting', 'authenticating', 'connected']);
  await expect(connection.command('Test', (text) => text.includes('RESULT:ok\r\n') ? 'ok' : null)).resolves.toBe('ok');
  connection.disconnect(); expect(connection.state).toBe('disconnected');
});
it('guest 横幅和回显的验证命令都不代表认证成功', async () => {
  const states: Ma2TelnetState[] = [];
  const port = await peer((line, socket) => socket.write(`${line}\r\nPlease login !\r\n [Channel]>`));
  const connection = client(port, states, 80);
  await expect(connection.connect('operator', 'test-value')).rejects.toThrow('登录没有成功');
  expect(states).not.toContain('connected'); expect(connection.state).toBe('disconnected');
});
it('超时取消排队请求，不重发未确认命令', async () => {
  const sent: string[] = [];
  const port = await peer((line, socket, monitor) => { sent.push(line); authenticate(line, socket, monitor); });
  const connection = client(port, [], 80);
  await connection.connect('operator', 'test-value');
  const pending = connection.command('WriteOnce', () => null);
  await Promise.all([expect(connection.command('Second', () => null)).rejects.toThrow('已取消'), expect(pending).rejects.toThrow('不会自动重试')]);
  expect(sent.filter((line) => line === 'WriteOnce')).toHaveLength(1);
  expect(sent).not.toContain('Second'); expect(connection.state).toBe('disconnected');
});
it('拒绝登录命令注入以及多行命令', async () => {
  const connection = client(await peer(authenticate));
  await expect(connection.connect('operator";Go', '')).rejects.toThrow('不支持的字符');
  await connection.connect('operator', 'test-value');
  await expect(connection.command('Go\r\nOff', () => null)).rejects.toThrow('格式');
  connection.disconnect();
});
it('远端关闭连接立即清除状态和正在等待的请求', async () => {
  const port = await peer((line, socket, monitor) => { authenticate(line, socket, monitor); if (line === 'Close') socket.end(); });
  const connection = client(port); await connection.connect('operator', 'test-value');
  await expect(connection.command('Close', () => null)).rejects.toThrow('断开');
  expect(connection.state).toBe('disconnected');
});

it('原生监视端口的时间戳结果可匹配，命令回显不会冒充结果', () => {
  const prefix = 'TBLINK_RPC_1234567890abcdef1234567890abcdef:';
  expect(ma2ResponseLine(`\r15h11m38.613s : ${prefix}ACK\r\n`, prefix)).toBe('ACK');
  expect(ma2ResponseLine(`\r11h34m19.001s    LUA : ${prefix}3.3.4.3\n\r`, prefix)).toBe('3.3.4.3');
  expect(ma2ResponseLine(`\r11h34m18.991s   ROOT : administrator 1 CMD INPUT : Lua "gma.echo('${prefix}ACK')"\r\n`, prefix)).toBeNull();
  expect(ma2ResponseLine(`\r15h11m38.613s : administrator 1 CMD INPUT : Lua "gma.echo('${prefix}ACK')"\r\n`, prefix)).toBeNull();
});

it('并发检查和数据读取按顺序发送，各自得到响应且不重发', async () => {
  const sent: string[] = [];
  const ports = await peer((line, socket, monitor) => {
    authenticate(line, socket, monitor);
    if (line.startsWith('Read')) { sent.push(line); setTimeout(() => socket.write(`RESULT:${line}\r\n`), 10); }
  });
  const connection = client(ports);
  await connection.connect('operator', 'test-value');
  const commands = ['Read1', 'Read2', 'Read3'];
  const results = await Promise.all(commands.map(line => connection.command(line, text => text.includes(`RESULT:${line}\r\n`) ? line : null)));
  expect(results).toEqual(commands); expect(sent).toEqual(commands);
});
it('主动断开取消全部未发送请求', async () => {
  const sent: string[] = [];
  const ports = await peer((line, socket, monitor) => { authenticate(line, socket, monitor); sent.push(line); });
  const connection = client(ports); await connection.connect('operator', 'test-value');
  const requests = ['First', 'Second'].map(line => connection.command(line, () => null));
  const finished = Promise.allSettled(requests);
  connection.disconnect();
  expect((await finished).every(result => result.status === 'rejected')).toBe(true);
  expect(sent).not.toContain('First'); expect(sent).not.toContain('Second');
});
