import { expect, it, vi } from 'vitest';
import { createObsProgramSnapshot, type LinkDesktopApi } from '@tb/core/link';
import { createEmptyLinkProject, parseLinkProject, type NativePlayerStatus, type NativeObsPrepare, type NativeObsStatus } from '@tb/schema';
import { NativeObsHost } from './native-obs-host';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NativePlaybackClient } from './native-playback-client';

function setup(prepareNextFiles = vi.fn<(request: NativeObsPrepare, assertCurrent: () => void) => Promise<void>>(() => Promise.resolve())) {
  const project = parseLinkProject({ ...createEmptyLinkProject('后台测试'), playbackSource: 'internal', obsOutputMode: 'scenes',
    rundown: [{ id: 'song', title: '歌曲', cues: [0, 1].map(seconds => ({ id: `cue-${seconds}`, name: '机位',
      timecode: { hours: 0, minutes: 0, seconds, frames: 0 }, actions: [{ id: `scene-${seconds}`, kind: 'obs.setProgramScene', label: '切机位', sceneName: `机位${seconds}` }] })) }] });
  let audio: NativePlayerStatus = { version: 1, sessionId: '64f37673-7a65-4c81-b5b4-09c1b9f94cb3', generation: 1, itemId: 'song', status: 'ready',
    positionMs: 0, offsetMs: 480000, sampleRate: 48000, enginePid: 1, engineTitle: '测试', mtcPortName: null, mtcSent: 0,
    audioError: null, mtcError: null, underruns: 0, gain: 1, analysis: null };
  let now = 0;
  const execute = vi.fn(() => Promise.resolve()), releaseOutputs = vi.fn(() => Promise.resolve()), failures: string[] = [], states: NativeObsStatus[] = [];
  const request: NativeObsPrepare = { version: 1, sessionId: audio.sessionId, generation: 1, preciseSeeking: false, projectPath: 'C:/shows/test.tblink', snapshot: createObsProgramSnapshot(project, 'song', 4) };
  const host = new NativeObsHost({ audio: () => audio, changed: state => states.push(state), error: message => failures.push(message),
    prepareNextFiles,
    outputs: () => ({ executor: { id: 'test', supports: () => true, execute },
      guardOutput: <T>(_canSend: () => boolean, operation: () => Promise<T>) => operation(),
      prepareOutputs: () => Promise.resolve(), releaseOutputs,
      now: () => now, seekMedia: () => Promise.resolve(), executeManagedMediaEvent: () => Promise.resolve(),
      recordLog: (entry: Parameters<LinkDesktopApi['recordLog']>[0]) => Promise.resolve({ ...entry, id: 'log', sessionId: 'test', timestamp: '2026-10-06T00:00:00Z', monotonicMs: now }) }) });
  const observe = (patch: Partial<NativePlayerStatus>, time: number, ageMs = 0) => { now = time; audio = { ...audio, ...patch }; host.observe(audio, ((process.hrtime.bigint() - BigInt(ageMs) * 1000000n) / 100n).toString()); };
  return { host, request, execute, releaseOutputs, failures, states, observe, prepareNextFiles, time: (value: number) => { now = value; }, audio: () => audio, change: (patch: Partial<NativePlayerStatus>) => { audio = { ...audio, ...patch }; } };
}

it('下一节目文件仅在当前音频开始后准备一次，停止后在途结果失效', async () => {
  let assertCurrent: (() => void) | null = null;
  const prepare = vi.fn<(_request: NativeObsPrepare, current: () => void) => Promise<void>>((_request, current) => { assertCurrent = current; return Promise.resolve(); });
  const test = setup(prepare);
  test.request.nextFiles = { snapshot: test.request.snapshot, positionMs: 0 };
  await test.host.prepare(test.request); expect(prepare).not.toHaveBeenCalled();
  test.observe({ status: 'playing', generation: 2 }, 0);
  test.observe({ positionMs: 10 }, 10);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(() => assertCurrent?.()).not.toThrow();
  await test.host.stop(); expect(() => assertCurrent?.()).toThrow('预备已取消');
});

it('跨工程或跨修订的下一节目不能随当前节目准备', async () => {
  const test = setup();
  test.request.nextFiles = { snapshot: { ...test.request.snapshot, revision: 5 }, positionMs: 0 };
  await expect(test.host.prepare(test.request)).rejects.toThrow('修订不一致');
  expect(test.execute).not.toHaveBeenCalled(); expect(test.prepareNextFiles).not.toHaveBeenCalled();
});

it('状态更新不能冒充设备采样；旧 QPC 不执行画面并标红，过时动作不补发，后续新采样继续', async () => {
  const test = setup(); await test.host.prepare(test.request);
  test.change({ status: 'playing', generation: 2 }); test.host.observe(test.audio());
  await new Promise(resolve => setTimeout(resolve, 0)); expect(test.execute).not.toHaveBeenCalled();
  test.observe({ positionMs: 0 }, 200, 200);
  expect(test.host.status?.state).not.toBe('failed'); expect(test.host.status?.fault).toContain('100ms'); expect(test.failures[0]).toContain('100ms');
  for (let time = 250; time <= 1000; time += 50) { test.observe({ positionMs: time }, time); await new Promise(resolve => setTimeout(resolve, 0)); }
  expect(test.execute).toHaveBeenCalledTimes(1);
  expect(test.host.status?.state).toBe('running');
  expect(test.audio().status).toBe('playing');
});

it('密集设备时钟继续驱动输出但界面位置限频，停止立即显示', async () => {
  const test = setup(); await test.host.prepare(test.request);
  const before = test.states.length;
  for (let time = 0; time <= 100; time += 10) {
    test.observe({ status: 'playing', positionMs: time, generation: 2 }, time);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  expect(test.states.length - before).toBe(3);
  expect(test.host.status?.positionMs).toBe(100);
  test.time(101); await test.host.stop();
  expect(test.states.at(-1)?.state).toBe('stopped');
});

it('曲尾只处理一次最终位置，后续冻结的设备时间戳不造成虚假故障', async () => {
  const test = setup(); await test.host.prepare(test.request);
  for (let time = 0; time <= 1000; time += 100) {
    test.observe({ status: time === 1000 ? 'ended' : 'playing', positionMs: time, generation: 2 }, time);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  test.observe({ status: 'ended' }, 2000, 1000);
  expect(test.host.status?.state).toBe('running'); expect(test.failures).toEqual([]);
  expect(test.execute).toHaveBeenCalledTimes(2);
});

it.skipIf(process.env.TBLINK_NATIVE_ENGINE_TEST !== '1')('真实 WASAPI 管道在主进程阻塞后保留采样年龄，不补发过时机位且音频继续', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-clock-backlog-')), path = join(directory, 'silence.pcm');
  await writeFile(path, Buffer.alloc(48000 * 4 * 4));
  const test = setup(), audioFailures: string[] = [], ages: number[] = [];
  await test.host.prepare(test.request);
  const client = new NativePlaybackClient(resolve(process.env.TBLINK_PLAYBACK_ENGINE_EXE ?? 'tools/playback-engine/bin/tblink-playback.exe'), event => {
    if (event.kind !== 'clock' || event.generation !== 2 || event.qpc100ns === '0') return;
    test.time(performance.now());
    test.change({ status: event.state === 'ended' ? 'ended' : 'playing', generation: 2, positionMs: event.positionMs });
    ages.push(Number(process.hrtime.bigint() - BigInt(event.qpc100ns) * 100n) / 1e6);
    test.host.observe(test.audio(), event.qpc100ns);
  }, error => audioFailures.push(error.message));
  try {
    await client.start();
    await client.command({ protocol: 4, requestId: 1, generation: 1, kind: 'prepare', pcmPath: path,
      sampleRate: 48000, frameRate: 30, midiDevice: null, startMs: 0, endMs: 4000, offsetMs: 480000, volume: 1 });
    await client.command({ protocol: 4, requestId: 2, generation: 2, kind: 'play' });
    await expect.poll(() => client.clock?.positionMs).toBeGreaterThan(600);
    expect(test.execute).toHaveBeenCalledTimes(1); expect(test.failures).toEqual([]);
    const boundary = performance.now() + 500;
    while (performance.now() < boundary) { /* deliberate main-thread stall */ }
    await expect.poll(() => test.host.status?.fault).toContain('100ms');
    await expect.poll(() => client.clock?.positionMs).toBeGreaterThan(1500);
    expect(test.execute).toHaveBeenCalledTimes(1);
    expect(test.host.status?.state).toBe('running'); expect(Math.max(...ages)).toBeGreaterThan(100);
    expect(client.clock).toMatchObject({ state: 'playing', underruns: 0, audioError: 0 }); expect(audioFailures).toEqual([]);
  } finally {
    await writeFile(join(directory, 'evidence.json'), JSON.stringify({ ages, audioFailures, obsFailures: test.failures, sent: test.execute.mock.calls.length }, null, 2));
    console.info('主进程阻塞证据', directory);
    await client.close(); await test.host.stop();
  }
}, 10000);

it('只接受当前已准备音频的同会话同代数，歌曲名称不能替代身份', async () => {
  const test = setup();
  await expect(test.host.prepare({ ...test.request, generation: 2 })).rejects.toThrow('不一致');
  await expect(test.host.prepare({ ...test.request, sessionId: crypto.randomUUID() })).rejects.toThrow('不一致');
  expect(test.execute).not.toHaveBeenCalled();
  await expect(test.host.prepare(test.request)).resolves.toMatchObject({ state: 'ready', revision: 4, nextCueId: 'cue-0' });
});

it('主进程音频观察推进画面；旧会话消息不能扰动当前会话', async () => {
  const test = setup(); await test.host.prepare(test.request);
  test.host.observe({ ...test.audio(), sessionId: crypto.randomUUID(), status: 'stopped' });
  expect(test.host.status?.state).toBe('ready');
  for (let time = 0; time <= 1000; time += 100) {
    test.observe({ status: 'playing', positionMs: time, generation: 2 }, time);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  expect(test.execute).toHaveBeenCalledTimes(2); expect(test.failures).toEqual([]);
  expect(test.host.status).toMatchObject({ state: 'running', currentCueId: 'cue-1', nextCueId: null });
  test.host.observe({ ...test.audio(), generation: 1, status: 'stopped' });
  expect(test.host.status?.state).toBe('running');
  await test.host.stop();
});

it('新音频准备立即作废旧输出，不把切歌的时钟派给上一首', async () => {
  const test = setup(); await test.host.prepare(test.request);
  test.observe({ status: 'playing', positionMs: 0 }, 0);
  test.observe({ status: 'preparing', generation: 3, itemId: 'other' }, 1);
  expect(test.host.status?.state).toBe('stopped');
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(test.execute).not.toHaveBeenCalled();
  await test.host.stop(); expect(test.execute).not.toHaveBeenCalled();
  expect(test.host.status?.state).toBe('stopped');
});

it('准备已经迟到不能中途加入播放，旧请求仍明确失败', async () => {
  const test = setup(); test.change({ status: 'playing', positionMs: 500 });
  await expect(test.host.prepare(test.request)).rejects.toThrow('不会中途加入');
  expect(test.execute).not.toHaveBeenCalled();
});

it('直播中 OBS 拒绝动作标红，通道继续后续画面，音频的状态和偏移不被改写', async () => {
  const test = setup(); test.execute.mockRejectedValueOnce(new Error('OBS 断开'));
  await test.host.prepare(test.request); test.observe({ status: 'playing', positionMs: 0 }, 0);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(test.host.status).toMatchObject({ state: 'running', fault: '画面动作失败：切机位 · OBS 断开' });
  expect(test.audio()).toMatchObject({ status: 'playing', offsetMs: 480000 });
  for (let time = 100; time <= 1000; time += 100) { test.observe({ status: 'playing', positionMs: time }, time); await new Promise(resolve => setTimeout(resolve, 0)); }
  expect(test.execute).toHaveBeenCalledTimes(2); expect(test.host.status?.currentCueId).toBe('cue-1');
});

it('初始化在途时音频先启动，立即作废准备，迟到结果不能继续加入', async () => {
  const test = setup(); test.change({ positionMs: 500 });
  let sent: () => void = () => { throw new Error('未初始化'); };
  let release: () => void = () => { throw new Error('未开始'); };
  const started = new Promise<void>(resolve => { sent = resolve; });
  test.execute.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; sent(); }));
  const preparing = expect(test.host.prepare(test.request)).rejects.toThrow('已取消');
  await started;
  test.observe({ status: 'playing', generation: 2 }, 10);
  expect(test.host.status?.state).toBe('stopped');
  expect(test.host.status?.reason).toContain('本轮未参与');
  release(); await preparing; await test.host.stop();
  expect(test.execute).toHaveBeenCalledTimes(1);
});

it('旧准备的停止不得取消新节目；播放中断线标红但画面通道保留，重新连接后继续', async () => {
  const test = setup(); await test.host.prepare(test.request);
  test.change({ generation: 2 }); await test.host.prepare({ ...test.request, generation: 2 });
  await expect(test.host.stopOwned({ version: 1, sessionId: test.request.sessionId, generation: 1 })).rejects.toThrow('旧准备');
  expect(test.host.status?.state).toBe('ready');
  test.observe({ status: 'playing', generation: 3, positionMs: 0 }, 0);
  test.host.disconnect('OBS 网络断开'); test.host.disconnect('OBS 网络断开');
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(test.host.status).toMatchObject({ state: 'running' }); expect(test.host.status?.fault).toContain('OBS 网络断开');
  expect(test.failures).toHaveLength(1);
  expect(test.audio().status).toBe('playing');
  for (let time = 100; time <= 1000; time += 100) { test.observe({ positionMs: time }, time); await new Promise(resolve => setTimeout(resolve, 0)); }
  expect(test.execute).toHaveBeenCalledTimes(2);
});

it('准备阶段断线仍取消本轮画面，不带着未就绪的画面开播', async () => {
  const test = setup();
  let release: () => void = () => { throw new Error('未开始'); };
  test.execute.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  test.change({ positionMs: 500 });
  const preparing = expect(test.host.prepare(test.request)).rejects.toThrow();
  await vi.waitFor(() => expect(test.execute).toHaveBeenCalledTimes(1));
  test.host.disconnect('OBS 网络断开'); release(); await preparing;
  expect(test.host.status?.state).toBe('failed');
});

it('暂停请求准入即取消排队画面，迟到的播放状态不能重新触发；确认后才显示暂停', async () => {
  const test = setup(); await test.host.prepare(test.request);
  test.observe({ status: 'playing', generation: 2, positionMs: 0 }, 0);
  test.host.interrupt({ version: 1, sessionId: test.request.sessionId, generation: 3, kind: 'pause' });
  test.observe({ status: 'playing', generation: 3, positionMs: 50 }, 50);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(test.execute).not.toHaveBeenCalled(); expect(test.host.status?.state).toBe('running');
  test.observe({ status: 'paused', generation: 3, positionMs: 50 }, 60);
  expect(test.host.status?.state).toBe('paused');
  test.host.interrupt({ version: 1, sessionId: test.request.sessionId, generation: 4, kind: 'seek', positionMs: 1000 });
  expect(test.host.status?.state).toBe('stopped');
});

it('新准备等待上一轮清理时也可取消，不能因尚未创建新 Entry 而漏掉停止', async () => {
  const test = setup(); await test.host.prepare(test.request);
  let release: () => void = () => { throw new Error('未初始化'); };
  const gate = new Promise<void>(resolve => { release = resolve; }); test.releaseOutputs.mockReturnValueOnce(gate);
  test.change({ generation: 2 });
  const preparing = expect(test.host.prepare({ ...test.request, generation: 2 })).rejects.toThrow('取消');
  await vi.waitFor(() => expect(test.releaseOutputs).toHaveBeenCalledTimes(1));
  const stopping = test.host.stopOwned({ version: 1, sessionId: test.request.sessionId, generation: 2 });
  release(); await preparing; await stopping;
  expect(test.host.status?.state).toBe('stopped'); expect(test.execute).not.toHaveBeenCalled();
});
