import { describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { ObsLivePreview, parseObsFrameHeader } from './obs-live-preview';

function frame(): Buffer {
  const packet = Buffer.alloc(48);
  [0x31504254, 2, 2, 8, 16, 1].forEach((value, index) => packet.writeUInt32LE(value, index * 4));
  packet.writeBigUInt64LE(1000000000n, 24); packet.fill(127, 32);
  return packet;
}
describe('OBS 原生帧协议', () => {
  it('拒绝尺寸、长度与版本错误', () => {
    expect(parseObsFrameHeader(frame())).toEqual({ width: 2, height: 2, length: 16 });
    for (const offset of [0, 4, 8, 12, 16]) { const packet = frame(); packet.writeUInt32LE(0, offset); expect(() => parseObsFrameHeader(packet)).toThrow(); }
  });
  it('处理分包，并且只有下一次读取才确认上一帧', async () => {
    const pid = process.pid + 900000;
    const path = `\\\\.\\pipe\\tblink-obs-preview-${pid}`;
    let acknowledgements = 0;
    const server = createServer((socket) => {
      const packet = frame(); socket.write(packet.subarray(0, 17)); socket.write(packet.subarray(17));
      socket.on('data', () => { acknowledgements++; socket.write(packet); });
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    const client = new ObsLivePreview(() => Promise.resolve(pid));
    try {
      const first = await client.next('ws://localhost:4457');
      expect(first.rgba.length).toBe(16); expect(first.timestampNs).toBe('1000000000');
      expect(acknowledgements).toBe(0);
      await client.next('ws://localhost:4457'); expect(acknowledgements).toBe(1);
    } finally { client.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
