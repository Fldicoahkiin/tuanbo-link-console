import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { nativePlaybackDevicesSchema, type NativePlaybackDevices, type NativePlaybackCommand, type NativePlaybackEvent } from '@tb/schema';
import { encodeNativePlaybackCommand, NativePlaybackEventDecoder } from './native-playback-protocol';

type Pending = { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; generation: number };
export type NativeClockState = Extract<NativePlaybackEvent, { kind: 'clock' }>['state'];

export function readNativePlaybackDevices(executable: string): Promise<NativePlaybackDevices> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--devices'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let data = '', errors = '', settled = false;
    const fail = (error: Error): void => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } };
    const timer = setTimeout(() => fail(new Error('Windows 音频/MIDI 设备枚举未返回，保留查询进程，不强杀或自动重试')), 5000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (part: string) => {
      if (settled) return;
      if (data.length + part.length > 256 * 1024) { fail(new Error('音频设备列表超过容量')); return; }
      data += part;
    });
    child.stderr.on('data', (part: string) => { errors = (errors + part).slice(-4096); });
    child.on('error', fail);
    child.on('close', code => {
      if (settled) return;
      if (code !== 0 || errors) { fail(new Error(`读取 Windows 音频设备失败：${code} ${errors}`)); return; }
      try {
        const devices = nativePlaybackDevicesSchema.parse(JSON.parse(data));
        settled = true; clearTimeout(timer); resolve(devices);
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    });
  });
}
export class NativePlaybackClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<number, Pending>();
  private decoder = new NativePlaybackEventDecoder();
  private closing = false;
  private exited: Promise<void> | null = null;
  private exitError: Error | null = null;
  private ready: Extract<NativePlaybackEvent, { kind: 'ready' }> | null = null;
  private lastClock: Extract<NativePlaybackEvent, { kind: 'clock' }> | null = null;
  private terminalError: Error | null = null;
  private clockReceivedAt = 0;
  private clockWatch: ReturnType<typeof setInterval> | null = null;
  private clockCheck: ReturnType<typeof setImmediate> | null = null;

  constructor(private readonly executable: string, private readonly changed: (event: NativePlaybackEvent) => void,
    private readonly failed: (error: Error) => void) {}
  get clock(): Extract<NativePlaybackEvent, { kind: 'clock' }> | null { return this.lastClock; }
  get identity(): Extract<NativePlaybackEvent, { kind: 'ready' }> | null { return this.ready; }

  async start(): Promise<void> {
    if (this.child) throw new Error('播放引擎已经启动');
    this.closing = false; this.exitError = null; this.decoder = new NativePlaybackEventDecoder(); this.ready = null; this.lastClock = null;
    this.terminalError = null; this.clearClockWatch();
    const child = spawn(this.executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.exited = new Promise(resolve => child.once('close', () => resolve()));
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data: string) => this.receive(data));
    child.stderr.on('data', (data: string) => this.fail(new Error(`播放引擎诊断：${data.slice(0, 2048)}`)));
    child.on('error', error => this.fail(error));
    child.stdin.on('error', error => this.fail(error));
    child.once('close', (code, signal) => {
      this.clearClockWatch();
      this.child = null; this.ready = null; this.lastClock = null;
      const error = new Error(`播放引擎已退出：${code ?? signal ?? '未知原因'}`);
      // An exit nobody asked for is reported once, below; closing the dead client
      // afterwards must not fail again, or the next song could never start.
      if (code !== 0 && this.closing) this.exitError = error;
      for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
      this.pending.clear();
      if (!this.closing && !this.terminalError) this.fail(error);
    });
    const deadline = Date.now() + 5000;
    while (!this.ready && this.child && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    if (!this.ready) { child.stdin.end(); throw new Error('播放引擎未完成启动握手'); }
  }

  command(command: NativePlaybackCommand): Promise<void> {
    const bytes = encodeNativePlaybackCommand(command);
    const child = this.child;
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (!child || !this.ready || this.closing) return Promise.reject(new Error('播放引擎未就绪'));
    if (this.pending.size >= 16 || this.pending.has(command.requestId)) return Promise.reject(new Error('播放请求重复或队列已满'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.requestId);
        const error = new Error('播放引擎未确认操作；结果不明，不能自动重发'); reject(error); this.fail(error);
      }, command.kind === 'prepare' ? 10000 : 6000);
      this.pending.set(command.requestId, { resolve, reject, timer, generation: command.generation });
      child.stdin.write(bytes, error => { if (error) this.fail(error); });
    });
  }

  /** The first device clock that shows `generation` in one of the states its operation ends in.
   * A clock that still shows the state from before the operation is never taken as its result. */
  async readClock(generation: number, settled: readonly NativeClockState[]): Promise<Extract<NativePlaybackEvent, { kind: 'clock' }>> {
    const deadline = Date.now() + 1000;
    while (this.child && !this.closing && Date.now() < deadline) {
      if (this.terminalError) throw this.terminalError;
      if (this.lastClock?.generation === generation && settled.includes(this.lastClock.state)) return this.lastClock;
      if (this.lastClock && this.lastClock.generation > generation) throw new Error('播放时钟已属于更新的操作');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const error = new Error('播放操作缺少实际设备时钟确认，停止本次输出');
    this.fail(error); throw error;
  }

  async close(): Promise<void> {
    this.closing = true;
    this.clearClockWatch();
    this.child?.stdin.end();
    const exited = this.exited;
    if (!exited) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([exited, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('播放引擎未正常退出，保留进程并报告，不强杀')), 5000); })]); }
    finally { clearTimeout(timer); }
    if (this.exitError) throw this.exitError;
  }

  private receive(data: string): void {
    if (this.terminalError) return;
    try {
      for (const event of this.decoder.push(data)) {
        if (event.kind === 'ready') {
          if (this.ready || event.pid !== this.child?.pid) throw new Error('播放引擎实例身份不一致');
          this.ready = event;
        }
        if (event.kind === 'clock') {
          this.lastClock = event; this.clockReceivedAt = performance.now();
          if (event.state !== 'playing') this.clearClockWatch();
          else if (!this.clockWatch && !this.closing) this.clockWatch = setInterval(() => {
            if (performance.now() - this.clockReceivedAt < 1000 || this.clockCheck) return;
            // Let the I/O poll drain telemetry already waiting after a host stall.
            // A healthy device must not be stopped merely because JS was busy.
            this.clockCheck = setImmediate(() => {
              this.clockCheck = null;
              if (!this.closing && this.lastClock?.state === 'playing' && performance.now() - this.clockReceivedAt >= 1000) {
                this.fail(new Error('正式播放设备状态超过 1 秒未更新，停止该会话；不会沿用旧位置或自动恢复'));
              }
            });
          }, 250);
        }
        if (event.kind === 'ack') {
          const entry = this.pending.get(event.requestId);
          if (!entry) continue;
          this.pending.delete(event.requestId); clearTimeout(entry.timer);
          if (entry.generation !== event.generation) entry.reject(new Error('播放引擎确认的会话不一致'));
          else if (!event.ok) entry.reject(new Error(`播放引擎操作失败：${event.code}`));
          else entry.resolve();
        }
        this.changed(event);
      }
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }
  private fail(error: Error): void {
    if (this.terminalError) return;
    this.terminalError = error; this.clearClockWatch(); this.lastClock = null;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear(); this.failed(error); this.child?.stdin.end();
  }
  private clearClockWatch(): void {
    if (this.clockWatch) clearInterval(this.clockWatch);
    if (this.clockCheck) clearImmediate(this.clockCheck);
    this.clockWatch = null; this.clockCheck = null;
  }
}
