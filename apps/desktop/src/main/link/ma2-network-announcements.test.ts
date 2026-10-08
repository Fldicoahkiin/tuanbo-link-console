import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { expect, it } from 'vitest';
import { readMa2NetworkAnnouncements } from './ma2-network-announcements';

it('取消与无网卡时不等待、不产生设备身份', async () => {
  const controller = new AbortController(); controller.abort();
  expect(await readMa2NetworkAnnouncements(['127.0.0.1'], controller.signal)).toEqual({ hosts: [], warnings: [], packets: 0 });
  expect((await readMa2NetworkAnnouncements([], new AbortController().signal)).hosts).toEqual([]);
});

it('真实 UDP 组播仅收集来源地址，退出后释放监听端口', async () => {
  const local = Object.values(networkInterfaces()).flat().find(entry => entry?.family === 'IPv4' && !entry.internal)?.address;
  if (!local) throw new Error('本机 UDP 验证需要一个 IPv4 网卡');
  const sender = createSocket('udp4');
  await new Promise<void>(resolve => sender.bind(0, local, resolve));
  const port = sender.address().port;
  const group = '236.4.0.233';
  sender.setMulticastInterface(local); sender.setMulticastLoopback(true);
  // Use a separate, OS-selected port so this test never emits MA control traffic.
  const probe = createSocket('udp4');
  await new Promise<void>(resolve => probe.bind(0, resolve));
  const receivePort = probe.address().port;
  await new Promise<void>(resolve => probe.close(resolve));
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    const listening = readMa2NetworkAnnouncements([local], new AbortController().signal, { ports: [receivePort], groups: Array.from({ length: 256 }, (_, index) => `236.4.0.${index}`), durationMs: 500 });
    timer = setInterval(() => sender.send(Buffer.from('test address observation only'), receivePort, group), 50);
    const observed = await listening;
    expect(observed.warnings).toEqual([]);
    expect(observed.hosts).toEqual([local]);
    expect(observed.packets).toBeGreaterThan(0);
    expect(port).not.toBe(receivePort);
    const released = createSocket('udp4');
    await new Promise<void>((resolve, reject) => { released.once('error', reject); released.bind(receivePort, () => released.close(resolve)); });
  } finally { clearInterval(timer); await new Promise<void>(resolve => sender.close(resolve)); }
});
