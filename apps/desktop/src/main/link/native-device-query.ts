import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { nativeDeviceResponseSchema, type NativePlaybackDevices, type NativeDeviceQueryRequest } from '@tb/schema';

type Pending = { resolve: (devices: NativePlaybackDevices) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** Reuse the query process, never its inventory. Device enumeration cannot hold
 * the playback engine's command, clock or MIDI locks. EOF is its only shutdown. */
export class NativeDeviceQuery {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<number, Pending>();
  private requestId = 0;
  private buffer = '';
  private failure: Error | null = null;
  private closing = false;
  private exited: Promise<void> | null = null;
  private closeTask: Promise<void> | null = null;
  private exitError: Error | null = null;

  constructor(private readonly executable: string, private readonly scope: NativeDeviceQueryRequest['scope'] = 'all') {}

  async reopenForPreparation(): Promise<void> {
    if (this.closing) throw new Error('设备查询服务正在关闭');
    if (!this.failure) return;
    // Only a new explicit playback preparation, or the wait for a lost timecode port, may recover a failed query.
    // Wait for the old owned process; a stuck helper must not be duplicated.
    await this.waitForExit(false);
    if (this.closing) throw new Error('设备查询服务正在关闭');
    this.failure = null; this.exitError = null; this.exited = null; this.buffer = '';
  }

  read(): Promise<NativePlaybackDevices> {
    if (this.closing) return Promise.reject(new Error('设备查询服务正在关闭'));
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending.size >= 8) return Promise.reject(new Error('设备查询队列已满；本次查询未入队'));
    if (this.requestId === 0xffffffff) return Promise.reject(new Error('设备查询编号已耗尽，请重新打开工程服务'));
    if (!this.child) this.start();
    const id = ++this.requestId, bytes = Buffer.alloc(8);
    bytes.write('TBD1'); bytes.writeUInt32LE(id, 4);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('设备查询超过 5 秒未返回；不沿用旧设备、不自动重试')), 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(bytes, error => { if (error) this.fail(error); });
    });
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closing = true;
    this.fail(new Error('设备查询已取消'));
    this.closeTask = this.waitForExit();
    return this.closeTask;
  }

  private start(): void {
    const child = spawn(this.executable, [this.scope === 'audio' ? '--audio-device-service' : '--device-service'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.exited = new Promise(resolve => child.once('close', () => resolve()));
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data: string) => this.receive(data));
    child.stderr.on('data', (data: string) => this.fail(new Error(`设备查询失败：${data.slice(0, 2048)}`)));
    child.on('error', error => this.fail(error));
    child.stdin.on('error', error => this.fail(error));
    child.once('close', code => {
      this.child = null;
      if (code !== 0) this.exitError = new Error(`设备查询进程异常退出：${code}`);
      if (!this.closing || code !== 0) this.fail(new Error(`设备查询进程已退出：${code}`));
    });
  }

  private receive(data: string): void {
    if (this.failure || this.closing) return;
    try {
      const parts = data.split('\n');
      for (let index = 0; index < parts.length; index++) {
        this.buffer += parts[index]!;
        if (this.buffer.length > 256 * 1024) throw new Error('设备查询响应超过容量');
        if (index === parts.length - 1) continue;
        const response = nativeDeviceResponseSchema.parse(JSON.parse(this.buffer)); this.buffer = '';
        const entry = this.pending.get(response.requestId);
        if (!entry) throw new Error('设备查询响应不属于当前请求');
        if (!response.ok) throw new Error('Windows 未能完整读取设备；本次清单不可用');
        this.pending.delete(response.requestId); clearTimeout(entry.timer); entry.resolve(response.devices);
      }
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }

  private fail(error: Error): void {
    if (!this.failure) this.failure = error;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(this.failure); }
    this.pending.clear(); this.child?.stdin.end();
  }

  private async waitForExit(checkExit = true): Promise<void> {
    if (!this.exited) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.exited, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('设备查询进程未退出，保留进程并报告，不强杀')), 5000);
      })]);
    } finally { clearTimeout(timer); }
    if (checkExit && this.exitError) throw this.exitError;
  }
}
