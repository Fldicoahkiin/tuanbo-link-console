import { expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ffmpeg from 'ffmpeg-static';
import type { NativePlayerPrepare, NativePlayerStatus } from '@tb/schema';
import { NativeAudioCache } from './native-audio-cache';
import { NativePlayerService } from './native-player-service';
import type { DecodeResult } from './native-audio-decode';
import { probeWindowsMidi } from './windows-midi-health';

const windowsTest = it.skipIf(process.env.TBLINK_NATIVE_ENGINE_TEST !== '1');

windowsTest('系统 MIDI 故障时明确只播音频，真实 WASAPI 可播放定位并正常退出', async () => {
  const { options, request, failures } = await fixture();
  const checkDeviceHealth = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('MIDI 服务故障'));
  const player = new NativePlayerService({ ...options, checkDeviceHealth });
  try {
    const devices = await player.devices('audio');
    expect(devices.audio.some(device => device.isDefault)).toBe(true);
    expect(devices.midiOutputs).toEqual([]);
    await player.prepare(request);
    await player.control({ version: 1, sessionId: request.sessionId, generation: 2, kind: 'play' });
    await expect.poll(() => player.status?.positionMs).toBeGreaterThan(1050);
    await player.control({ version: 1, sessionId: request.sessionId, generation: 3, kind: 'seek', positionMs: 1500 });
    expect(player.status).toMatchObject({ status: 'paused', positionMs: 1500, mtcPortName: null, underruns: 0 });
    await player.control({ version: 1, sessionId: request.sessionId, generation: 4, kind: 'stop' });
    expect(checkDeviceHealth).not.toHaveBeenCalled(); expect(failures).toEqual([]);
  } finally { await player.close(); }
}, 10000);

windowsTest('真实 WASAPI 播放期间预填充下一首，曲尾接管不再解码且保留下一首原始时间码', async () => {
  const { options, request, failures } = await fixture(), measured = vi.fn();
  const prepare = vi.fn(options.cache.prepare.bind(options.cache));
  const player = new NativePlayerService({ ...options, cache: { prepare }, measured });
  const next = { ...request.snapshot, itemId: 'song-b', positionMs: 500, offsetMs: 960000 };
  try {
    await player.prepare({ ...request, snapshot: { ...request.snapshot, endMs: 1700 }, nextSnapshot: next });
    const pid = player.status!.enginePid;
    await player.control({ version: 1, sessionId: request.sessionId, generation: 2, kind: 'play' });
    await expect.poll(() => measured.mock.calls.some(([phase]) => phase === '下一节目音频预填充')).toBe(true);
    expect(player.status).toMatchObject({ itemId: 'song-a', status: 'playing', offsetMs: 480000, underruns: 0 });
    await expect.poll(() => player.status?.status).toBe('ended');
    const count = prepare.mock.calls.length;
    await player.prepare({ ...request, generation: 3, snapshot: next });
    expect(prepare).toHaveBeenCalledTimes(count);
    expect(measured.mock.calls.some(([phase]) => phase === '复用下一节目音频预填充')).toBe(true);
    await player.control({ version: 1, sessionId: request.sessionId, generation: 4, kind: 'play' });
    await expect.poll(() => player.status?.positionMs).toBeGreaterThan(550);
    expect(player.status).toMatchObject({ itemId: 'song-b', status: 'playing', offsetMs: 960000, enginePid: pid, underruns: 0 });
    expect(failures).toEqual([]);
  } finally { await player.close(); }
}, 10000);

windowsTest('已经开始播放后解码失败会停止音频；不会将失败留在后台继续空跑', async () => {
  const { options, request, failures } = await fixture();
  let complete: ((result: DecodeResult) => void) | undefined;
  const completion = new Promise<DecodeResult>(resolve => { complete = resolve; });
  const player = new NativePlayerService({ ...options, cache: { prepare: async (input, signal) => ({ ...await options.cache.prepare(input, signal), completion }) } });
  try {
    await player.prepare(request);
    await player.control({ version: 1, sessionId: request.sessionId, generation: 2, kind: 'play' });
    await expect.poll(() => player.status?.positionMs).toBeGreaterThan(1050);
    complete!({ ok: false, error: new Error('测试：后台解码中途失败') });
    await expect.poll(() => player.status?.status).toBe('error');
    expect(player.status?.audioError).toBe('测试：后台解码中途失败');
    await expect(player.control({ version: 1, sessionId: request.sessionId, generation: 3, kind: 'play' })).rejects.toThrow('重新准备');
    const frozen = player.status!.positionMs;
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(player.status!.positionMs).toBe(frozen); expect(failures).toEqual(['测试：后台解码中途失败']);
  } finally { await player.close(); }
}, 10000);
async function fixture() {
  if (!ffmpeg) throw new Error('测试缺少 FFmpeg');
  const directory = await mkdtemp(join(tmpdir(), 'tblink-player-service-'));
  const wav = Buffer.alloc(44 + 48000 * 4 * 3);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(48000 * 4, 28);
  wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  const path = join(directory, 'test.wav'); await writeFile(path, wav);
  const cache = new NativeAudioCache(join(directory, 'cache'), ffmpeg);
  const request: NativePlayerPrepare = { version: 1, sessionId: randomUUID(), generation: 1,
    projectPath: join(directory, 'test.tblink'), audioDeviceId: 'default', midiPortName: null,
    snapshot: { version: 1, projectId: 'test', itemId: 'song-a', revision: 1,
      audio: { relativePath: 'test.wav', sha256: createHash('sha256').update(wav).digest('hex'), durationMs: 3000 },
      startMs: 500, endMs: 2600, positionMs: 900, offsetMs: 480000, sampleRate: 48000, frameRate: 30, volume: 0 } };
  const failures: string[] = [], states: NativePlayerStatus[] = [];
  const options = { executable: resolve(process.env.TBLINK_PLAYBACK_ENGINE_EXE ?? 'tools/playback-engine/bin/tblink-playback.exe'),
    checkDeviceHealth: async () => { expect(await probeWindowsMidi(resolve('tools/midi-probe/bin/tblink-midi-probe.exe'))).toBe('ready'); },
    cache, resolveAudio: () => path, error: (message: string) => { failures.push(message); },
    changed: (state: NativePlayerStatus) => { states.push(state); } };
  return { options, request, failures, states };
}

windowsTest('后台正式音频服务：原始偏移和裁剪不叠加，缺少 MIDI 仍播放；停止后不复活旧音源', async () => {
  const { options, request, failures } = await fixture();
  const player = new NativePlayerService(options);
  const envelope = { version: 1 as const, sessionId: request.sessionId };
  try {
    const prepared = await player.prepare({ ...request, midiPortName: 'TBLINK MISSING TEST PORT' });
    expect(prepared).toMatchObject({ status: 'ready', positionMs: 900, offsetMs: 480000, mtcPortName: null });
    expect(prepared.mtcError).toContain('未连接'); expect(prepared.enginePid).toBeGreaterThan(0);
    expect(player.audioCaptureIdentity).toEqual({ executable: 'tblink-playback.exe', title: `TBLINK Audio ${prepared.enginePid}`, windowClass: 'Static', audioDeviceId: 'default' });
    await player.control({ ...envelope, generation: 2, kind: 'play' });
    await expect.poll(() => player.status?.positionMs).toBeGreaterThan(1050);
    await player.control({ ...envelope, generation: 3, kind: 'pause' });
    await expect.poll(() => player.status?.status).toBe('paused');
    const position = player.status!.positionMs;
    await new Promise(resolve => setTimeout(resolve, 120)); expect(player.status!.positionMs).toBe(position);
    await player.control({ ...envelope, generation: 4, kind: 'seek', positionMs: 600 });
    expect(player.status).toMatchObject({ status: 'paused', positionMs: 600, offsetMs: 480000 });
    await expect(player.control({ ...envelope, generation: 3, kind: 'play' })).rejects.toThrow('失效会话');
    await expect(player.control({ ...envelope, generation: 5, kind: 'seek', positionMs: 499 })).rejects.toThrow('裁剪范围');
    await player.control({ ...envelope, generation: 5, kind: 'play' });
    await expect.poll(() => player.status?.positionMs).toBeGreaterThan(750);
    await player.control({ ...envelope, generation: 6, kind: 'stop-mtc' });
    const withoutMtc = player.status!.positionMs;
    await expect.poll(() => player.status?.positionMs).toBeGreaterThan(withoutMtc + 100);
    expect(player.status).toMatchObject({ status: 'playing', mtcPortName: null, audioError: null });
    await player.control({ ...envelope, generation: 7, kind: 'stop' });
    await expect(player.control({ ...envelope, generation: 7, kind: 'play' })).rejects.toThrow('重新准备');
    await expect(player.control({ ...envelope, generation: 7, kind: 'seek', positionMs: 700 })).rejects.toThrow('重新准备');
    expect(player.status).toMatchObject({ status: 'stopped', audioError: null, underruns: 0 });
    expect(() => player.audioCaptureIdentity).toThrow('无法确认 OBS 采集目标');
    expect(failures).toEqual([]);
  } finally { await player.close(); }
}, 20000);

windowsTest('播放引擎进程意外退出后报告一次；下一首重新启动引擎并正常播放', async () => {
  const { options, request, failures } = await fixture();
  const player = new NativePlayerService(options);
  const envelope = { version: 1 as const, sessionId: request.sessionId };
  try {
    const first = await player.prepare(request);
    await player.control({ ...envelope, generation: 2, kind: 'play' });
    await expect.poll(() => player.status?.positionMs).toBeGreaterThan(1000);
    process.kill(first.enginePid!);
    await expect.poll(() => player.status?.status).toBe('error');
    expect(failures.filter(message => message.includes('播放引擎已退出'))).toHaveLength(1);
    const next = await player.prepare({ ...request, generation: 3 });
    expect(next).toMatchObject({ status: 'ready', audioError: null }); expect(next.enginePid).not.toBe(first.enginePid);
    await player.control({ ...envelope, generation: 4, kind: 'play' });
    await expect.poll(() => player.status?.positionMs).toBeGreaterThan(1050);
    expect(player.status).toMatchObject({ status: 'playing', audioError: null });
  } finally { await player.close(); }
}, 20000);

windowsTest('准备中切歌与取消：完成的旧解码不污染新节目；排队的播放被停止取消', async () => {
  const { options, request, failures, states } = await fixture();
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = false, blockFirst = true;
  const player = new NativePlayerService({ ...options, cache: { prepare: async (input, signal) => {
    if (blockFirst) { blockFirst = false; entered = true; await gate; }
    return options.cache.prepare(input, signal);
  } } });
  try {
    const first = player.prepare(request);
    const firstRejected = expect(first).rejects.toBeDefined();
    await expect.poll(() => entered).toBe(true);
    const next = { ...request, sessionId: randomUUID(), snapshot: { ...request.snapshot, itemId: 'song-b', offsetMs: 960000 } };
    const preparing = player.prepare(next); release!();
    await firstRejected; await preparing;
    expect(player.status).toMatchObject({ itemId: 'song-b', offsetMs: 960000, status: 'ready' });
    expect(states.filter(state => state.itemId === 'song-a').every(state => state.status === 'preparing')).toBe(true);
    await expect(player.control({ version: 1, sessionId: request.sessionId, generation: 100, kind: 'play' })).rejects.toThrow('失效会话');
    const play = player.control({ version: 1, sessionId: next.sessionId, generation: 2, kind: 'play' });
    const cancelled = expect(play).rejects.toThrow('取消');
    await player.control({ version: 1, sessionId: next.sessionId, generation: 3, kind: 'stop' });
    await cancelled; expect(player.status?.status).toBe('stopped');
    expect(states.some(state => state.status === 'playing')).toBe(false);
    const third = player.prepare({ ...next, generation: 4 });
    const thirdCancelled = expect(third).rejects.toThrow('取消');
    await player.control({ version: 1, sessionId: next.sessionId, generation: 5, kind: 'stop' });
    await thirdCancelled; expect(player.status?.status).toBe('stopped');
    expect(failures).toEqual([]);
  } finally { release!(); await player.close(); }
}, 20000);

windowsTest('设备准备失败保持失败状态，只有明确重新准备才能恢复', async () => {
  const { options, request, failures } = await fixture();
  const player = new NativePlayerService(options);
  try {
    await expect(player.prepare({ ...request, audioDeviceId: 'missing-endpoint' })).rejects.toThrow('已断开');
    expect(player.status?.status).toBe('error');
    await expect(player.control({ version: 1, sessionId: request.sessionId, generation: 2, kind: 'play' })).rejects.toThrow('重新准备');
    expect((await player.prepare({ ...request, generation: 3 })).status).toBe('ready');
    expect(failures).toHaveLength(1);
  } finally { await player.close(); }
}, 20000);

windowsTest('控制队列有界，停止可以取消满队列且不会在停止后补发', async () => {
  const { options, request, failures } = await fixture();
  const player = new NativePlayerService(options);
  try {
    await player.prepare(request);
    const envelope = { version: 1 as const, sessionId: request.sessionId, generation: 2 };
    const actions = Array.from({ length: 40 }, () => player.control({ ...envelope, kind: 'volume', volume: 0 }));
    const results = Promise.allSettled(actions);
    const stop = player.control({ ...envelope, generation: 3, kind: 'stop' });
    const repeated = player.control({ ...envelope, generation: 4, kind: 'stop' });
    expect(repeated).toBe(stop);
    const stopped = await stop;
    const completed = await results;
    expect(completed).toHaveLength(40);
    expect(completed.every(result => result.status === 'rejected')).toBe(true);
    const errors = completed.flatMap(result => result.status === 'rejected' && result.reason instanceof Error ? [result.reason.message] : []);
    expect(errors.filter(message => message.includes('队列已满'))).toHaveLength(8);
    expect(errors.filter(message => message.includes('取消'))).toHaveLength(32);
    expect(stopped.status).toBe('stopped'); expect(stopped.generation).toBe(4); expect(failures).toEqual([]);
  } finally { await player.close(); }
}, 20000);
