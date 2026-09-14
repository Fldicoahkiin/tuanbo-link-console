import { createConnection } from 'node:net';
import { findLocalObsPid } from './obs-editor-preview';

export class ObsNativeSeek {
  private location: { address: string; pid: number } | null = null;
  reset(): void { this.location = null; }
  async prepare(address: string): Promise<void> {
    if (this.location?.address !== address) {
      const pid = await findLocalObsPid(address);
      if (pid === null) throw new Error('原生定位只支持本机 OBS');
      this.location = { address, pid };
    }
  }
  async seek(address: string, inputName: string, positionMs: number): Promise<void> {
    await this.prepare(address);
    const packet = encodeNativeSeek(inputName, positionMs);
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(`\\\\.\\pipe\\tblink-obs-seek-${this.location!.pid}`);
      const response = Buffer.alloc(4); let offset = 0;
      const finish = (error?: Error): void => { clearTimeout(timer); socket.destroy(); if (error) reject(error); else resolve(); };
      const timer = setTimeout(() => finish(new Error('OBS 原生定位超时')), 2000);
      socket.on('error', (error) => finish(new Error(`OBS 原生定位不可用，请确认已加载新版插件：${error.message}`)));
      socket.once('connect', () => socket.write(packet));
      socket.on('data', (chunk: Buffer) => {
        const size = Math.min(4 - offset, chunk.length); chunk.copy(response, offset, 0, size); offset += size;
        if (offset === 4) { const result = response.readUInt32LE(); finish(result ? new Error(`OBS 拒绝原生定位，错误码 ${result}`) : undefined); }
      });
      socket.on('end', () => { if (offset < 4) finish(new Error('OBS 原生定位连接提前关闭')); });
    });
  }
}
export function encodeNativeSeek(inputName: string, positionMs: number): Buffer {
  if (!inputName.startsWith('团播联动台·素材·') || inputName.includes('\0') || Buffer.byteLength(inputName) > 1023) throw new Error('原生定位来源名称不合法');
  if (!Number.isSafeInteger(positionMs) || positionMs < 0 || positionMs > 86400000) throw new Error('原生定位位置不合法');
  const packet = Buffer.alloc(1040); packet.writeUInt32LE(0x31534254); packet.writeUInt32LE(1, 4);
  packet.writeBigInt64LE(BigInt(positionMs), 8); packet.write(inputName, 16, 'utf8'); return packet;
}
