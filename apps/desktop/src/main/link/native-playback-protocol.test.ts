import { expect, it } from 'vitest';
import { encodeNativePlaybackCommand, NativePlaybackEventDecoder } from './native-playback-protocol';
import { toNamespacedPath } from 'node:path';
import { nativePlaybackCommandSchema } from '@tb/schema';

it('原生协议保留 Unicode 路径、非零起点和时间码偏移', () => {
  const command = { protocol: 4, requestId: 7, generation: 3, kind: 'prepare', pcmPath: 'C:\\素材\\歌曲.pcm', pcmBaseMs: 1000, streaming: true, sampleRate: 48000, frameRate: 30, midiDevice: null, startMs: 1500, endMs: 9000, offsetMs: 480000, volume: 0.5 } as const;
  const bytes = encodeNativePlaybackCommand(command);
  expect(bytes.readUInt32LE(0)).toBe(0x34504254);
  expect(bytes.readUInt32LE(4)).toBe(bytes.length);
  expect(bytes.readUInt32LE(24)).toBe(0xffffffff);
  expect(bytes.readDoubleLE(32)).toBe(1500); expect(bytes.readDoubleLE(48)).toBe(480000);
  expect(bytes.readDoubleLE(80)).toBe(1000); expect(bytes.readUInt32LE(88)).toBe(1);
  const pathLength = bytes.readUInt32LE(72);
  expect(bytes.subarray(96, 96 + pathLength).toString('utf8')).toBe(toNamespacedPath(command.pcmPath));
  expect(bytes.readUInt32LE(76)).toBe(7);
  expect(bytes.subarray(96 + pathLength).toString('utf8')).toBe('default');
});
it('拒绝非有限值、时间码跨天、空字节和未支持帧率', () => {
  const base = { protocol: 4, requestId: 1, generation: 1, kind: 'prepare', pcmPath: 'C:\\test.pcm', sampleRate: 48000, frameRate: 30, midiDevice: null, startMs: 0, endMs: 9000, offsetMs: 480000, volume: 1 };
  for (const patch of [{ offsetMs: 86399999 }, { startMs: 9000 }, { volume: NaN }, { frameRate: 29 }, { pcmPath: 'a\0b' }, { audioDeviceId: 'a\0b' }, { protocol: 1 }]) expect(nativePlaybackCommandSchema.safeParse({ ...base, ...patch }).success).toBe(false);
});
it('时间码端口名写在设备标识之后，引擎据此核对打开的接口；29.97 掉帧和只发四分之一帧各有独立编码', () => {
  const command = { protocol: 4, requestId: 2, generation: 2, kind: 'prepare', pcmPath: 'C:\\test.pcm', streaming: true, quarterFramesOnly: true, sampleRate: 48000, frameRate: 29.97,
    midiDevice: 1, midiPortName: 'USB MIDI Interface', startMs: 0, endMs: 9000, offsetMs: 0, volume: 1 } as const;
  const bytes = encodeNativePlaybackCommand(command);
  expect(bytes.readUInt32LE(28)).toBe(2997); expect(bytes.readUInt32LE(88)).toBe(3);
  expect(bytes.readUInt32LE(92)).toBe(Buffer.byteLength(command.midiPortName));
  const tail = 96 + bytes.readUInt32LE(72) + bytes.readUInt32LE(76);
  expect(bytes.subarray(96 + bytes.readUInt32LE(72), tail).toString('utf8')).toBe('default');
  expect(bytes.subarray(tail).toString('utf8')).toBe(command.midiPortName); expect(bytes.readUInt32LE(4)).toBe(bytes.length);
  const plain = encodeNativePlaybackCommand({ ...command, streaming: false, quarterFramesOnly: false, frameRate: 25, midiDevice: null, midiPortName: undefined });
  expect(plain.readUInt32LE(28)).toBe(25); expect(plain.readUInt32LE(88)).toBe(0); expect(plain.readUInt32LE(92)).toBe(0);
  for (const patch of [{ midiPortName: undefined }, { midiDevice: null }, { midiPortName: 'a'.repeat(32) }]) expect(nativePlaybackCommandSchema.safeParse({ ...command, ...patch }).success).toBe(false);
});
it('精确端点使用独立长度字段，不把设备名或二进制尾部混入 PCM 路径', () => {
  const command = { protocol: 4, requestId: 1, generation: 1, kind: 'prepare', pcmPath: 'C:\\test.pcm', audioDeviceId: '{0.0.0.00000000}.{设备}', sampleRate: 48000, frameRate: 30, midiDevice: null, startMs: 0, endMs: 9000, offsetMs: 0, volume: 1 } as const;
  const bytes = encodeNativePlaybackCommand(command);
  expect(bytes.readUInt32LE(76)).toBe(Buffer.byteLength(command.audioDeviceId));
  expect(bytes.subarray(96 + bytes.readUInt32LE(72)).toString('utf8')).toBe(command.audioDeviceId);
});
it('淡变时间使用协议独立字段，拒绝旧协议和无效时长', () => {
  const command = { protocol: 4, requestId: 1, generation: 1, kind: 'volume', volume: 0.5, durationMs: 1500 } as const;
  expect(encodeNativePlaybackCommand(command).readDoubleLE(64)).toBe(1500);
  expect(encodeNativePlaybackCommand({ ...command, durationMs: 0 }).readDoubleLE(64)).toBe(0);
  for (const patch of [{ durationMs: -1 }, { durationMs: Infinity }, { durationMs: 30001 }, { protocol: 2 }]) expect(nativePlaybackCommandSchema.safeParse({ ...command, ...patch }).success).toBe(false);
});
it('主线程延迟后的合法响应批次不会触发单条容量限制，分片协议仍校验', () => {
  const decoder = new NativePlaybackEventDecoder();
  const line = `${JSON.stringify({ protocol: 4, kind: 'ack', requestId: 1, generation: 1, ok: true, code: 0 })}\n`;
  expect(decoder.push(line.repeat(2000))).toHaveLength(2000);
  expect(decoder.push(line.slice(0, 12))).toEqual([]);
  expect(decoder.push(line.slice(12))).toHaveLength(1);
  expect(() => decoder.push('x'.repeat(65537))).toThrow('单条响应超过容量');
  expect(() => new NativePlaybackEventDecoder().push('{"kind":"invalid"}\n')).toThrow();
});

it('MIDI 调度分阶段诊断保留实测数据，拒绝负数与额外字段', () => {
  const midiTiming = { wakeGapMs: 33.5, midiLockWaitMs: 0.2, audioLockWaitMs: 1.1, sendMs: 0.4 };
  const clock = { protocol: 4, kind: 'clock', generation: 2, state: 'playing', positionMs: 1234, qpc100ns: '100000',
    clockFrequency: 48000, sampleRate: 48000, underruns: 0, midiSent: 10, midiError: -1, midiInterruptions: 0, midiInterruption: 0, midiReopens: 0, midiReopenResult: 0, audioError: 0,
    maxMidiLatenessMs: 33.5, bufferedFrames: 1000, gain: 1, midiTiming,
    analysis: { fftSize: 2048, peaks: [0, 0], spectrum: Array.from({ length: 1024 }, () => 0) } };
  const events = new NativePlaybackEventDecoder().push(`${JSON.stringify(clock)}\n`);
  expect(events[0]).toMatchObject({ midiTiming, midiError: -1 });
  for (const patch of [{ wakeGapMs: -1 }, { hiddenRetry: true }]) {
    expect(() => new NativePlaybackEventDecoder().push(`${JSON.stringify({ ...clock, midiTiming: { ...midiTiming, ...patch } })}\n`)).toThrow();
  }
});
it('重新打开时间码端口：设备序号和端口名称分别写入，名称不超过 Windows 端口名长度', () => {
  const command = { protocol: 4, requestId: 9, generation: 4, kind: 'reopen-mtc', midiDevice: 6, midiPortName: '团播联动台 P1 MTC' } as const;
  const bytes = encodeNativePlaybackCommand(command);
  expect(bytes.readUInt32LE(16)).toBe(9); expect(bytes.readUInt32LE(24)).toBe(6);
  expect(bytes.readUInt32LE(72)).toBe(0); expect(bytes.readUInt32LE(76)).toBe(Buffer.byteLength(command.midiPortName));
  expect(bytes.subarray(96).toString('utf8')).toBe(command.midiPortName); expect(bytes.readUInt32LE(4)).toBe(bytes.length);
  for (const patch of [{ midiPortName: '' }, { midiPortName: 'a'.repeat(32) }, { midiDevice: 65536 }]) expect(nativePlaybackCommandSchema.safeParse({ ...command, ...patch }).success).toBe(false);
});
