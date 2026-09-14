import { expect, it } from 'vitest';
import { encodeNativeSeek } from './obs-native-seek';
it('原生定位协议保存 UTF-8 来源和毫秒位置，拒绝非受管来源及越界输入', () => {
  const name = '团播联动台·素材·测试·来源';
  const packet = encodeNativeSeek(name, 1234);
  expect(packet.length).toBe(1040); expect(packet.readUInt32LE()).toBe(0x31534254);
  expect(packet.readBigInt64LE(8)).toBe(1234n); expect(packet.subarray(16).toString('utf8').split('\0')[0]).toBe(name);
  expect(() => encodeNativeSeek('用户摄像头', 0)).toThrow();
  expect(() => encodeNativeSeek(name, -1)).toThrow(); expect(() => encodeNativeSeek(name, NaN)).toThrow();
  expect(() => encodeNativeSeek(name + '\0其他来源', 0)).toThrow();
});
