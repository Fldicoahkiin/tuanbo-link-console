import { createServer, type Socket } from 'node:net';
import { expect, it } from 'vitest';
import { BeautyComparison, parseBeautyComparisonHeader } from './beauty-comparison';

const target = { sourceName: '机位', filterName: '美颜' };
let serial = 0;
function packet(sequence = 1, timestamp = 990): Buffer {
  const bytes = Buffer.alloc(64);
  [0x31434254, 2, 2, 8, 16, sequence].forEach((value, index) => bytes.writeUInt32LE(value, index * 4));
  bytes.writeBigUInt64LE(BigInt(timestamp), 24); bytes.fill(80, 32, 48); bytes.fill(120, 48); return bytes;
}
async function serve(connection: (socket: Socket) => void, check: (client: BeautyComparison) => Promise<void>): Promise<void> {
  const path = `\\\\.\\pipe\\tblink-beauty-compare-${process.pid + 900000}-${++serial}`;
  const server = createServer(connection);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  const client = new BeautyComparison(() => Promise.resolve(path), () => 1000);
  try { await check(client); }
  finally { client.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

it('严格限制双图长度、尺寸、序号与时间，分配前拒绝非法头部', () => {
  expect(parseBeautyComparisonHeader(packet())).toEqual({ width: 2, height: 2, length: 16, sequence: 1, timestampMs: 990 });
  for (const offset of [0, 4, 8, 12, 16, 20, 24]) {
    const bytes = packet(); bytes.writeUInt32LE(0, offset); expect(() => parseBeautyComparisonHeader(bytes)).toThrow();
  }
  const large = packet(); large.writeUInt32LE(0xffffffff, 16); expect(() => parseBeautyComparisonHeader(large)).toThrow('尺寸');
});

it('分包合并，原图与处理图保持同帧，按需确认下一帧', async () => {
  let acknowledgements = 0;
  await serve(socket => {
    const bytes = packet(); socket.write(bytes.subarray(0, 11)); socket.write(bytes.subarray(11));
    socket.on('data', data => { expect(data).toEqual(Buffer.from([1])); acknowledgements++; socket.write(packet(2)); });
  }, async client => {
    const first = await client.next(target);
    expect(first.original).toEqual(Buffer.alloc(16, 80)); expect(first.processed).toEqual(Buffer.alloc(16, 120));
    expect(acknowledgements).toBe(0);
    expect((await client.next(target)).sequence).toBe(2); expect(acknowledgements).toBe(1);
  });
});

it('过期帧错误锁定，不偷偷重连；明确关闭后才可重开', async () => {
  let connections = 0;
  await serve(socket => { connections++; socket.write(packet(1, connections === 1 ? 1 : 990)); }, async client => {
    await expect(client.next(target)).rejects.toThrow('过期');
    await expect(client.next(target)).rejects.toThrow('过期'); expect(connections).toBe(1);
    client.close(); expect((await client.next(target)).sequence).toBe(1); expect(connections).toBe(2);
  });
});

it('拒绝重复帧，并发读取被阻止', async () => {
  await serve(socket => { socket.write(packet()); socket.on('data', () => socket.write(packet())); }, async client => {
    const first = client.next(target);
    await expect(client.next(target)).rejects.toThrow('未完成'); await first;
    await expect(client.next(target)).rejects.toThrow('顺序异常');
  });
});

it('关闭会取消尚未解析的来源，旧请求不能重新打开管道', async () => {
  let release: ((path: string) => void) | undefined;
  const client = new BeautyComparison(() => new Promise<string>(resolve => { release = resolve; }));
  const reading = client.next(target); client.close(); release?.('\\\\.\\pipe\\tblink-beauty-compare-1-1');
  await expect(reading).rejects.toThrow('取消');
});
