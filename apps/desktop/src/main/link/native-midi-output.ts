import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { classifyMidiCode, MidiMessageSkipped } from '@tb/core/link';
import { z } from 'zod';
import { midiPortBusy } from './midi-error';

const responseSchema = z.object({ version: z.literal(1), requestId: z.number().int().min(1).max(0xffffffff),
  code: z.number().int(), acceptedAt100ns: z.string().regex(/^\d{1,20}$/) }).strict();
type Pending = { id: number; operation: number; bytes: Buffer; deadline: bigint; resolve: (acceptedAt100ns: bigint) => void;
  reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export type NativeMidiReceipt = { acceptedAt100ns: bigint };
/** A Windows error from the driver helper, with the port it concerns. */
export class MidiOutputFailure extends Error {
  constructor(message: string, readonly code: number, readonly portName: string) { super(message); }
  /** 5/6: the interface is gone; -2: no output carries the name (yet). */
  get portGone(): boolean { return this.code === 5 || this.code === 6 || this.code === -2; }
}

/** -6 (the previous SysEx still sending) this many times in a row: the driver is stuck, the port stops. */
const STUCK_SYSEX_REPLIES = 3;
/** How long past a message's deadline the helper has to answer before the port is judged unresponsive. */
const ANSWER_GRACE_MS = 1000;

/** One port, one owned driver process, one command in flight. Queued commands
 * stay in this process so cancellation never leaves a pipe full of old Cue.
 * A message refused on its own (expired, -7; the previous SysEx still sending, -6; invalid, -1; queue full;
 * confirmed after its deadline) rejects only that send with `MidiMessageSkipped` and the next one goes on
 * (2026-11-10). The port stops only when it fails as a whole: interface gone (5/6/-2), driver not responding
 * (-4), busy, no answer in time, a stuck SysEx, or the helper exiting. */
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
  private stuckSysex = 0;

  /** `queueLimit`: messages waiting behind the one in flight. A show's actions keep it short; the editor's
   * previews send a whole lighting state at once. */
  constructor(private readonly executable: string, private readonly reportFailure: (error: Error) => void, private readonly queueLimit = 256) {}

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
    if (this.state !== 'ready') throw this.failure ?? new Error('MIDI 输出还没准备好或已取消');
    validateMessage(message);
    const remaining = deadline100ns - now100ns();
    if (remaining <= 0n) throw new MidiMessageSkipped('动作已经过了发送时间，这一条没有发送', -7);
    if (remaining > 20_000_000n) throw new MidiMessageSkipped('动作的发送时间不对，这一条没有发送', -1);
    const acceptedAt100ns = await this.enqueue(2, Buffer.from(message), deadline100ns, Math.ceil(Number(remaining) / 10000));
    return { acceptedAt100ns };
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.state = 'closing';
    this.rejectPending(new Error('MIDI 输出已取消；正在发的消息可能已经发出，还没发的已清空'));
    this.child?.stdin.end();
    this.closeTask = this.waitForExit();
    return this.closeTask;
  }

  private enqueue(operation: number, payload: Buffer, deadline: bigint, timeoutMs: number): Promise<bigint> {
    if (this.queue.length >= this.queueLimit) return Promise.reject(new MidiMessageSkipped('同一时刻要发的 MIDI 动作太多，这一条没有发送', null));
    if (this.requestId === 0xffffffff) return Promise.reject(new Error('MIDI 请求编号用完了，请停止播放后重新开始'));
    const id = ++this.requestId, bytes = Buffer.alloc(24 + payload.length);
    bytes.write('TBM1'); bytes.writeUInt32LE(id, 4); bytes.writeUInt32LE(operation, 8);
    bytes.writeUInt32LE(payload.length, 12); bytes.writeBigUInt64LE(deadline, 16); payload.copy(bytes, 24);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.expire(id), timeoutMs);
      this.queue.push({ id, operation, bytes, deadline, resolve, reject, timer }); this.flush();
    });
  }

  /** A request reached its time limit. Still waiting behind others: only it is dropped. Sent: the helper answers
   * an expired message itself (-7, -6) at its deadline, so it gets `ANSWER_GRACE_MS` more; no answer then means
   * nobody knows whether it went out, and the port stops. Opening has no grace. */
  private expire(id: number): void {
    const active = this.active;
    if (active?.id !== id) {
      const index = this.queue.findIndex(pending => pending.id === id);
      const [dropped] = index >= 0 ? this.queue.splice(index, 1) : [];
      dropped?.reject(new MidiMessageSkipped('动作等着发送时过了时间，这一条没有发送', -7));
      return;
    }
    if (active.operation === 1) { this.fail(new Error('MIDI 端口 2 秒内没有准备好，这次播放不发 MIDI')); return; }
    active.timer = setTimeout(() => this.fail(new Error('MIDI 动作没有按时确认，无法确定是否已发出；这个输出已停止，不会自动重发')), ANSWER_GRACE_MS);
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
    let next = this.queue.shift();
    // Expired while waiting behind others: only this one is dropped.
    while (next?.deadline && now100ns() >= next.deadline) {
      clearTimeout(next.timer); next.reject(new MidiMessageSkipped('动作等着发送时过了时间，这一条没有发送', -7));
      next = this.queue.shift();
    }
    if (!next) return;
    this.active = next;
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
        if (response.code !== 0) { this.refused(pending, response.code); continue; }
        this.stuckSysex = 0;
        const accepted = BigInt(response.acceptedAt100ns);
        if (accepted === 0n || accepted > now100ns() + 10_000n) throw new Error('MIDI 驱动确认时间无效');
        if (pending.deadline && accepted >= pending.deadline) {
          this.settle(pending, () => pending.reject(new MidiMessageSkipped('驱动确认晚了，这一条可能已经发出', null, true))); continue;
        }
        this.settle(pending, () => pending.resolve(accepted));
      }
    } catch (error) { this.fail(toError(error)); }
  }

  /** A non-zero code: only this message, or the whole port (output-failure.ts `classifyMidiCode`). Opening the port
   * is never only one message. */
  private refused(pending: Pending, code: number): void {
    const failure = new MidiOutputFailure(nativeError(code), code, this.portName);
    if (pending.operation !== 2 || classifyMidiCode(code) !== 'message') throw failure;
    if (code === -6 && ++this.stuckSysex >= STUCK_SYSEX_REPLIES) {
      throw new MidiOutputFailure(`MIDI 输出失败：上一条 SysEx 连续 ${STUCK_SYSEX_REPLIES} 次没有发完，接口的驱动可能卡住了。这个输出已停止，请检查接口后重新播放`, code, this.portName);
    }
    if (code !== -6) this.stuckSysex = 0;
    this.settle(pending, () => pending.reject(new MidiMessageSkipped(nativeReason(code), code)));
  }

  /** The active request has its answer: settle it and send the next one. */
  private settle(pending: Pending, done: () => void): void { this.active = null; clearTimeout(pending.timer); done(); this.flush(); }

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
        timer = setTimeout(() => reject(new Error('MIDI 驱动服务没有退出，进程保留，没有强制结束')), 5000);
      })]);
    } finally { clearTimeout(timer); }
    if (this.exitError) throw this.exitError;
  }
}

function now100ns(): bigint { return process.hrtime.bigint() / 100n; }
function toError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
const reasons: Record<number, string> = { [-1]: '指令或状态无效', [-3]: '有多个同名的输出端口',
  [-4]: 'Windows 驱动没有响应', [-5]: '打开的端口换成了别的设备', [-6]: '上一条 SysEx 没有及时发完', [-7]: '动作已过期，没有发送' };
/** Why one message was refused on its own (-7, -6, -1). */
function nativeReason(code: number): string { return `${reasons[code] ?? `Windows 错误 ${code}`}（错误码 ${code}）`; }
function nativeError(code: number): string {
  // The same port is opened again once it is back (authorised 2026-10-24); other failures are left to the operator.
  if (code === 5 || code === 6) return `MIDI 输出失败：接口断开了（错误码 ${code}）。插回同一个接口后会自动恢复，断开期间的动作不补发`;
  if (code === -2) return 'MIDI 输出失败：找不到指定的输出端口。接口接上后会自动开始发送';
  if (midiPortBusy(code)) return `MIDI 输出失败：接口正被其他软件占用（错误码 ${code}）。请关闭 P1 等正在使用它的软件；这个输出已停止，不会自动重试`;
  return `MIDI 输出失败：${reasons[code] ?? `Windows 错误 ${code}`}。这个输出已停止，不会自动重试`;
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
