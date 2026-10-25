import { createConnection, type Socket } from 'node:net';
import { uptime } from 'node:os';
import type { BeautyTarget, BeautyComparisonFrame } from '@tb/schema';
import { beautyPipeAccessDeniedMessage, isPipeAccessDenied } from './obs-bridge-access';

export function parseBeautyComparisonHeader(buffer: Buffer): { width: number; height: number; length: number; sequence: number; timestampMs: number } {
  if (buffer.length < 32 || buffer.readUInt32LE(0) !== 0x31434254) throw new Error('美颜对比帧协议不匹配');
  const width = buffer.readUInt32LE(4), height = buffer.readUInt32LE(8), length = buffer.readUInt32LE(16);
  if (!width || !height || width > 640 || height > 640 || buffer.readUInt32LE(12) !== width * 4 || length !== width * height * 4)
    throw new Error('美颜对比帧尺寸无效');
  const sequence = buffer.readUInt32LE(20), timestamp = buffer.readBigUInt64LE(24);
  if (!sequence || timestamp === 0n || timestamp > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('美颜对比帧时间或序号无效');
  return { width, height, length, sequence, timestampMs: Number(timestamp) };
}

export class BeautyComparison {
  private socket: Socket | null = null;
  private target = '';
  private pending = false;
  private generation = 0;
  private failure: Error | null = null;
  private sequence = 0;
  constructor(private readonly locate: (target: BeautyTarget) => Promise<string>, private readonly now = (): number => Math.floor(uptime() * 1000)) {}

  close(): void { this.generation++; this.socket?.destroy(); this.socket = null; this.target = ''; this.failure = null; this.sequence = 0; }

  async next(target: BeautyTarget): Promise<BeautyComparisonFrame> {
    if (this.pending) throw new Error('美颜对比已有未完成请求');
    this.pending = true;
    let generation = this.generation;
    try {
      const key = JSON.stringify(target);
      if (this.target && this.target !== key) this.close();
      if (this.failure) throw this.failure;
      this.target = key;
      generation = this.generation;
      const acknowledge = this.socket !== null;
      if (!this.socket) {
        const path = await this.locate(target);
        if (generation !== this.generation) throw new Error('美颜对比请求已取消');
        if (!/^\\\\\.\\pipe\\tblink-beauty-compare-\d+-\d+$/.test(path)) throw new Error('美颜对比通道无效');
        this.socket = createConnection(path);
        this.socket.on('error', error => { if (generation === this.generation) this.failure = error; });
      }
      const frame = await this.read(this.socket, acknowledge);
      if (generation !== this.generation) throw new Error('美颜对比请求已取消');
      const age = this.now() - frame.timestampMs;
      if (age < -100 || age > 500 || frame.sequence <= this.sequence) throw new Error('美颜对比帧已过期或顺序异常，请重新打开对比');
      this.sequence = frame.sequence;
      return frame;
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      if (generation === this.generation) { this.socket?.destroy(); this.socket = null; this.failure = error; }
      throw error;
    } finally { this.pending = false; }
  }

  private read(socket: Socket, acknowledge: boolean): Promise<BeautyComparisonFrame> {
    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(32), offset = 0, expected = 32;
      const cleanup = (): void => { clearTimeout(timer); socket.off('data', data); socket.off('error', fail); socket.off('close', closed); };
      const fail = (error: Error): void => { cleanup(); reject(isPipeAccessDenied(error) ? new Error(`美颜对比不可用：${beautyPipeAccessDeniedMessage}`, { cause: error }) : error); };
      const closed = (): void => fail(new Error('美颜对比通道已关闭，请确认来源可见且滤镜启用'));
      const data = (chunk: Buffer): void => {
        try {
          let cursor = 0;
          while (cursor < chunk.length) {
            const count = Math.min(expected - offset, chunk.length - cursor);
            if (count <= 0) throw new Error('美颜对比包含多余数据');
            chunk.copy(buffer, offset, cursor, cursor + count); offset += count; cursor += count;
            if (offset === 32 && expected === 32) {
              const header = parseBeautyComparisonHeader(buffer); expected = 32 + header.length * 2;
              const packet = Buffer.allocUnsafe(expected); buffer.copy(packet); buffer = packet;
            }
          }
          if (offset !== expected || expected === 32) return;
          const header = parseBeautyComparisonHeader(buffer);
          cleanup(); resolve({ width: header.width, height: header.height, sequence: header.sequence, timestampMs: header.timestampMs,
            original: buffer.subarray(32, 32 + header.length), processed: buffer.subarray(32 + header.length) });
        } catch (reason) { fail(reason instanceof Error ? reason : new Error(String(reason))); }
      };
      const timer = setTimeout(() => fail(new Error('等待美颜对比画面超时')), 2000);
      socket.on('data', data); socket.once('error', fail); socket.once('close', closed);
      if (acknowledge) socket.write(Buffer.from([1]));
    });
  }
}
