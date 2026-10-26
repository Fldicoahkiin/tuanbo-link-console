import { createConnection, type Socket } from 'node:net';
import { findLocalObsPid } from './obs-editor-preview';
import { isPipeAccessDenied, obsPipeAccessDeniedMessage } from './obs-bridge-access';

export type ObsLiveFrame = { width: number; height: number; sequence: number; timestampNs: string; rgba: Uint8Array };

/** One renderer request acknowledges the previous frame. Never queue stale frames. */
export class ObsLivePreview {
  private socket: Socket | null = null;
  private pending = false;
  private generation = 0;
  private address: string | null = null;
  private failure: Error | null = null;
  constructor(private readonly locatePid = findLocalObsPid) {}

  close(): void { this.generation++; this.socket?.destroy(); this.socket = null; this.address = null; this.failure = null; }

  async next(address: string): Promise<ObsLiveFrame> {
    if (this.pending) throw new Error('OBS 实时预览已有未完成的帧请求');
    this.pending = true;
    try {
      if (this.address !== address) this.close();
      const generation = this.generation;
      if (this.failure) throw this.failure;
      if (!this.socket) {
        const pid = await this.locatePid(address);
        if (generation !== this.generation) throw new Error('预览请求已取消');
        if (pid === null) throw new Error('实时预览需要连接本机的 OBS');
        this.socket = createConnection(`\\\\.\\pipe\\tblink-obs-preview-${pid}`);
        this.socket.on('error', (error) => { this.failure = error; });
        this.address = address;
      } else this.socket.write(Buffer.from([1]));
      return await this.read(this.socket);
    } catch (error) { this.close(); throw error; }
    finally { this.pending = false; }
  }

  private read(socket: Socket): Promise<ObsLiveFrame> {
    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(32);
      let offset = 0;
      let expected = 32;
      const cleanup = (): void => { clearTimeout(timer); socket.off('data', data); socket.off('error', failed); socket.off('close', closed); };
      const failed = (error: Error): void => { cleanup(); reject(new Error(previewFailure(error))); };
      const closed = (): void => failed(new Error('预览连接已关闭，请确认 OBS 预览组件已加载'));
      const timer = setTimeout(() => failed(new Error('等待 OBS 画面超时')), 2000);
      const data = (chunk: Buffer): void => {
        try {
          let cursor = 0;
          while (cursor < chunk.length) {
            const count = Math.min(expected - offset, chunk.length - cursor);
            if (count <= 0) throw new Error('OBS 视频帧包含多余数据');
            chunk.copy(buffer, offset, cursor, cursor + count); offset += count; cursor += count;
            if (offset === 32 && expected === 32) {
              const header = parseObsFrameHeader(buffer);
              expected = header.length + 32;
              const frame = Buffer.allocUnsafe(expected); buffer.copy(frame); buffer = frame;
            }
          }
          if (offset !== expected || expected === 32) return;
          const header = parseObsFrameHeader(buffer);
          cleanup();
          resolve({ width: header.width, height: header.height, sequence: buffer.readUInt32LE(20), timestampNs: buffer.readBigUInt64LE(24).toString(), rgba: buffer.subarray(32) });
        } catch (error) { failed(error instanceof Error ? error : new Error(String(error))); }
      };
      socket.on('data', data); socket.once('error', failed); socket.once('close', closed);
    });
  }
}

function previewFailure(error: Error): string {
  if ('code' in error && error.code === 'ENOENT') return 'OBS 预览组件还没加载。请点“检查并修复组件”；如果 OBS 开着安全模式或禁用了这个插件，请先恢复正常。';
  if (isPipeAccessDenied(error)) return `OBS 预览不可用：${obsPipeAccessDeniedMessage}`;
  return `OBS 预览不可用：${error.message}`;
}

export function parseObsFrameHeader(buffer: Buffer): { width: number; height: number; length: number } {
  if (buffer.length < 32 || buffer.readUInt32LE(0) !== 0x31504254) throw new Error('OBS 视频帧协议不匹配');
  const width = buffer.readUInt32LE(4), height = buffer.readUInt32LE(8), length = buffer.readUInt32LE(16);
  if (width < 2 || height < 2 || width > 1920 || height > 1920 || buffer.readUInt32LE(12) !== width * 4 || length !== width * height * 4) throw new Error('OBS 视频帧尺寸无效');
  return { width, height, length };
}
