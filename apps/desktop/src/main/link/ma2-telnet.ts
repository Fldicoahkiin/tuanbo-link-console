import { createConnection, isIP, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

export type Ma2NetworkAddress = { host: string; port: number; monitorPort: number };
export type Ma2TelnetState = 'disconnected' | 'connecting' | 'authenticating' | 'connected';
type Stream = { socket: Socket; decoder: StringDecoder; buffer: string; negotiation: 'data' | 'iac' | 'option' | 'sub' | 'sub-iac'; optionCommand: number };

type Waiter = { match: (text: string) => string | null; resolve: (value: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** Native MA2 Telnet, not the local onPC mailbox. Never replay a command. */
export class Ma2Telnet {
  private socket: Socket | null = null;
  private waiter: Waiter | null = null;
  private streams: Stream[] = [];
  private current: Ma2TelnetState = 'disconnected';
  private connecting = false;
  constructor(private readonly address: Ma2NetworkAddress, private readonly onState: (state: Ma2TelnetState) => void = () => undefined, private readonly timeoutMs = 5000) {
    if (!isIP(address.host) || [address.port, address.monitorPort].some((port) => !Number.isInteger(port) || port < 1 || port > 65535) || address.port === address.monitorPort) throw new Error('请填写有效的控台 IP 地址和端口');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('MA2 连接超时设置无效');
  }
  get state(): Ma2TelnetState { return this.current; }
  private setState(state: Ma2TelnetState): void { this.current = state; this.onState(state); }
  async connect(username: string, password: string): Promise<string> {
    if (this.socket || this.connecting) throw new Error('MA2 正在连接或已连接');
    // MA command quoting does not document embedded quotes or escapes.
    if (!username.trim() || [username, password].some((value) => /["\\\u0000-\u001f\u007f]/.test(value) || value.length > 256)) throw new Error('MA2 用户名或密码包含不支持的字符');
    this.connecting = true;
    this.streams = [];
    this.setState('connecting');
    try {
      let monitorReady = false;
      for (const [index, port] of [this.address.port, this.address.monitorPort].entries()) {
        const socket = createConnection({ host: this.address.host, port });
        if (index === 0) this.socket = socket;
        const stream: Stream = { socket, decoder: new StringDecoder('utf8'), buffer: '', negotiation: 'data', optionCommand: 0 };
        this.streams.push(stream);
        socket.setNoDelay(true); socket.setKeepAlive(true, 5000);
        socket.on('connect', () => { if (index === 1) { monitorReady = true; this.check(); } });
        socket.on('data', (data: Buffer) => { if (this.streams.includes(stream)) this.receive(stream, data); });
        socket.on('error', (error: NodeJS.ErrnoException) => { if (this.streams.includes(stream)) this.fail(new Error(`MA2 ${index === 0 ? '命令' : '监视'}端口连接失败：${this.address.host}:${port}（${error.code ?? '网络错误'}）。请检查 IP、端口和控台 Telnet 设置`)); });
        socket.on('close', () => { if (this.streams.includes(stream)) this.fail(new Error('MA2 网络连接已断开；未确认的操作不会自动重试')); });
      }
      await this.waitFor((text) => monitorReady && /\[[^\r\n]*\]>/.test(text) ? 'ready' : null);
      this.setState('authenticating');
      await this.command(`Login "${username}" "${password}"`, (text) => /\[[^\r\n]*\]>/.test(text) ? 'prompt' : null);
      // The native banner says "guest" even before login: only an executed
      // correlated Lua response proves command access. Echoed input cannot match.
      const marker = `TBLINK_AUTH_${randomBytes(16).toString('hex')}`;
      const version = await this.command(`Lua "gma.echo('${marker}:'..tostring(gma.show.getvar('VERSION')))"`, (text) => {
        const value = ma2ResponseLine(text, `${marker}:`);
        return value && /^\d+(?:\.\d+){1,3}$/.test(value) ? value : null;
      });
      this.setState('connected');
      return version;
    } catch (error) {
      this.disconnect();
      throw error;
    } finally { this.connecting = false; }
  }
  async command(line: string, match: (response: string) => string | null): Promise<string> {
    if (!this.socket || (this.current !== 'connected' && this.current !== 'authenticating')) throw new Error('MA2 尚未连接');
    if (/[\r\n\u0000]/.test(line) || Buffer.byteLength(line) > 4096) throw new Error('MA2 网络命令格式或长度无效');
    if (this.waiter) throw new Error('MA2 网络请求尚未完成');
    for (const stream of this.streams) stream.buffer = '';
    const response = this.waitFor(match);
    this.socket.write(`${line}\r\n`);
    return response;
  }
  disconnect(): void { this.fail(new Error('MA2 连接已关闭；未确认的操作不会自动重试')); }
  private fail(error: Error): void {
    this.socket = null;
    const streams = this.streams; this.streams = [];
    for (const stream of streams) stream.socket.destroy();
    if (this.waiter) { clearTimeout(this.waiter.timer); this.waiter.reject(error); this.waiter = null; }
    if (this.current !== 'disconnected') this.setState('disconnected');
  }
  private waitFor(match: Waiter['match']): Promise<string> {
    if (this.waiter) return Promise.reject(new Error('MA2 网络请求尚未完成'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(this.current === 'authenticating' ? 'MA2 登录未确认，请检查用户、密码及远程登录权限' : 'MA2 响应超时；操作未确认，不会自动重试')), this.timeoutMs);
      this.waiter = { match, resolve, reject, timer };
      this.check();
    });
  }
  private check(): void {
    const waiter = this.waiter;
    if (!waiter) return;
    try {
      const result = this.streams.map((stream) => waiter.match(stream.buffer)).find((value) => value !== null) ?? null;
      if (result === null) return;
      clearTimeout(waiter.timer); this.waiter = null; waiter.resolve(result);
    } catch { this.fail(new Error('MA2 网络响应格式无效')); }
  }
  private receive(stream: Stream, data: Buffer): void {
    const output: number[] = [];
    for (const byte of data) {
      switch (stream.negotiation) {
        case 'data': if (byte === 255) stream.negotiation = 'iac'; else output.push(byte); break;
        case 'iac':
          if (byte === 255) { output.push(byte); stream.negotiation = 'data'; }
          else if (byte >= 251 && byte <= 254) { stream.optionCommand = byte; stream.negotiation = 'option'; }
          else stream.negotiation = byte === 250 ? 'sub' : 'data';
          break;
        case 'option':
          if (stream.optionCommand === 251 || stream.optionCommand === 253) stream.socket.write(Buffer.from([255, stream.optionCommand === 251 ? 254 : 252, byte]));
          stream.negotiation = 'data'; break;
        case 'sub': if (byte === 255) stream.negotiation = 'sub-iac'; break;
        case 'sub-iac': stream.negotiation = byte === 240 ? 'data' : 'sub'; break;
      }
    }
    stream.buffer += stream.decoder.write(Buffer.from(output));
    if (!this.waiter && stream.buffer.length > 65536) stream.buffer = stream.buffer.slice(-32768);
    if (stream.buffer.length > 1024 * 1024) { this.fail(new Error('MA2 网络响应超过限制')); return; }
    stream.buffer = stream.buffer.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
    this.check();
  }
}

/** Native monitor lines have a timestamp; command echo must never match a result. */
export function ma2ResponseLine(text: string, prefix: string): string | null {
  if (!/^[A-Z0-9_a-f:]+$/.test(prefix)) throw new Error('Invalid response prefix');
  return new RegExp(`(?:^|[\\r\\n])(?:[0-9]+h[0-9]+m[0-9]+\\.[0-9]+s : )?${prefix}([^\\r\\n]+)\\r?\\n`).exec(text)?.[1] ?? null;
}
