import { expect, it, vi } from 'vitest';
import { createObsProgramSnapshot, emptyInternalPlayerState, NativeProgramPlayer, type InternalPlayerState, type LinkDesktopApi } from '@tb/core/link';
import { createEmptyLinkProject, parseLinkProject, type LinkAction, type NativePlayerStatus, type NativeObsPrepare, type NativeObsStatus } from '@tb/schema';
import { NativeObsHost } from './native-obs-host';
import { NativeObsRequests } from './native-obs-requests';
import { NativeObsPreloadPool } from './native-obs-preload';
import type { NativeObsOutputs } from './native-obs-outputs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NativePlaybackClient } from './native-playback-client';

function setup(prepareNextFiles = vi.fn<(request: NativeObsPrepare, assertCurrent: () => void) => Promise<void>>(() => Promise.resolve())) {
  const project = parseLinkProject({ ...createEmptyLinkProject('后台测试'), playbackSource: 'internal', obsOutputMode: 'scenes',
    rundown: ([['song', '', ''], ['next', 'next-', '下一首']] as const).map(([id, prefix, scene]) => ({ id, title: id, cues: [0, 1].map(seconds => ({ id: `${prefix}cue-${seconds}`, name: '机位',
      timecode: { hours: 0, minutes: 0, seconds, frames: 0 }, actions: [{ id: `${prefix}scene-${seconds}`, kind: 'obs.setProgramScene', label: '切机位', sceneName: `${scene}机位${seconds}` }] })) })) });
  let audio: NativePlayerStatus = { version: 1, sessionId: '64f37673-7a65-4c81-b5b4-09c1b9f94cb3', generation: 1, itemId: 'song', status: 'ready',
    positionMs: 0, offsetMs: 480000, sampleRate: 48000, enginePid: 1, engineTitle: '测试', mtcPortName: null, mtcSent: 0,
    audioError: null, mtcError: null, underruns: 0, mtcInterruptions: 0, gain: 1, analysis: null };
  let now = 0;
  const execute = vi.fn<(action: LinkAction) => Promise<void>>(() => Promise.resolve()), releaseOutputs = vi.fn(() => Promise.resolve()), failures: string[] = [], states: NativeObsStatus[] = [];
  const restoreScenes = vi.fn<(assertCurrent: () => void) => Promise<void>>(() => Promise.resolve());
  const request: NativeObsPrepare = { version: 1, sessionId: audio.sessionId, generation: 1, preciseSeeking: false, projectPath: 'C:/shows/test.tblink', snapshot: createObsProgramSnapshot(project, 'song', 4) };
  const host = new NativeObsHost({ audio: () => audio, changed: state => states.push(state), error: message => failures.push(message),
    prepareNextFiles,
    outputs: () => ({ executor: { id: 'test', supports: () => true, execute },
      guardOutput: <T>(_canSend: () => boolean, operation: () => Promise<T>) => operation(),
      prepareOutputs: () => Promise.resolve(), releaseOutputs, restoreScenes,
      now: () => now, seekMedia: () => Promise.resolve(), executeManagedMediaEvent: () => Promise.resolve(),
      recordLog: (entry: Parameters<LinkDesktopApi['recordLog']>[0]) => Promise.resolve({ ...entry, id: 'log', sessionId: 'test', timestamp: '2026-10-06T00:00:00Z', monotonicMs: now }) }) });
  const observe = (patch: Partial<NativePlayerStatus>, time: number, ageMs = 0) => { now = time; audio = { ...audio, ...patch }; host.observe(audio, ((process.hrtime.bigint() - BigInt(ageMs) * 1000000n) / 100n).toString()); };
  return { host, request, execute, releaseOutputs, restoreScenes, failures, states, observe, prepareNextFiles, time: (value: number) => { now = value; }, audio: () => audio, change: (patch: Partial<NativePlayerStatus>) => { audio = { ...audio, ...patch }; },
    song: (itemId: string, generation: number): NativeObsPrepare => ({ ...request, generation, snapshot: createObsProgramSnapshot(project, itemId, 4) }) };
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
  await test.host.stop(); expect(() => assertCurrent?.()).toThrow('准备已取消');
});

it('跨工程或跨修订的下一节目不能随当前节目准备', async () => {
  const test = setup();
  test.request.nextFiles = { snapshot: { ...test.request.snapshot, revision: 5 }, positionMs: 0 };
  await expect(test.host.prepare(test.request)).rejects.toThrow('和当前工程版本对不上');
  expect(test.execute).not.toHaveBeenCalled(); expect(test.prepareNextFiles).not.toHaveBeenCalled();
});

it('状态更新不能冒充设备采样；旧 QPC 晚到也照样切画面，不漏切，后续新采样继续（2026-11-09）', async () => {
  const test = setup(); await test.host.prepare(test.request);
  test.change({ status: 'playing', generation: 2 }); test.host.observe(test.audio());
  await new Promise(resolve => setTimeout(resolve, 0)); expect(test.execute).not.toHaveBeenCalled();
  test.observe({ positionMs: 0 }, 200, 200);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(test.host.status?.state).not.toBe('failed'); expect(test.execute.mock.calls.map(([action]) => action.id)).toEqual(['scene-0']);
  expect(test.failures).toEqual([]);
  for (let time = 250; time <= 1000; time += 50) { test.observe({ positionMs: time }, time); await new Promise(resolve => setTimeout(resolve, 0)); }
  expect(test.execute.mock.calls.map(([action]) => action.id)).toEqual(['scene-0', 'scene-1']);
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
  for (let time = 0; time <= 1000; time += 50) {
    test.observe({ status: time === 1000 ? 'ended' : 'playing', positionMs: time, generation: 2 }, time);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  test.observe({ status: 'ended' }, 2000, 1000);
  expect(test.host.status?.state).toBe('running'); expect(test.failures).toEqual([]);
  expect(test.execute).toHaveBeenCalledTimes(2);
});

it.skipIf(process.env.TBLINK_NATIVE_ENGINE_TEST !== '1')('真实 WASAPI 管道在主进程阻塞后保留采样年龄，按当前位置重建机位并标红，音频继续', async () => {
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
    await expect.poll(() => test.host.status?.fault).toContain('画面已按当前位置恢复');
    await expect.poll(() => client.clock?.positionMs).toBeGreaterThan(1500);
    expect(test.execute).toHaveBeenCalledTimes(2);
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
  await expect(test.host.prepare({ ...test.request, generation: 2 })).rejects.toThrow('不是当前这首歌');
  await expect(test.host.prepare({ ...test.request, sessionId: crypto.randomUUID() })).rejects.toThrow('不是当前这首歌');
  expect(test.execute).not.toHaveBeenCalled();
  await expect(test.host.prepare(test.request)).resolves.toMatchObject({ state: 'ready', revision: 4, nextCueId: 'cue-0' });
});

it('主进程音频观察推进画面；旧会话消息不能扰动当前会话', async () => {
  const test = setup(); await test.host.prepare(test.request);
  test.host.observe({ ...test.audio(), sessionId: crypto.randomUUID(), status: 'stopped' });
  expect(test.host.status?.state).toBe('ready');
  for (let time = 0; time <= 1000; time += 50) {
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
  expect(test.host.status?.reason).toContain('这一首不联动画面');
  release(); await preparing; await test.host.stop();
  expect(test.execute).toHaveBeenCalledTimes(1);
});

it('旧准备的停止不得取消新节目；播放中断线标红但画面通道保留，重新连接后继续', async () => {
  const test = setup(); await test.host.prepare(test.request);
  test.change({ generation: 2 }); await test.host.prepare({ ...test.request, generation: 2 });
  await expect(test.host.stopOwned({ version: 1, sessionId: test.request.sessionId, generation: 1 })).rejects.toThrow('上一次准备');
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

it('播放中重新连接 OBS：重新准备本曲场景后按当前位置重建画面并标红；准备未开始时不动作', async () => {
  const test = setup(); await test.host.prepare(test.request);
  await test.host.reconnected(); expect(test.restoreScenes).not.toHaveBeenCalled();
  test.observe({ status: 'playing', generation: 2, positionMs: 0 }, 0);
  for (let time = 50; time <= 1500; time += 50) { test.observe({ positionMs: time }, time); await new Promise(resolve => setTimeout(resolve, 0)); }
  test.host.disconnect('OBS 网络断开'); const sent = test.execute.mock.calls.length;
  await test.host.reconnected();
  expect(test.restoreScenes).toHaveBeenCalledOnce(); expect(test.execute).toHaveBeenCalledTimes(sent + 1);
  expect(test.execute.mock.calls.at(-1)?.[0]).toMatchObject({ kind: 'obs.setProgramScene', sceneName: '机位1' });
  expect(test.host.status).toMatchObject({ state: 'running', fault: 'OBS 已重新连接，画面已按当前位置恢复（1 项）' });
  test.restoreScenes.mockRejectedValueOnce(new Error('素材文件不可读'));
  await test.host.reconnected();
  const partial = 'OBS 已重新连接，但素材场景没有重新准备好：素材文件不可读。机位已按当前位置恢复（1 项），素材可能播不出来';
  expect(test.host.status).toMatchObject({ state: 'running', fault: partial });
  expect(test.failures.at(-1)).toBe(partial);
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

it('上一次的画面清理失败：这一首照常准备并按时间线切画面，在这一首上标红一次、只记一次，之后每一首不再显示', async () => {
  const test = setup(); await test.host.prepare(test.request);
  test.observe({ status: 'playing', generation: 1, positionMs: 0 }, 0);
  await vi.waitFor(() => expect(test.execute).toHaveBeenCalledTimes(1));
  test.releaseOutputs.mockRejectedValueOnce(new Error('OBS 无响应'));
  const faults: (string | null | undefined)[] = [];
  for (const generation of [2, 3]) {
    test.change({ generation, status: 'ready', positionMs: 0 });
    const status = await test.host.prepare({ ...test.request, generation });
    expect(status).toMatchObject({ state: 'ready', generation }); faults.push(status.fault);
    test.observe({ status: 'playing', generation, positionMs: 0 }, generation * 1000);
    await vi.waitFor(() => expect(test.execute).toHaveBeenCalledTimes(generation));
    expect(test.host.status?.state).toBe('running');
  }
  // The same song again (a seek or a replay): its earlier picture, not the previous song's.
  expect(faults).toEqual(['上一次的画面没有清理干净，这一首照常播。原因：画面没有清理干净：OBS 无响应', undefined]);
  expect(test.failures).toEqual(['画面没有清理干净：OBS 无响应']);
  await test.host.stop();
});

it('停止时画面清理失败只记一次：之后的停止和选歌预备都不再失败、不再重复记录，也不重做清理（2026-11-09）', async () => {
  const test = setup(); await test.host.prepare(test.request);
  test.observe({ status: 'playing', generation: 1, positionMs: 0 }, 0);
  await vi.waitFor(() => expect(test.execute).toHaveBeenCalledTimes(1));
  test.releaseOutputs.mockRejectedValueOnce(new Error('OBS 无响应'));
  // The operator stops: the audio stop reaches the picture first, then the program stops its own picture.
  test.host.interrupt({ version: 1, sessionId: test.request.sessionId, generation: 2, kind: 'stop' });
  await expect(test.host.stopOwned({ version: 1, sessionId: test.request.sessionId, generation: 1 })).resolves.toBeUndefined();
  // While stopped, each song the operator selects first makes sure no picture is on air (link-main's authorize).
  const select = async (): Promise<void> => { if (test.host.busy) throw new Error('正在播放时不能准备另一个节目'); await test.host.stop(); };
  for (let count = 0; count < 3; count++) await expect(select()).resolves.toBeUndefined();
  expect(test.failures).toEqual(['画面没有清理干净：OBS 无响应']);
  expect(test.releaseOutputs).toHaveBeenCalledOnce(); expect(test.host.status?.state).toBe('stopped');
});

it('上一首停止时画面清理失败：下一首照常准备、按时间线切画面，失败在下一首上标红一次（2026-11-09）', async () => {
  const test = setup(); await test.host.prepare(test.request);
  test.observe({ status: 'playing', generation: 1, positionMs: 0 }, 0);
  await vi.waitFor(() => expect(test.execute).toHaveBeenCalledTimes(1));
  test.releaseOutputs.mockRejectedValueOnce(new Error('OBS 无响应'));
  await test.host.stopOwned({ version: 1, sessionId: test.request.sessionId, generation: 1 });
  test.change({ generation: 2, itemId: 'next', status: 'ready', positionMs: 0 });
  await expect(test.host.prepare(test.song('next', 2))).resolves.toMatchObject({ state: 'ready', itemId: 'next',
    fault: '上一首的画面没有清理干净，这一首照常播。原因：画面没有清理干净：OBS 无响应' });
  test.observe({ status: 'playing', generation: 2, positionMs: 0 }, 1000);
  await vi.waitFor(() => expect(test.execute).toHaveBeenCalledTimes(2));
  expect(test.execute.mock.calls.at(-1)?.[0]).toMatchObject({ sceneName: '下一首机位0' });
  expect(test.host.status).toMatchObject({ state: 'running', itemId: 'next' });
  expect(test.failures).toEqual(['画面没有清理干净：OBS 无响应']);
  await test.host.stopOwned({ version: 1, sessionId: test.request.sessionId, generation: 2 });
  test.change({ generation: 3, itemId: 'song', status: 'ready', positionMs: 0 });
  expect((await test.host.prepare(test.song('song', 3))).fault ?? null).toBeNull();
  await test.host.stop();
});

it('自动下一首时上一首的画面清理失败：播放器在下一首上标红一次，没有另外的提示，只记一次，下一首照常切画面（2026-11-09）', async () => {
  const project = parseLinkProject({ ...createEmptyLinkProject('自动下一首'), playbackSource: 'internal', obsOutputMode: 'scenes',
    rundown: ['a', 'b'].map((id, index) => ({ id, title: id, referenceAudio: { assetId: `audio-${id}`, relativePath: `${id}.wav`, sha256: 'a'.repeat(64), durationMs: 4000 },
      playback: { startMs: 0, endMs: 2000, mtcOffsetMs: 480000 + index * 20000, volume: 80, endAction: 'next', shortcut: '' },
      cues: [{ id: `cue-${id}`, name: '机位', timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
        actions: [{ id: `scene-${id}`, kind: 'obs.setProgramScene', label: '切机位', sceneName: `机位-${id}` }] }] })) });
  let audio: NativePlayerStatus | null = null, state: InternalPlayerState = { ...emptyInternalPlayerState }, time = 0;
  const audioListeners = new Set<(status: NativePlayerStatus) => void>(), obsListeners = new Set<(status: NativeObsStatus) => void>();
  const failures: string[] = [], notices: string[] = [];
  const execute = vi.fn<(action: LinkAction) => Promise<void>>(() => Promise.resolve()), releaseOutputs = vi.fn(() => Promise.resolve());
  const host = new NativeObsHost({ audio: () => audio, error: message => failures.push(message),
    changed: status => { for (const listener of obsListeners) listener(status); },
    outputs: () => ({ executor: { id: 'test', supports: () => true, execute },
      guardOutput: <T>(_canSend: () => boolean, operation: () => Promise<T>) => operation(), prepareOutputs: () => Promise.resolve(), releaseOutputs,
      now: () => time, seekMedia: () => Promise.resolve(), executeManagedMediaEvent: () => Promise.resolve(),
      recordLog: (entry: Parameters<LinkDesktopApi['recordLog']>[0]) => Promise.resolve({ ...entry, id: 'log', sessionId: 'test', timestamp: '2026-11-09T00:00:00Z', monotonicMs: time }) }) });
  const requests = new NativeObsRequests(host, () => Promise.resolve());
  // As in the main process: the picture sees each device clock sample before the program does.
  const emit = (patch: Partial<NativePlayerStatus>): NativePlayerStatus => {
    if (!audio) throw new Error('没有准备音频');
    const status: NativePlayerStatus = { ...audio, ...patch }; audio = status;
    host.observe(status, (process.hrtime.bigint() / 100n).toString());
    for (const listener of audioListeners) listener(status);
    return status;
  };
  const player = new NativeProgramPlayer(project, 'C:/shows/auto.tblink', 1, {
    prepare: () => Promise.resolve(), ingest: () => Promise.resolve(), pause: () => Promise.resolve(), stop: () => Promise.resolve(),
    resolveAudio: () => Promise.reject(new Error('原生播放不用音源地址')),
    configuration: () => ({ outputDeviceId: 'default', mtcPortName: null, audioSampleRate: 48000, preload: false }),
    changed: next => { state = next; }, notice: message => { notices.push(message); }
  }, {
    prepareNativePlayback: request => {
      const { snapshot } = request;
      audio = { version: 1, sessionId: request.sessionId, generation: request.generation, itemId: snapshot.itemId, status: 'ready', positionMs: snapshot.positionMs,
        offsetMs: snapshot.offsetMs, sampleRate: snapshot.sampleRate, enginePid: 1, engineTitle: '测试', mtcPortName: null, mtcSent: 0,
        audioError: null, mtcError: null, underruns: 0, mtcInterruptions: 0, gain: snapshot.volume, analysis: null };
      return Promise.resolve(emit({}));
    },
    controlNativePlayback: command => {
      // The audio request reaches the picture before the engine answers (beforeControl).
      host.interrupt(command);
      const patch: Partial<NativePlayerStatus> = { generation: command.generation };
      switch (command.kind) {
        case 'play': patch.status = 'playing'; break;
        case 'pause': patch.status = 'paused'; break;
        case 'seek': patch.status = 'paused'; patch.positionMs = command.positionMs; break;
        case 'stop': patch.status = 'stopped'; break;
        case 'stop-mtc': patch.mtcPortName = null; break;
        case 'volume': patch.gain = command.volume; break;
      }
      return Promise.resolve(emit(patch));
    },
    getNativePlaybackDevices: () => Promise.resolve({ protocol: 4, audio: [], midiOutputs: [], midiInputs: [] }),
    onNativePlaybackStatus: listener => { audioListeners.add(listener); return () => { audioListeners.delete(listener); }; },
    prepareNativeObs: request => requests.prepare(request), stopNativeObs: request => requests.stop(request),
    onNativeObsStatus: listener => { obsListeners.add(listener); return () => { obsListeners.delete(listener); }; },
    preloadNativeObs: () => Promise.resolve(), cancelNativeObsPreload: () => Promise.resolve()
  }, { prepare: () => Promise.resolve(), cancelPreparation: () => undefined, release: () => Promise.resolve() });
  await player.play('a');
  await vi.waitFor(() => expect(execute.mock.calls.map(([action]) => action.id)).toEqual(['scene-a']));
  releaseOutputs.mockRejectedValueOnce(new Error('OBS 无响应'));
  for (time = 50; time <= 2000; time += 50) {
    emit({ status: time === 2000 ? 'ended' : 'playing', positionMs: time }); await new Promise(resolve => setTimeout(resolve, 0));
  }
  await vi.waitFor(() => expect(execute.mock.calls.map(([action]) => action.id)).toEqual(['scene-a', 'scene-b']));
  expect(state).toMatchObject({ status: 'playing', itemId: 'b', fault: '上一首的画面没有清理干净，这一首照常播。原因：画面没有清理干净：OBS 无响应' });
  expect(notices.filter(notice => notice.includes('清理'))).toEqual([]);
  expect(failures).toEqual(['画面没有清理干净：OBS 无响应']);
  await player.dispose();
  expect(failures).toEqual(['画面没有清理干净：OBS 无响应']); expect(releaseOutputs).toHaveBeenCalledTimes(2);
});

it('下一首接手的提前准备失败、清理也失败：下一首照常准备并按时间线切画面，两个原因都在下一首上标红，各记一次（2026-11-09）', async () => {
  const test = setup(), failures: string[] = [], created: NativeObsOutputs[] = [];
  let time = 0, failLookahead: (error: Error) => void = () => { throw new Error('下一首还没开始预热'); };
  const execute = vi.fn<(action: LinkAction) => Promise<void>>(() => Promise.resolve());
  const create = (): NativeObsOutputs => {
    const outputs: NativeObsOutputs = { executor: { id: 'test', supports: () => true, execute },
      guardOutput: <T>(_canSend: () => boolean, operation: () => Promise<T>) => operation(), prepareOutputs: () => Promise.resolve(),
      releaseOutputs: vi.fn(() => Promise.resolve()), restoreScenes: () => Promise.resolve(),
      preloadResources: (_current, phase) => phase === 'background' ? new Promise<void>((_resolve, reject) => { failLookahead = reject; }) : Promise.resolve(),
      now: () => time, seekMedia: () => Promise.resolve(), executeManagedMediaEvent: () => Promise.resolve(),
      recordLog: entry => Promise.resolve({ ...entry, id: 'log', sessionId: 'test', timestamp: '2026-11-09T00:00:00Z', monotonicMs: time }) };
    created.push(outputs); return outputs;
  };
  // Wired as in link-main.
  const pool = new NativeObsPreloadPool({ authorize: () => Promise.resolve(), create, report: message => host.report(message) });
  const host = new NativeObsHost({ audio: () => test.audio(), changed: () => undefined, error: message => failures.push(message),
    outputs: (request, positionMs, assertCurrent) => pool.take(request, positionMs, assertCurrent),
    prepareNextFiles: async (request, assertCurrent) => { await pool.prepareNext(request, assertCurrent); } });
  const observe = (patch: Partial<NativePlayerStatus>, at: number): void => { time = at; test.change(patch); host.observe(test.audio(), (process.hrtime.bigint() / 100n).toString()); };
  await host.prepare({ ...test.request, nextFiles: { snapshot: test.song('next', 1).snapshot, positionMs: 0 } });
  observe({ status: 'playing', positionMs: 0 }, 0);
  await vi.waitFor(() => expect(created).toHaveLength(2));
  // The song ends while the next song's picture is still being prepared in the background; the next song takes it over.
  observe({ status: 'ended', positionMs: 50 }, 50);
  await host.stopOwned({ version: 1, sessionId: test.request.sessionId, generation: 1 });
  test.change({ generation: 2, itemId: 'next', status: 'ready', positionMs: 0 });
  const preparing = host.prepare(test.song('next', 2));
  vi.mocked(created[1]!.releaseOutputs).mockRejectedValueOnce(new Error('画面没有清理干净：OBS 停止 请求排队超时（2000 ms）；还没发送'));
  failLookahead(new Error('OBS 预热素材静音 请求排队超时（2000 ms）；还没发送'));
  await expect(preparing).resolves.toMatchObject({ state: 'ready', itemId: 'next',
    fault: '提前准备的画面没能用上，已改为重新准备。原因：OBS 预热素材静音 请求排队超时（2000 ms）；还没发送；提前准备的画面没有清理干净，不影响播放。原因：画面没有清理干净：OBS 停止 请求排队超时（2000 ms）；还没发送' });
  expect(created).toHaveLength(3);
  observe({ status: 'playing', generation: 2, positionMs: 0 }, 1000);
  await vi.waitFor(() => expect(execute.mock.calls.map(([action]) => action.id)).toEqual(['scene-0', 'next-scene-0']));
  expect(failures).toEqual(['提前准备的画面没能用上，已改为重新准备。原因：OBS 预热素材静音 请求排队超时（2000 ms）；还没发送',
    '提前准备的画面没有清理干净，不影响播放。原因：画面没有清理干净：OBS 停止 请求排队超时（2000 ms）；还没发送']);
  await host.stop();
});

it('画面资源交接后被新的操作取消：照常报取消；释放失败另报一次，不顶替取消', async () => {
  const test = setup(), failures: string[] = [];
  let handOver: () => void = () => { throw new Error('还没开始交接'); };
  const releaseOutputs = vi.fn(() => Promise.reject(new Error('OBS 无响应')));
  const host = new NativeObsHost({ audio: () => test.audio(), changed: () => undefined, error: message => failures.push(message),
    outputs: () => new Promise(resolve => { handOver = () => resolve({ executor: { id: 'test', supports: () => true, execute: () => Promise.resolve() },
      guardOutput: <T>(_canSend: () => boolean, operation: () => Promise<T>) => operation(), prepareOutputs: () => Promise.resolve(), releaseOutputs,
      now: () => 0, seekMedia: () => Promise.resolve(), executeManagedMediaEvent: () => Promise.resolve(),
      recordLog: (entry: Parameters<LinkDesktopApi['recordLog']>[0]) => Promise.resolve({ ...entry, id: 'log', sessionId: 'test', timestamp: '2026-11-09T00:00:00Z', monotonicMs: 0 }) }); }) });
  const preparing = expect(host.prepare(test.request)).rejects.toThrow('画面资源交接已取消');
  // The operator stops while the picture resources are still being handed over.
  await host.stop(); handOver(); await preparing;
  expect(releaseOutputs).toHaveBeenCalledOnce();
  expect(failures).toEqual(['取消的画面准备没有清理干净，不影响播放。原因：OBS 无响应']);
  // That song never got its picture, so the message stays in the log; a later song does not show it.
  const next = host.prepare(test.request); handOver();
  expect((await next).fault ?? null).toBeNull();
  expect(failures).toHaveLength(1);
});

it('别处没人报告的预备清理失败交给宿主：只记一次；有歌在播就标红；歌还在准备时等它有了画面状态再标红；没有歌时只记录', async () => {
  const test = setup();
  test.host.report('甲'); expect(test.host.status).toBeNull();
  // Nothing played when it happened: not carried over to a later song.
  expect((await test.host.prepare(test.request)).fault ?? null).toBeNull();
  test.observe({ status: 'playing', generation: 1, positionMs: 0 }, 0);
  test.host.report('乙'); expect(test.host.status).toMatchObject({ state: 'running', fault: '乙' });
  let release: () => void = () => { throw new Error('还没开始清理'); };
  test.releaseOutputs.mockReturnValueOnce(new Promise<void>(resolve => { release = resolve; }));
  test.change({ generation: 2, status: 'ready', positionMs: 0 });
  const preparing = test.host.prepare({ ...test.request, generation: 2 });
  await vi.waitFor(() => expect(test.releaseOutputs).toHaveBeenCalledOnce());
  test.host.report('丙'); release();
  await expect(preparing).resolves.toMatchObject({ state: 'ready', generation: 2, fault: '丙' });
  expect(test.failures).toEqual(['甲', '乙', '丙']);
  await test.host.stop();
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

it('正式画面准备一开始就算忙，选中歌曲的预备不能停掉它；停止后空闲', async () => {
  const test = setup();
  expect(test.host.busy).toBe(false);
  const preparing = test.host.prepare(test.request);
  expect(test.host.busy).toBe(true);
  await preparing; expect(test.host.busy).toBe(true);
  await test.host.stop(); expect(test.host.busy).toBe(false);
});
