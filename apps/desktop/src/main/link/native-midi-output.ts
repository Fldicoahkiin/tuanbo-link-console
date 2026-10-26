import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
import { midiPortBusy } from './midi-error';

const responseSchema = z.object({ version: z.literal(1), requestId: z.number().int().min(1).max(0xffffffff),
  code: z.number().int(), acceptedAt100ns: z.string().regex(/^\d{1,20}$/) }).strict();
type Pending = { id: number; bytes: Buffer; deadline: bigint; resolve: (acceptedAt100ns: bigint) => void;
  reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export type NativeMidiReceipt = { acceptedAt100ns: bigint };
/** A Windows error from the driver helper, with the port it concerns. */
export class MidiOutputFailure extends Error {
  constructor(message: string, readonly code: number, readonly portName: string) { super(message); }
  /** 5/6: the interface is gone; -2: no output carries the name (yet). */
  get portGone(): boolean { return this.code === 5 || this.code === 6 || this.code === -2; }
}

/** One port, one owned driver process, one command in flight. Queued commands
 * stay in this process so cancellation never leaves a pipe full of old Cue. */
export class NativeMidiOutput {
  private child: ChildProcessWithoutNullStreams | null = null;
  private active: Pending | null = null;
  private readonly queue: Pending[] = [];
  private state: 'new' | 'opening' | 'ready' | 'failed' | 'closing' = 'new';
  private failure: Error | null = null;
  private requestId = 0;
  private buffer = '';
  private exited: Promise<void> | null = null;
  private exitError: Error | null = null;
  private closeTask: Promise<void> | null = null;
  private portName = '';

  /** `queueLimit`: messages waiting behind the one in flight. A show's actions keep it short; the editor's
   * previews send a whole lighting state at once. */
  constructor(private readonly executable: string, private readonly reportFailure: (error: Error) => void, private readonly queueLimit = 32) {}

  async open(portName: string): Promise<void> {
    if (this.state !== 'new') throw new Error('MIDI 输出已打开、失败或关闭；必须明确准备新会话');
    const payload = Buffer.from(portName, 'utf8');
    if (!portName || portName.includes('\0') || portName.length > 256 || payload.length > 1024) throw new Error('MIDI 输出端口名称无效');
    this.state = 'opening'; this.portName = portName;
    try {
      this.start();
      await this.enqueue(1, payload, 0n, 2000);
      if (this.state !== 'opening') throw new Error('MIDI 输出准备已取消');
      this.state = 'ready';
    } catch (error) {
      const failure = toError(error); this.fail(failure); throw failure;
    }
  }

  /** Receipt confirms WinMM accepted the message, not actual light output. */
  async send(message: readonly number[], deadline100ns: bigint): Promise<NativeMidiReceipt> {
    if (this.state !== 'ready') throw this.failure ?? new Error('MIDI 输出尚未准备或已取消');
    validateMessage(message);
    const remaining = deadline100ns - now100ns();
    if (remaining <= 0n || remaining > 20_000_000n) throw new Error('MIDI 动作截止时间无效或已过期，本次未发送');
    const acceptedAt100ns = await this.enqueue(2, Buffer.from(message), deadline100ns, Math.ceil(Number(remaining) / 10000));
    return { acceptedAt100ns };
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.state = 'closing';
    this.rejectPending(new Error('MIDI 会话已取消；在途指令可能已发送，尚未发送的队列已清空'));
    this.child?.stdin.end();
    this.closeTask = this.waitForExit();
    return this.closeTask;
  }

  private enqueue(operation: number, payload: Buffer, deadline: bigint, timeoutMs: number): Promise<bigint> {
    if (this.queue.length >= this.queueLimit) return Promise.reject(new Error('MIDI 动作队列已满，本次未入队'));
    if (this.requestId === 0xffffffff) return Promise.reject(new Error('MIDI 请求编号已耗尽，请停止后重新准备'));
    const id = ++this.requestId, bytes = Buffer.alloc(24 + payload.length);
    bytes.write('TBM1'); bytes.writeUInt32LE(id, 4); bytes.writeUInt32LE(operation, 8);
    bytes.writeUInt32LE(payload.length, 12); bytes.writeBigUInt64LE(deadline, 16); payload.copy(bytes, 24);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(operation === 1
        ? 'MIDI 端口准备超过 2 秒，未参与本次播放'
        : 'MIDI 动作未在截止时间内确认；在途结果不明，已停止该通道，不自动重发')), timeoutMs);
      this.queue.push({ id, bytes, deadline, resolve, reject, timer }); this.flush();
    });
  }

  private start(): void {
    const child = spawn(this.executable, ['--midi-output'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.exited = new Promise(resolve => child.once('close', () => resolve()));
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data: string) => this.receive(data));
    child.stderr.on('data', (data: string) => this.fail(new Error(`MIDI 驱动服务：${data.slice(0, 2048)}`)));
    child.stdin.on('error', error => this.fail(error)); child.on('error', error => this.fail(error));
    child.once('close', code => {
      this.child = null;
      if (code !== 0) this.exitError = new Error(`MIDI 驱动服务异常退出：${code}`);
      if (this.state !== 'closing' || this.exitError) this.fail(this.exitError ?? new Error('MIDI 驱动服务意外关闭'));
    });
  }

  private flush(): void {
    if (this.active || this.failure || this.state === 'closing') return;
    const next = this.queue.shift(); if (!next) return;
    this.active = next;
    if (next.deadline && now100ns() >= next.deadline) {
      this.fail(new Error('MIDI 动作在队列中过期；已停止该通道，不补发')); return;
    }
    if (!this.child) { this.fail(new Error('MIDI 驱动服务不可用')); return; }
    this.child.stdin.write(next.bytes, error => { if (error) this.fail(error); });
  }

  private receive(data: string): void {
    if (this.failure || this.state === 'closing') return;
    try {
      const lines = data.split('\n');
      for (let index = 0; index < lines.length; index++) {
        this.buffer += lines[index]!;
        if (this.buffer.length > 4096) throw new Error('MIDI 响应超过容量');
        if (index === lines.length - 1) continue;
        const response = responseSchema.parse(JSON.parse(this.buffer)); this.buffer = '';
        const pending = this.active;
        if (!pending || pending.id !== response.requestId) throw new Error('MIDI 响应不属于当前请求，停止输出');
        if (response.code !== 0) throw new MidiOutputFailure(nativeError(response.code), response.code, this.portName);
        const accepted = BigInt(response.acceptedAt100ns);
        if (accepted === 0n || accepted > now100ns() + 10_000n) throw new Error('MIDI 驱动确认时间无效');
        if (pending.deadline && accepted >= pending.deadline) throw new Error('MIDI 驱动确认超过截止时间；动作可能已执行，停止该通道');
        this.active = null; clearTimeout(pending.timer); pending.resolve(accepted); this.flush();
      }
    } catch (error) { this.fail(toError(error)); }
  }

  private rejectPending(error: Error): void {
    if (this.active) { clearTimeout(this.active.timer); this.active.reject(error); this.active = null; }
    for (const pending of this.queue) { clearTimeout(pending.timer); pending.reject(error); }
    this.queue.length = 0;
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    if (this.state !== 'closing') this.state = 'failed';
    this.rejectPending(error); this.child?.stdin.end(); this.reportFailure(error);
  }

  private async waitForExit(): Promise<void> {
    if (!this.exited) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.exited, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('MIDI 驱动服务未退出，保留进程与原生缓冲区，不强杀')), 5000);
      })]);
    } finally { clearTimeout(timer); }
    if (this.exitError) throw this.exitError;
  }
}

function now100ns(): bigint { return process.hrtime.bigint() / 100n; }
function toError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
function nativeError(code: number): string {
  const reasons: Record<number, string> = { [-1]: '指令或状态无效', [-3]: '输出端口名称不唯一',
    [-4]: 'Windows 驱动等待失败', [-5]: '打开的端口身份发生变化', [-6]: '前一条 SysEx 未及时完成', [-7]: '动作已过期，未发送' };
  // The same port is opened again once it is back (authorised 2026-10-24); other failures are left to the operator.
  if (code === 5 || code === 6) return `MIDI 输出失败：接口已断开（错误码 ${code}）；同一接口重新连接后自动恢复，中断期间的动作不补发`;
  if (code === -2) return 'MIDI 输出失败：指定输出端口不存在；该接口出现后自动开始发送';
  if (midiPortBusy(code)) return `MIDI 输出失败：接口正被其他软件占用（错误码 ${code}），请关闭 P1 等正在使用它的软件；已停止该通道，不自动重试`;
  return `MIDI 输出失败：${reasons[code] ?? `Windows 错误 ${code}`}；已停止该通道，不自动重试`;
}
function validateMessage(message: readonly number[]): void {
  if (message.length < 2 || message.length > 65536 || message.some(value => !Number.isInteger(value) || value < 0 || value > 255)) throw new Error('MIDI 消息格式无效');
  const status = message[0]!, type = status & 0xf0;
  const sysex = status === 0xf0;
  // MTC quarter frame: the editor's timecode preview.
  if (status === 0xf1) { if (message.length !== 2 || message[1]! > 127) throw new Error('MIDI 消息必须是完整单条消息；不允许运行状态或混合指令'); return; }
  const valid = sysex ? message.length >= 3 && message.at(-1) === 0xf7
    : type >= 0x80 && type <= 0xe0 && message.length === (type === 0xc0 || type === 0xd0 ? 2 : 3);
  if (!valid || message.slice(1, sysex ? -1 : undefined).some(value => value > 127)) throw new Error('MIDI 消息必须是完整单条消息；不允许运行状态或混合指令');
}
