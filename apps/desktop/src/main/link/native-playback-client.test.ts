import { expect, it } from 'vitest';
import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { NativePlaybackClient, readNativePlaybackDevices } from './native-playback-client';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { encodeNativePlaybackCommand, NativePlaybackEventDecoder } from './native-playback-protocol';
import type { NativePlaybackEvent } from '@tb/schema';
import { NativeDeviceQuery } from './native-device-query';

it.skipIf(process.env.TBLINK_NATIVE_ENGINE_TEST !== '1')('Windows 设备服务连续查询真实清单，错误二进制请求拒绝且正常关闭退出', async () => {
  const executable = resolve(process.env.TBLINK_PLAYBACK_ENGINE_EXE ?? 'tools/playback-engine/bin/tblink-playback.exe');
  const query = new NativeDeviceQuery(executable);
  try {
    for (let index = 0; index < 20; index++) {
      const devices = await query.read();
      expect(devices.audio.some(device => device.isDefault)).toBe(true);
      expect(new Set(devices.audio.map(device => device.id)).size).toBe(devices.audio.length);
    }
  } finally { await query.close(); }
  for (const bytes of [Buffer.from('invalid!'), Buffer.from('TBD1\0\0\0\0'), Buffer.from('TBD1')]) {
    const child = spawn(executable, ['--device-service'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = once(child, 'close'); child.stdin.end(bytes);
    const result: unknown[] = await exited; expect(result[0]).toBe(2);
  }
}, 15000);

it.skipIf(process.env.TBLINK_NATIVE_ENGINE_TEST !== '1')('时钟报告管道持续堵塞到容量上限后明确停止音频，不无限积压或恢复后自动播放', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-clock-queue-'));
  const path = join(directory, 'silence.pcm'); await writeFile(path, Buffer.alloc(48000 * 4 * 20));
  const child = spawn(resolve(process.env.TBLINK_PLAYBACK_ENGINE_EXE ?? 'tools/playback-engine/bin/tblink-playback.exe'), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'close'), decoder = new NativePlaybackEventDecoder();
  const events: NativePlaybackEvent[] = [], errors: string[] = [];
  child.stdout.setEncoding('utf8'); child.stdout.on('data', (data: string) => { events.push(...decoder.push(data)); });
  child.stderr.on('data', (data: Buffer) => errors.push(data.toString('utf8')));
  try {
    await expect.poll(() => events.some(event => event.kind === 'ready')).toBe(true);
    child.stdin.write(encodeNativePlaybackCommand({ protocol: 4, requestId: 1, generation: 1, kind: 'prepare', pcmPath: path,
      sampleRate: 48000, frameRate: 30, midiDevice: null, startMs: 0, endMs: 20000, offsetMs: 480000, volume: 0 }));
    await expect.poll(() => events.some(event => event.kind === 'ack' && event.requestId === 1 && event.ok)).toBe(true);
    child.stdin.write(encodeNativePlaybackCommand({ protocol: 4, requestId: 2, generation: 2, kind: 'play' }));
    await expect.poll(() => events.some(event => event.kind === 'clock' && event.state === 'playing')).toBe(true);
    child.stdout.pause(); await new Promise(resolve => setTimeout(resolve, 9000)); child.stdout.resume();
    await expect.poll(() => events.find(event => event.kind === 'clock' && event.state === 'error')).toMatchObject({
      audioError: -2147024785, underruns: 0, qpc100ns: '0'
    });
    events.length = 0; await new Promise(resolve => setTimeout(resolve, 200));
    expect(events.filter(event => event.kind === 'clock').every(event => event.kind === 'clock' && event.state === 'error')).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    child.stdout.resume(); child.stdin.end();
    const result: unknown[] = await exited; expect(result[0]).toBe(0);
  }
}, 20000);

it.skipIf(process.env.TBLINK_NATIVE_ENGINE_TEST !== '1')('增长中的 PCM 跨越初始文件末尾继续出声；设备时间保留非零源坐标', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-stream-'));
  const nested = join(directory, '长路径'.repeat(70)); await mkdir(nested);
  const path = join(nested, 'stream.pcm'); expect(path.length).toBeGreaterThan(260);
  await writeFile(path, Buffer.alloc(48000 * 4 * 2));
  const failures: string[] = [];
  const client = new NativePlaybackClient(resolve(process.env.TBLINK_PLAYBACK_ENGINE_EXE ?? 'tools/playback-engine/bin/tblink-playback.exe'), () => undefined, error => failures.push(error.message));
  try {
    await client.start();
    await client.command({ protocol: 4, requestId: 1, generation: 1, kind: 'prepare', pcmPath: path, sampleRate: 48000, frameRate: 30,
      midiDevice: null, startMs: 3600250, endMs: 3603000, pcmBaseMs: 3600000, streaming: true, offsetMs: 480000, volume: 1 });
    await client.command({ protocol: 4, requestId: 2, generation: 2, kind: 'play' });
    await expect.poll(() => client.clock?.positionMs).toBeGreaterThan(3600800);
    await appendFile(path, Buffer.alloc(48000 * 4));
    await expect.poll(() => client.clock?.positionMs, { timeout: 4000 }).toBe(3603000);
    expect(client.clock).toMatchObject({ state: 'ended', audioError: 0, underruns: 0 });
    expect(failures).toEqual([]);
  } finally { await client.close(); }
}, 10000);

it.skipIf(process.env.TBLINK_NATIVE_ENGINE_TEST !== '1')('Windows 实际 WASAPI 播放、暂停、非零定位和过期命令隔离', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-engine-'));
  const path = join(directory, '静音.pcm');
  await writeFile(path, Buffer.alloc(48000 * 4 * 12));
  const failures: string[] = [];
  const executable = resolve(process.env.TBLINK_PLAYBACK_ENGINE_EXE ?? 'tools/playback-engine/bin/tblink-playback.exe');
  const devices = await readNativePlaybackDevices(executable);
  const endpoint = devices.audio.find(device => device.isDefault);
  expect(endpoint).toBeDefined();
  const client = new NativePlaybackClient(executable, () => undefined, error => failures.push(error.message));
  try {
    await client.start(); expect(client.identity?.title).toMatch(/^TBLINK Audio \d+$/);
    await client.command({ protocol: 4, requestId: 1, generation: 1, kind: 'prepare', pcmPath: path, audioDeviceId: endpoint!.id, sampleRate: 48000, frameRate: 30, midiDevice: null, startMs: 1500, endMs: 10000, offsetMs: 480000, volume: 1 });
    await client.command({ protocol: 4, requestId: 2, generation: 2, kind: 'play' });
    await expect.poll(() => client.clock?.positionMs).toBeGreaterThan(1800);
    expect(client.clock).toMatchObject({ state: 'playing', audioError: 0, underruns: 0 });
    await expect(client.command({ protocol: 4, requestId: 8, generation: 100, kind: 'seek', positionMs: 500 })).rejects.toThrow();
    await expect(client.command({ protocol: 4, requestId: 9, generation: 100, kind: 'seek', positionMs: 10000 })).rejects.toThrow();
    // Rejected positions must not advance the accepted generation or stop audio.
    await client.command({ protocol: 4, requestId: 10, generation: 2, kind: 'volume', volume: 0.75 });
    await client.command({ protocol: 4, requestId: 3, generation: 3, kind: 'pause' });
    await expect.poll(() => client.clock?.state).toBe('paused');
    const position = client.clock!.positionMs;
    await new Promise(resolve => setTimeout(resolve, 150)); expect(client.clock!.positionMs).toBe(position);
    await client.command({ protocol: 4, requestId: 4, generation: 4, kind: 'seek', positionMs: 5000 });
    await expect.poll(() => client.clock?.positionMs).toBe(5000);
    await client.command({ protocol: 4, requestId: 5, generation: 5, kind: 'play' });
    await expect.poll(() => client.clock?.positionMs).toBeGreaterThan(5300);
    await expect(client.command({ protocol: 4, requestId: 6, generation: 3, kind: 'stop' })).rejects.toThrow();
    expect(client.clock?.state).toBe('playing');
    await client.command({ protocol: 4, requestId: 7, generation: 6, kind: 'stop' });
    await expect.poll(() => client.clock?.state).toBe('stopped');
    expect(failures).toEqual([]);
    await expect(client.command({ protocol: 4, requestId: 11, generation: 7, kind: 'prepare', pcmPath: path, audioDeviceId: '{0.0.0.00000000}.{missing-test-endpoint}', sampleRate: 48000, frameRate: 30, midiDevice: null, startMs: 1500, endMs: 10000, offsetMs: 480000, volume: 1 })).rejects.toThrow('操作失败');
    await expect.poll(() => client.clock?.state).toBe('error');
    await client.command({ protocol: 4, requestId: 12, generation: 8, kind: 'stop' });
    await expect.poll(() => client.clock?.state).toBe('stopped');
    expect(client.clock?.audioError).toBe(0);
  } finally { await client.close(); }
}, 20000);

it.skipIf(process.env.TBLINK_NATIVE_ENGINE_TEST !== '1')('真实输出采样的频谱、电平和淡变不依赖主进程定时器，暂停冻结淡变', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-gain-'));
  const pcm = Buffer.alloc(48000 * 4 * 5);
  for (let i = 0; i < pcm.length / 4; i++) {
    const wave = Math.sin(i * 1500 * 2 * Math.PI / 48000);
    pcm.writeInt16LE(Math.round(wave * 512), i * 4); pcm.writeInt16LE(Math.round(wave * 256), i * 4 + 2);
  }
  const path = join(directory, 'tone.pcm'); await writeFile(path, pcm);
  const failures: string[] = [];
  const client = new NativePlaybackClient(resolve(process.env.TBLINK_PLAYBACK_ENGINE_EXE ?? 'tools/playback-engine/bin/tblink-playback.exe'), () => undefined, error => failures.push(error.message));
  try {
    await client.start();
    await client.command({ protocol: 4, requestId: 1, generation: 1, kind: 'prepare', pcmPath: path, sampleRate: 48000, frameRate: 30,
      midiDevice: null, startMs: 0, endMs: 5000, offsetMs: 480000, volume: 0 });
    await client.command({ protocol: 4, requestId: 2, generation: 1, kind: 'volume', volume: 1, durationMs: 1000 });
    await client.command({ protocol: 4, requestId: 3, generation: 2, kind: 'play' });
    await expect.poll(() => client.clock?.gain).toBeGreaterThan(0.15);
    await client.command({ protocol: 4, requestId: 4, generation: 3, kind: 'pause' });
    const paused = await client.readClock(3);
    expect(paused.gain).toBeLessThan(0.9);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(client.clock?.gain).toBe(paused.gain);
    expect(client.clock?.analysis.peaks).toEqual([0, 0]);
    await client.command({ protocol: 4, requestId: 5, generation: 4, kind: 'play' });
    // The host is deliberately unavailable for the remainder of the fade.
    const blockedUntil = performance.now() + 1100;
    while (performance.now() < blockedUntil) { /* real host fault injection */ }
    await expect.poll(() => client.clock?.gain).toBe(1);
    const analysis = client.clock!.analysis;
    expect(analysis.peaks[0]).toBeCloseTo(512 / 32768, 5);
    expect(analysis.peaks[1]).toBeCloseTo(256 / 32768, 5);
    expect(analysis.spectrum.indexOf(Math.max(...analysis.spectrum))).toBe(64);
    await client.command({ protocol: 4, requestId: 6, generation: 4, kind: 'volume', volume: 0, durationMs: 400 });
    await expect.poll(() => client.clock?.gain).toBe(0);
    await expect.poll(() => client.clock?.analysis.peaks[0]).toBe(0);
    expect(client.clock).toMatchObject({ state: 'playing', audioError: 0, underruns: 0 });
    expect(failures).toEqual([]);
  } finally { await client.close(); }
}, 20000);
