import { createConnection } from 'node:net';
import { findLocalObsPid } from './obs-editor-preview';
import { isPipeAccessDenied, obsPipeAccessDeniedMessage } from './obs-bridge-access';

export class ObsNativeSeek {
  private location: { address: string; pid: number } | null = null;
  private pending: { address: string; promise: Promise<void> } | null = null;
  private epoch = 0;
  constructor(private readonly findPid = findLocalObsPid) {}
  reset(): void { this.epoch++; this.location = null; this.pending = null; }
  async prepare(address: string): Promise<void> {
    if (this.location?.address === address) return;
    if (this.pending?.address === address) return this.pending.promise;
    const epoch = ++this.epoch; this.location = null;
    const operation = this.findPid(address).then(pid => {
      if (epoch !== this.epoch) throw new Error('OBS 连接识别已取消');
      if (pid === null) throw new Error('画面定位只支持本机的 OBS');
      this.location = { address, pid };
    });
    this.pending = { address, promise: operation };
    try { await operation; } finally { if (this.pending?.promise === operation) this.pending = null; }
  }
  async seek(address: string, inputName: string, positionMs: number): Promise<void> {
    return this.send(address, encodeNativeSeek(inputName, positionMs));
  }
  async prime(address: string, inputName: string, restartRetained = false, kind: 'audio' | 'video' = 'video'): Promise<void> {
    return this.send(address, encodeNativePrime(inputName, restartRetained, kind));
  }
  private async send(address: string, packet: Buffer): Promise<void> {
    await this.prepare(address);
    const location = this.location, epoch = this.epoch;
    if (!location || location.address !== address) throw new Error('OBS 连接已更换');
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(`\\\\.\\pipe\\tblink-obs-seek-${location.pid}`);
      const response = Buffer.alloc(4); let offset = 0;
      const finish = (error?: Error): void => { clearTimeout(timer); socket.destroy(); if (error) reject(error); else resolve(); };
      const timer = setTimeout(() => finish(new Error('OBS 画面定位超时')), 2000);
      socket.on('error', (error) => finish(new Error(isPipeAccessDenied(error) ? `OBS 画面定位不可用：${obsPipeAccessDeniedMessage}` : `OBS 画面定位不可用，请确认已加载新版组件：${error.message}`)));
      socket.once('connect', () => { if (epoch !== this.epoch) finish(new Error('OBS 请求已取消，还没发送')); else socket.write(packet); });
      socket.on('data', (chunk: Buffer) => {
        if (epoch !== this.epoch) { finish(new Error('OBS 请求过程中连接变了，请检查 OBS 画面')); return; }
        const size = Math.min(4 - offset, chunk.length); chunk.copy(response, offset, 0, size); offset += size;
        if (offset === 4) { const result = response.readUInt32LE(); finish(result ? new Error(`OBS 拒绝了画面定位，错误码 ${result}`) : undefined); }
      });
      socket.on('end', () => { if (offset < 4) finish(new Error('OBS 画面定位连接提前关闭了')); });
    });
  }
}
export function encodeNativePrime(inputName: string, restartRetained = false, kind: 'audio' | 'video' = 'video'): Buffer {
  if (kind !== 'audio' && kind !== 'video') throw new Error('原生预热素材类型不合法');
  const packet = encodeNativeSeek(inputName, 0);
  packet.writeUInt32LE((kind === 'audio' ? 4 : 2) + (restartRetained ? 1 : 0), 4); return packet;
}
export function encodeNativeSeek(inputName: string, positionMs: number): Buffer {
  if (!inputName.startsWith('团播联动台·素材·') || inputName.includes('\0') || Buffer.byteLength(inputName) > 1023) throw new Error('原生定位来源名称不合法');
  if (!Number.isSafeInteger(positionMs) || positionMs < 0 || positionMs > 86400000) throw new Error('原生定位位置不合法');
  const packet = Buffer.alloc(1040); packet.writeUInt32LE(0x31534254); packet.writeUInt32LE(1, 4);
  packet.writeBigInt64LE(BigInt(positionMs), 8); packet.write(inputName, 16, 'utf8'); return packet;
}
