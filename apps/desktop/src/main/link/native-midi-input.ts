import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
import { midiErrorMessage } from './midi-error';

const lineSchema = z.discriminatedUnion('kind', [
  z.object({ version: z.literal(1), kind: z.literal('opened'), requestId: z.literal(1), code: z.number().int() }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('message'), bytes: z.array(z.number().int().min(0).max(255)).min(1).max(65536),
    at100ns: z.string().regex(/^\d{1,20}$/) }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('invalid'), count: z.number().int().min(1) }).strict()
]);

export type NativeMidiMessage = { bytes: number[]; at100ns: bigint };

/** One named Windows MIDI input in its own helper process. Messages arrive in order; the helper
 * ends with an error instead of dropping any. Closing the pipe closes the port. */
export class NativeMidiInput {
  private child: ChildProcessWithoutNullStreams | null = null;
  private state: 'new' | 'opening' | 'ready' | 'failed' | 'closing' = 'new';
  private failure: Error | null = null;
  private buffer = '';
  private exited: Promise<void> | null = null;
  private exitError: Error | null = null;
  private closeTask: Promise<void> | null = null;
  private opened: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private portName = '';

  constructor(private readonly executable: string, private readonly receive: (message: NativeMidiMessage) => void,
    private readonly reportFailure: (error: Error) => void, private readonly reportInvalid: (count: number) => void = () => undefined) {}

  open(portName: string): Promise<void> {
    if (this.state !== 'new') return Promise.reject(new Error('MIDI 输入已打开、失败或关闭；必须重新打开'));
    const payload = Buffer.from(portName, 'utf8');
    if (!portName || portName.includes('\0') || portName.length > 256 || payload.length > 1024) return Promise.reject(new Error('MIDI 输入端口名称无效'));
    this.state = 'opening'; this.portName = portName;
    const header = Buffer.alloc(24);
    header.write('TBM1'); header.writeUInt32LE(1, 4); header.writeUInt32LE(1, 8); header.writeUInt32LE(payload.length, 12);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`打开 MIDI 输入超过 2 秒：${portName}`)), 2000);
      this.opened = { resolve: () => { clearTimeout(timer); resolve(); }, reject: error => { clearTimeout(timer); reject(error); } };
      this.start();
      this.child?.stdin.write(Buffer.concat([header, payload]), error => { if (error) this.fail(error); });
    });
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.state = 'closing';
    this.opened?.reject(new Error('MIDI 输入已关闭')); this.opened = null;
    this.child?.stdin.end();
    this.closeTask = this.waitForExit();
    return this.closeTask;
  }

  private start(): void {
    const child = spawn(this.executable, ['--midi-input'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.exited = new Promise(resolve => child.once('close', () => resolve()));
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data: string) => this.read(data));
    child.stderr.on('data', (data: string) => this.fail(new Error(`MIDI 输入服务：${data.slice(0, 2048)}`)));
    child.stdin.on('error', error => this.fail(error)); child.on('error', error => this.fail(error));
    child.once('close', code => {
      this.child = null;
      if (code !== 0) this.exitError = new Error(`MIDI 输入服务异常退出：${code}`);
      if (this.state !== 'closing' || this.exitError) this.fail(this.exitError ?? new Error('MIDI 输入服务意外关闭'));
    });
  }

  private read(data: string): void {
    if (this.failure || this.state === 'closing') return;
    try {
      const lines = data.split('\n');
      for (let index = 0; index < lines.length; index++) {
        this.buffer += lines[index]!;
        if (this.buffer.length > 512 * 1024) throw new Error('MIDI 输入消息超过容量');
        if (index === lines.length - 1) continue;
        const line = lineSchema.parse(JSON.parse(this.buffer)); this.buffer = '';
        if (line.kind === 'opened') {
          if (this.state !== 'opening') throw new Error('MIDI 输入重复确认打开');
          if (line.code !== 0) throw new Error(midiErrorMessage(line.code, this.portName));
          this.state = 'ready'; this.opened?.resolve(); this.opened = null;
        } else if (this.state !== 'ready') throw new Error('MIDI 输入在打开前送来消息');
        else if (line.kind === 'message') this.receive({ bytes: line.bytes, at100ns: BigInt(line.at100ns) });
        else this.reportInvalid(line.count);
      }
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    if (this.state !== 'closing') this.state = 'failed';
    this.child?.stdin.end();
    if (this.opened) { this.opened.reject(error); this.opened = null; return; }
    if (this.state !== 'closing') this.reportFailure(error);
  }

  private async waitForExit(): Promise<void> {
    if (!this.exited) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.exited, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('MIDI 输入服务未退出，保留进程，不强杀')), 5000);
      })]);
    } finally { clearTimeout(timer); }
    if (this.exitError) throw this.exitError;
  }
}
