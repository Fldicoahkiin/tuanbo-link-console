import { expect, it, vi } from 'vitest';
import { ObsNativeSeek, encodeNativePrime, encodeNativeSeek } from './obs-native-seek';
it('同连接识别只发一次，断开后的迟到进程结果不能污染新连接', async () => {
  let release: (pid: number | null) => void = () => { throw new Error('测试未初始化'); };
  const find = vi.fn(() => new Promise<number | null>(resolve => { release = resolve; }));
  const seek = new ObsNativeSeek(find);
  const first = seek.prepare('ws://localhost:4455'), second = seek.prepare('ws://localhost:4455');
  const rejected = Promise.allSettled([first, second]);
  expect(find).toHaveBeenCalledTimes(1); seek.reset(); release(1234);
  expect((await rejected).every(result => result.status === 'rejected')).toBe(true);
  const current = seek.prepare('ws://localhost:4455'); release(4321); await current;
  await seek.prepare('ws://localhost:4455'); expect(find).toHaveBeenCalledTimes(2);
});
it('预热仅编码自有来源的零点准备，不能传任意位置或命令', () => {
  const packet = encodeNativePrime('团播联动台·素材·预热');
  expect(packet.readUInt32LE(4)).toBe(2); expect(packet.readBigInt64LE(8)).toBe(0n);
  const retained = encodeNativePrime('团播联动台·素材·预热', true);
  expect(retained.readUInt32LE(4)).toBe(3); expect(retained.readBigInt64LE(8)).toBe(0n);
  for (const restart of [false, true]) {
    const audio = encodeNativePrime('团播联动台·素材·音频', restart, 'audio');
    expect(audio.readUInt32LE(4)).toBe(restart ? 5 : 4);
    expect(audio.readBigInt64LE(8)).toBe(0n);
  }
  expect(() => encodeNativePrime('用户场景')).toThrow();
});
it('原生定位协议保存 UTF-8 来源和毫秒位置，拒绝非受管来源及越界输入', () => {
  const name = '团播联动台·素材·测试·来源';
  const packet = encodeNativeSeek(name, 1234);
  expect(packet.length).toBe(1040); expect(packet.readUInt32LE()).toBe(0x31534254);
  expect(packet.readBigInt64LE(8)).toBe(1234n); expect(packet.subarray(16).toString('utf8').split('\0')[0]).toBe(name);
  expect(() => encodeNativeSeek('用户摄像头', 0)).toThrow();
  expect(() => encodeNativeSeek(name, -1)).toThrow(); expect(() => encodeNativeSeek(name, NaN)).toThrow();
  expect(() => encodeNativeSeek(name + '\0其他来源', 0)).toThrow();
});
