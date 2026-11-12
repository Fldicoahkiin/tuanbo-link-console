import { expect, it, vi } from 'vitest';
import { createObsProgramSnapshot, emptyInternalPlayerState, NativeProgramPlayer, ObsPictureLeftover, type InternalPlayerState, type LinkDesktopApi } from '@tb/core/link';
import { createEmptyLinkProject, parseLinkProject, type LinkAction, type NativePlayerControl, type NativePlayerStatus, type NativeObsPrepare, type NativeObsStatus, type NativeObsStop } from '@tb/schema';
import { NativeObsHost, type PictureRecoveryLog } from './native-obs-host';
import { NativeObsRequests } from './native-obs-requests';
import { NativeObsPreloadPool } from './native-obs-preload';
import { ObsPreparationCancelled, type NativeObsOutputs } from './native-obs-outputs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NativePlaybackClient } from './native-playback-client';

/** A failed picture cleanup as the operator reads it: what failed, why (no code prefixes, said once), what to check. */
const LEFTOVER = 'OBS 无响应。请检查 OBS 节目画面上是否还留着刚才的素材';

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
  const prepareOutputs = vi.fn<(assertCurrent: () => void) => Promise<void>>(() => Promise.resolve()), recoveries: PictureRecoveryLog[] = [];
  const request: NativeObsPrepare = { version: 1, sessionId: audio.sessionId, generation: 1, preciseSeeking: false, projectPath: 'C:/shows/test.tblink', snapshot: createObsProgramSnapshot(project, 'song', 4) };
  const host = new NativeObsHost({ audio: () => audio, changed: state => states.push(state), error: message => failures.push(message),
    prepareNextFiles, recovered: entry => recoveries.push(entry),
    outputs: () => ({ executor: { id: 'test', supports: () => true, execute },
      guardOutput: <T>(_canSend: () => boolean, operation: () => Promise<T>) => operation(),
      prepareOutputs, releaseOutputs, restoreScenes,
      now: () => now, seekMedia: () => Promise.resolve(), executeManagedMediaEvent: () => Promise.resolve(),
      recordLog: (entry: Parameters<LinkDesktopApi['recordLog']>[0]) => Promise.resolve({ ...entry, id: 'log', sessionId: 'test', timestamp: '2026-10-06T00:00:00Z', monotonicMs: now }) }) });
  const observe = (patch: Partial<NativePlayerStatus>, time: number, ageMs = 0) => { now = time; audio = { ...audio, ...patch }; host.observe(audio, ((process.hrtime.bigint() - BigInt(ageMs) * 1000000n) / 100n).toString()); };
  return { host, request, execute, releaseOutputs, restoreScenes, prepareOutputs, recoveries, failures, states, observe, prepareNextFiles, time: (value: number) => { now = value; }, audio: () => audio, change: (patch: Partial<NativePlayerStatus>) => { audio = { ...audio, ...patch }; },
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
  // A stop of this song cancels it; that is not a failed preparation (no false 素材没有准备好 in the log).
  await test.host.stop(); expect(() => assertCurrent?.()).toThrow(ObsPreparationCancelled);
});

it('当前这首停了：下一个节目的文件准备按取消结束，不记失败；停了以后真的失败照样记一次（2026-11-09）', async () => {
  let finish: (error?: Error) => void = () => { throw new Error('还没开始准备'); };
  // Ends with its own check of the song, as the real preparation does after each step.
  const prepare = vi.fn<(_request: NativeObsPrepare, current: () => void) => Promise<void>>((_request, current) =>
    new Promise<void>((resolve, reject) => { finish = error => { if (error) reject(error); else resolve(); }; }).then(() => current()));
  const test = setup(prepare);
  for (const generation of [1, 2]) {
    test.change({ generation, status: 'ready', positionMs: 0 });
    await test.host.prepare({ ...test.request, generation, nextFiles: { snapshot: test.song('next', 1).snapshot, positionMs: 0 } });
    test.observe({ status: 'playing', generation, positionMs: 0 }, generation * 1000);
    await test.host.stop();
    // The first ends at its own check after the stop; the second fails for real once this song stopped.
    if (generation === 1) finish(); else finish(new Error('OBS 读取目录失败：GetSceneList 请求排队超时（2000 ms）；还没发送'));
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(test.failures).toEqual(['准备下一个节目的文件失败：OBS 读取目录失败：GetSceneList 请求排队超时（2000 ms）；还没发送']);
});

it('正式画面准备被停止中断：传给素材准备的检查按取消结束，不当成素材没准备好（2026-11-09）', async () => {
  const test = setup(), failures: string[] = [];
  let check: (() => void) | null = null, release: () => void = () => { throw new Error('还没开始准备'); };
  const host = new NativeObsHost({ audio: () => test.audio(), changed: () => undefined, error: message => failures.push(message),
    outputs: () => ({ executor: { id: 'test', supports: () => true, execute: () => Promise.resolve() },
      guardOutput: <T>(_canSend: () => boolean, operation: () => Promise<T>) => operation(),
      prepareOutputs: current => { check = current; return new Promise<void>(resolve => { release = resolve; }); },
      releaseOutputs: () => Promise.resolve(), now: () => 0, seekMedia: () => Promise.resolve(), executeManagedMediaEvent: () => Promise.resolve(),
      recordLog: (entry: Parameters<LinkDesktopApi['recordLog']>[0]) => Promise.resolve({ ...entry, id: 'log', sessionId: 'test', timestamp: '2026-11-09T00:00:00Z', monotonicMs: 0 }) }) });
  const preparing = host.prepare(test.request).catch((error: unknown) => error);
  await vi.waitFor(() => expect(check).not.toBeNull());
  expect(() => check!()).not.toThrow();
  const stopping = host.stop();
  expect(() => check!()).toThrow(ObsPreparationCancelled);
  release(); await stopping; await preparing;
  expect(failures).toEqual([]);
});

it('跨工程或比当前节目更旧修订的下一节目不能随当前节目准备', async () => {
  const test = setup();
  test.request.nextFiles = { snapshot: { ...test.request.snapshot, revision: test.request.snapshot.revision - 1 }, positionMs: 0 };
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

it('画面按项列在状态里：一项补了还不行只标这一项，这首歌的画面照常；OBS 断了另列一项“连接”，连上就收回；断着时不补（2026-11-10 第 2 题，R5）', async () => {
  const test = setup();
  // 机位0 is refused every time; 机位1 goes through.
  test.execute.mockImplementation(action => action.kind === 'obs.setProgramScene' && action.sceneName === '机位0' ? Promise.reject(new Error('OBS 拒绝了')) : Promise.resolve());
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));
  await test.host.prepare(test.request); test.observe({ status: 'playing', positionMs: 0 }, 0); await flush();
  for (let time = 20; time <= 600; time += 20) { test.observe({ status: 'playing', positionMs: time }, time); await flush(); }
  // Refused, then repaired once, refused again: the program item has used up its one repair.
  expect(test.execute).toHaveBeenCalledTimes(2);
  expect(test.host.status).toMatchObject({ state: 'running', fault: '切换节目画面：这一项画面补发了一次还是没成功，到下一段会按时间线照常切换。请检查 OBS 里的这个场景或来源' });
  expect(test.host.status?.items).toEqual([{ id: 'program', scope: 'item', state: 'limit', detail: test.host.status?.fault }]);
  // The counts as output-recovery.ts keeps them: this item's one, and the song's 1 of 20.
  expect(test.host.status?.recoveries).toEqual([{ row: 'picture.element', key: 'program@["机位0","cue-0"]', count: 1, max: 1, exhausted: false },
    { row: 'picture.song', key: 'song', count: 1, max: 20, exhausted: false }]);
  // OBS drops: the connection is listed on its own, first, as waiting (R7); nothing is repaired while it is down.
  test.host.disconnect('网络断开');
  expect(test.host.status?.items?.[0]).toMatchObject({ id: 'obs.connection', scope: 'waiting', state: 'waiting' });
  test.execute.mockImplementation(() => Promise.reject(new Error('OBS 连接已断开')));
  for (let time = 620; time <= 1400; time += 20) { test.observe({ status: 'playing', positionMs: time }, time); await flush(); }
  const calls = test.execute.mock.calls.length;
  expect(calls).toBe(3);
  expect(test.host.status?.state).toBe('running');
  test.execute.mockImplementation(() => Promise.resolve());
  await test.host.reconnected(); await flush();
  expect(test.host.status?.items?.some(item => item.id === 'obs.connection')).toBe(false);
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

it('直播中 OBS 拒绝动作标红，按当时应有的画面补一次，通道继续后续画面，音频的状态和偏移不被改写（补一次：2026-11-10 第 2 题，R5）', async () => {
  const test = setup(); test.execute.mockRejectedValueOnce(new Error('OBS 断开'));
  await test.host.prepare(test.request); test.observe({ status: 'playing', positionMs: 0 }, 0);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(test.host.status).toMatchObject({ state: 'running', fault: '画面动作失败：切机位 · OBS 断开' });
  expect(test.audio()).toMatchObject({ status: 'playing', offsetMs: 480000 });
  for (let time = 100; time <= 1000; time += 100) { test.observe({ status: 'playing', positionMs: time }, time); await new Promise(resolve => setTimeout(resolve, 0)); }
  // The refused switch once more, then the next camera; the song's picture keeps running.
  expect(test.execute).toHaveBeenCalledTimes(3); expect(test.host.status?.currentCueId).toBe('cue-1');
  expect(test.host.status?.state).toBe('running');
});

// 设计 01 §3.2 第 13 行（R7）：画面还没准备好音乐就开始了，不再“这一首不联动画面”，准备好以后按当前位置接上。
it('初始化在途时音频先启动：画面照常准备完，到音乐的下一个位置按当前位置重建接上，不整首没画面', async () => {
  const test = setup(); test.change({ positionMs: 500 });
  let sent: () => void = () => { throw new Error('未初始化'); };
  let release: () => void = () => { throw new Error('未开始'); };
  const started = new Promise<void>(resolve => { sent = resolve; });
  test.execute.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; sent(); }));
  const preparing = test.host.prepare(test.request);
  await started;
  test.observe({ status: 'playing', generation: 2 }, 10);
  expect(test.host.status?.state).toBe('preparing');
  release(); await expect(preparing).resolves.toMatchObject({ state: 'ready' });
  test.observe({ status: 'playing', generation: 2, positionMs: 1200 }, 710); await vi.waitFor(() => expect(test.execute).toHaveBeenCalledTimes(2));
  expect(test.execute.mock.calls.map(([action]) => action.kind === 'obs.setProgramScene' ? action.sceneName : action.kind)).toEqual(['机位0', '机位1']);
  // OBS never went away here: the red text says the picture joined late, not that OBS reconnected.
  expect(test.host.status).toMatchObject({ state: 'running', fault: '这首歌的画面准备好时音乐已经在放了，画面已按当前位置恢复（1 项）' });
  await test.host.stop();
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

it('播放中重新连接 OBS，恢复的机位没切成：红字写明哪项没恢复、原因和怎么办，不用“已恢复”盖掉它，错误日志记一次（2026-11-09）', async () => {
  const test = setup(); await test.host.prepare(test.request);
  test.observe({ status: 'playing', generation: 2, positionMs: 0 }, 0);
  for (let time = 50; time <= 1500; time += 50) { test.observe({ positionMs: time }, time); await new Promise(resolve => setTimeout(resolve, 0)); }
  test.host.disconnect('OBS 网络断开');
  test.execute.mockRejectedValueOnce(new Error('OBS 无响应'));
  const logged = test.failures.length;
  await test.host.reconnected();
  expect(test.execute.mock.calls.at(-1)?.[0]).toMatchObject({ kind: 'obs.setProgramScene', sceneName: '机位1' });
  const missed = 'OBS 已重新连接，画面没有按当前位置恢复，切机位没有完成。原因：OBS 无响应。请在 OBS 里检查这一项，需要的话手动调好';
  expect(test.host.status).toMatchObject({ state: 'running', fault: missed });
  expect(test.failures.slice(logged)).toEqual([missed]);
});

it('重新连接 OBS 后恢复画面途中这首歌停了：恢复按取消结束，不当成素材没准备好，也不另记失败（2026-11-09）', async () => {
  const test = setup(); await test.host.prepare(test.request);
  test.observe({ status: 'playing', generation: 2, positionMs: 0 }, 0);
  for (let time = 50; time <= 500; time += 50) { test.observe({ positionMs: time }, time); await new Promise(resolve => setTimeout(resolve, 0)); }
  const gate = hold(), materials: string[] = [];
  let checked: unknown = null;
  // As the outputs prepare each material again: only what is not a cancellation is a material that failed to prepare.
  test.restoreScenes.mockImplementationOnce(async current => {
    await gate.wait();
    try { current(); } catch (error) { checked = error; if (!(error instanceof ObsPreparationCancelled)) materials.push(`素材没有准备好：${String(error)}`); throw error; }
  });
  test.host.disconnect('OBS 网络断开');
  const reconnecting = test.host.reconnected();
  await vi.waitFor(() => expect(gate.reached()).toBe(true));
  const stopping = test.host.stop(); gate.release(); await stopping; await reconnecting;
  expect(checked).toBeInstanceOf(ObsPreparationCancelled); expect(materials).toEqual([]);
  expect(test.failures).toEqual(['OBS 断开了：OBS 网络断开。音乐和时间码照常，画面先停在这里，OBS 重新连上后按当前位置接上']);
});

const flushHost = (): Promise<unknown> => new Promise(resolve => setTimeout(resolve, 0));
const LOST = 'OBS 断开了，这首歌的画面还没准备好。音乐和时间码照常，OBS 重新连上后按当前位置准备好画面接上';

// 设计 01 §3.2 第 10 行、§4.7（R7）：准备中断线不再取消这首歌的画面，算等待；OBS 回来以后按当前位置准备好接上。
it('准备阶段 OBS 断了：不取消，这首歌照常开播、画面标红等 OBS；连上后按当前位置重新准备，到音乐的下一个位置接上，算一次“重连后恢复画面”', async () => {
  const test = setup();
  let fail: () => void = () => { throw new Error('未开始'); };
  test.prepareOutputs.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = () => reject(new Error('OBS 已断开，准备好的画面不能用了')); }));
  const preparing = test.host.prepare(test.request);
  await vi.waitFor(() => expect(test.prepareOutputs).toHaveBeenCalled());
  test.host.disconnect('OBS 网络断开'); fail();
  await expect(preparing).resolves.toMatchObject({ state: 'ready', fault: LOST });
  expect(test.host.status?.items).toEqual([{ id: 'obs.connection', scope: 'waiting', state: 'waiting', detail: 'OBS 断开了：OBS 网络断开。音乐和时间码照常，画面先停在这里，OBS 重新连上后按当前位置接上' }]);
  test.observe({ status: 'playing', generation: 2, positionMs: 0 }, 0);
  for (let time = 100; time <= 1200; time += 100) { test.observe({ positionMs: time }, time); await flushHost(); }
  expect(test.execute).not.toHaveBeenCalled(); expect(test.host.status).toMatchObject({ state: 'running', fault: LOST });
  await test.host.reconnected();
  expect(test.prepareOutputs).toHaveBeenCalledTimes(2);
  expect(test.host.status?.recoveries).toEqual([{ row: 'obs.restore', key: 'song', count: 1, max: 5, exhausted: false }]);
  expect(test.recoveries).toEqual([{ level: 'warning', message: 'OBS 重新连上了，按当前位置恢复这首歌的画面（第 1 次，最多 5 次）', result: 'succeeded',
    projectId: test.request.snapshot.projectId, itemId: 'song', details: { channel: 'obs', item: 'obs.restore', recoveries: [{ row: 'obs.restore', key: 'song', count: 1, max: 5 }] } }]);
  test.observe({ positionMs: 1300 }, 1300);
  await vi.waitFor(() => expect(test.host.status?.fault).toBe('OBS 已重新连接，画面已按当前位置恢复（1 项）'));
  expect(test.execute.mock.calls.map(([action]) => action.kind === 'obs.setProgramScene' ? action.sceneName : action.kind).at(-1)).toBe('机位1');
  expect(test.host.status?.state).toBe('running'); expect(test.host.status?.items).toEqual([]);
  for (let time = 1400; time <= 2000; time += 100) { test.observe({ positionMs: time }, time); await flushHost(); }
  expect(test.host.status?.state).toBe('running');
  await test.host.stop();
});

it('准备好了还没开播时 OBS 断了又连上：不马上动，开播时先补回自有场景再按当前位置重建（R7）', async () => {
  const test = setup(); await test.host.prepare(test.request);
  test.host.disconnect('OBS 网络断开'); await test.host.reconnected();
  expect(test.restoreScenes).not.toHaveBeenCalled(); expect(test.host.status?.state).toBe('ready');
  test.observe({ status: 'playing', generation: 2, positionMs: 0 }, 0);
  await vi.waitFor(() => expect(test.host.status?.fault).toBe('OBS 已重新连接，画面已按当前位置恢复（1 项）'));
  expect(test.restoreScenes).toHaveBeenCalledOnce();
  await test.host.stop();
});

it('一首歌里 OBS 重连后恢复画面最多 5 次：第 6 次不再恢复，标红写明，记一条错误日志；音乐照常（R7，output-recovery.ts obs.restore）', async () => {
  const test = setup(); await test.host.prepare(test.request);
  test.observe({ status: 'playing', generation: 2, positionMs: 0 }, 0);
  for (let time = 50; time <= 500; time += 50) { test.observe({ positionMs: time }, time); await flushHost(); }
  for (let round = 1; round <= 6; round++) { test.host.disconnect('OBS 网络断开'); await test.host.reconnected(); }
  expect(test.restoreScenes).toHaveBeenCalledTimes(5);
  const limit = 'OBS 重连后恢复画面的次数已到上限，这首歌的画面不再自动恢复，音乐和时间码照常';
  expect(test.host.status).toMatchObject({ state: 'running', fault: limit });
  expect(test.host.status?.items).toContainEqual({ id: 'obs.restore', scope: 'item', state: 'limit', detail: limit });
  expect(test.host.status?.recoveries?.[0]).toEqual({ row: 'obs.restore', key: 'song', count: 5, max: 5, exhausted: true });
  expect(test.recoveries.map(entry => [entry.level, entry.details.recoveries[0]!.count])).toEqual([['warning', 1], ['warning', 2], ['warning', 3], ['warning', 4], ['warning', 5], ['error', 5]]);
  // The next song starts again from 0.
  test.change({ generation: 3, itemId: 'next', status: 'ready', positionMs: 0 });
  await test.host.prepare(test.song('next', 3));
  test.host.disconnect('OBS 网络断开'); await test.host.reconnected();
  expect(test.recoveries.at(-1)).toMatchObject({ level: 'warning', itemId: 'next', details: { recoveries: [{ count: 1 }] } });
  await test.host.stop();
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

it('上一次的画面清理失败、节目自己的停止没收到：同一首重新准备时照常按时间线切画面，在这一首上标红一次、只记一次，之后每一首不再显示', async () => {
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
  expect(faults).toEqual([`上一次的画面没有清理干净，这一首照常播。原因：${LEFTOVER}`, undefined]);
  expect(test.failures).toEqual(['画面没有清理干净：OBS 无响应']);
  await test.host.stop();
});

it('停止时画面清理失败：节目自己的停止收到一次；之后的停止、选歌预备和下一首都不再失败、不再重复，也不重做清理（2026-11-09）', async () => {
  const test = setup(); await test.host.prepare(test.request);
  test.observe({ status: 'playing', generation: 1, positionMs: 0 }, 0);
  await vi.waitFor(() => expect(test.execute).toHaveBeenCalledTimes(1));
  test.releaseOutputs.mockRejectedValueOnce(new Error('OBS 无响应'));
  // The operator stops: the audio stop reaches the picture first, then the program stops its own picture.
  test.host.interrupt({ version: 1, sessionId: test.request.sessionId, generation: 2, kind: 'stop' });
  const own: NativeObsStop = { version: 1, sessionId: test.request.sessionId, generation: 1 };
  const heard = await test.host.stopOwned(own).then(() => null, (error: unknown) => error);
  expect(heard).toBeInstanceOf(ObsPictureLeftover); expect(heard).toMatchObject({ message: LEFTOVER, itemId: 'song' });
  await expect(test.host.stopOwned(own)).resolves.toBeUndefined();
  // While stopped, each song the operator selects first makes sure no picture is on air (link-main's authorize).
  const select = async (): Promise<void> => { if (test.host.busy) throw new Error('正在播放时不能准备另一个节目'); await test.host.stop(); };
  for (let count = 0; count < 3; count++) await expect(select()).resolves.toBeUndefined();
  expect(test.host.status?.state).toBe('stopped');
  test.change({ generation: 3, itemId: 'next', status: 'ready', positionMs: 0 });
  expect((await test.host.prepare(test.song('next', 3))).fault ?? null).toBeNull();
  expect(test.failures).toEqual(['画面没有清理干净：OBS 无响应']); expect(test.releaseOutputs).toHaveBeenCalledOnce();
  await test.host.stop();
});

it('上一首停止时画面清理失败、节目自己的停止没收到：下一首照常准备、按时间线切画面，失败在下一首上标红一次；上一首迟到的停止按过期处理（2026-11-09）', async () => {
  const test = setup(); await test.host.prepare(test.request);
  test.observe({ status: 'playing', generation: 1, positionMs: 0 }, 0);
  await vi.waitFor(() => expect(test.execute).toHaveBeenCalledTimes(1));
  test.releaseOutputs.mockRejectedValueOnce(new Error('OBS 无响应'));
  test.host.interrupt({ version: 1, sessionId: test.request.sessionId, generation: 2, kind: 'stop' });
  test.change({ generation: 3, itemId: 'next', status: 'ready', positionMs: 0 });
  await expect(test.host.prepare(test.song('next', 3))).resolves.toMatchObject({ state: 'ready', itemId: 'next',
    fault: `上一首的画面没有清理干净，这一首照常播。原因：${LEFTOVER}` });
  // The previous song's own stop arriving now is stale: it neither stops this song nor repeats the failure.
  await expect(test.host.stopOwned({ version: 1, sessionId: test.request.sessionId, generation: 1 })).rejects.toThrow('上一次准备');
  test.observe({ status: 'playing', generation: 3, positionMs: 0 }, 1000);
  await vi.waitFor(() => expect(test.execute).toHaveBeenCalledTimes(2));
  expect(test.execute.mock.calls.at(-1)?.[0]).toMatchObject({ sceneName: '下一首机位0' });
  expect(test.host.status).toMatchObject({ state: 'running', itemId: 'next' });
  expect(test.failures).toEqual(['画面没有清理干净：OBS 无响应']);
  await test.host.stopOwned({ version: 1, sessionId: test.request.sessionId, generation: 3 });
  test.change({ generation: 4, itemId: 'song', status: 'ready', positionMs: 0 });
  expect((await test.host.prepare(test.song('song', 4))).fault ?? null).toBeNull();
  await test.host.stop();
});

type ProgramOptions = {
  endAction?: 'next' | 'stop';
  /** When each song switches cameras, in seconds: `scene-<song>` at 0 s, `scene-<song>-<seconds>` after it. */
  cueSeconds?: readonly number[];
  /** Wired as in link-main: each song takes its picture from the preload pool, which prepares the next song's while this one plays. */
  pool?: boolean;
  /** Changes the outputs of the nth picture prepared (counted from 0). */
  outputs?: (base: NativeObsOutputs, index: number) => NativeObsOutputs;
  /** Holds an audio command after the picture heard it, before the engine answers. */
  beforeAnswer?: (command: NativePlayerControl) => Promise<void> | undefined;
};

/** The real program on the real picture host, wired as in the main process, with songs a and b. */
function program(endActionOrOptions: 'next' | 'stop' | ProgramOptions) {
  const options = typeof endActionOrOptions === 'string' ? { endAction: endActionOrOptions } : endActionOrOptions;
  const endAction = options.endAction ?? 'next', cueSeconds = options.cueSeconds ?? [0];
  const project = parseLinkProject({ ...createEmptyLinkProject('自动下一首'), playbackSource: 'internal', obsOutputMode: 'scenes',
    rundown: ['a', 'b'].map((id, index) => ({ id, title: id, referenceAudio: { assetId: `audio-${id}`, relativePath: `${id}.wav`, sha256: 'a'.repeat(64), durationMs: 4000 },
      playback: { startMs: 0, endMs: 2000, mtcOffsetMs: 480000 + index * 20000, volume: 80, endAction, shortcut: '' },
      cues: cueSeconds.map(seconds => ({ id: seconds ? `cue-${id}-${seconds}` : `cue-${id}`, name: '机位', timecode: { hours: 0, minutes: 0, seconds, frames: 0 },
        actions: [{ id: seconds ? `scene-${id}-${seconds}` : `scene-${id}`, kind: 'obs.setProgramScene', label: '切机位', sceneName: `机位-${id}-${seconds}` }] })) })) });
  let audio: NativePlayerStatus | null = null, state: InternalPlayerState = { ...emptyInternalPlayerState }, time = 0;
  const audioListeners = new Set<(status: NativePlayerStatus) => void>(), obsListeners = new Set<(status: NativeObsStatus) => void>();
  const failures: string[] = [], notices: string[] = [], created: NativeObsOutputs[] = [];
  const execute = vi.fn<(action: LinkAction) => Promise<void>>(() => Promise.resolve()), releaseOutputs = vi.fn(() => Promise.resolve());
  const make = (): NativeObsOutputs => {
    const base: NativeObsOutputs = { executor: { id: 'test', supports: () => true, execute },
      guardOutput: <T>(_canSend: () => boolean, operation: () => Promise<T>) => operation(), prepareOutputs: () => Promise.resolve(), releaseOutputs,
      restoreScenes: () => Promise.resolve(), preloadResources: current => { current(); return Promise.resolve(); },
      now: () => time, seekMedia: () => Promise.resolve(), executeManagedMediaEvent: () => Promise.resolve(),
      recordLog: (entry: Parameters<LinkDesktopApi['recordLog']>[0]) => Promise.resolve({ ...entry, id: 'log', sessionId: 'test', timestamp: '2026-11-09T00:00:00Z', monotonicMs: time }) };
    const outputs = options.outputs?.(base, created.length) ?? base;
    created.push(outputs); return outputs;
  };
  let host: NativeObsHost | null = null;
  const pictures = (): NativeObsHost => { if (!host) throw new Error('画面宿主还没建好'); return host; };
  const pool = options.pool ? new NativeObsPreloadPool({ authorize: async () => { if (pictures().busy) throw new Error('正在播放时不能准备另一个节目'); await pictures().stop(); },
    create: () => make(), report: failure => pictures().report(failure) }) : null;
  host = new NativeObsHost({ audio: () => audio, error: message => failures.push(message),
    changed: status => { for (const listener of obsListeners) listener(status); },
    outputs: (request, positionMs, assertCurrent) => pool ? pool.take(request, positionMs, assertCurrent) : make(),
    ...pool ? { prepareNextFiles: async (request: NativeObsPrepare, assertCurrent: () => void) => { assertCurrent(); await pool.prepareNext(request, assertCurrent); } } : {} });
  const requests = new NativeObsRequests(host, () => Promise.resolve());
  // As in the main process: the picture sees each device clock sample before the program does.
  const emit = (patch: Partial<NativePlayerStatus>): NativePlayerStatus => {
    if (!audio) throw new Error('没有准备音频');
    const status: NativePlayerStatus = { ...audio, ...patch }; audio = status;
    pictures().observe(status, (process.hrtime.bigint() / 100n).toString());
    for (const listener of audioListeners) listener(status);
    return status;
  };
  /** A program as the window opens it; a later one is the next program on the same picture host (another or the same project). */
  const open = (): NativeProgramPlayer => new NativeProgramPlayer(project, 'C:/shows/auto.tblink', 1, {
    prepare: () => Promise.resolve(), ingest: () => Promise.resolve(), pause: () => Promise.resolve(), stop: () => Promise.resolve(),
    resolveAudio: () => Promise.reject(new Error('原生播放不用音源地址')),
    configuration: () => ({ outputDeviceId: 'default', mtcPortName: null, audioSampleRate: 48000, preload: Boolean(pool) }),
    changed: next => { state = next; }, notice: message => { notices.push(message); }, closedFault: message => { failures.push(message); }
  }, {
    prepareNativePlayback: request => {
      const { snapshot } = request;
      audio = { version: 1, sessionId: request.sessionId, generation: request.generation, itemId: snapshot.itemId, status: 'ready', positionMs: snapshot.positionMs,
        offsetMs: snapshot.offsetMs, sampleRate: snapshot.sampleRate, enginePid: 1, engineTitle: '测试', mtcPortName: null, mtcSent: 0,
        audioError: null, mtcError: null, underruns: 0, mtcInterruptions: 0, gain: snapshot.volume, analysis: null };
      return Promise.resolve(emit({}));
    },
    controlNativePlayback: async command => {
      // The audio request reaches the picture before the engine answers (beforeControl).
      pictures().interrupt(command);
      if (pool && (command.kind === 'stop' || command.kind === 'seek')) void pool.cancelNext(command.sessionId).catch((error: unknown) => failures.push(String(error)));
      await options.beforeAnswer?.(command);
      const patch: Partial<NativePlayerStatus> = { generation: command.generation };
      switch (command.kind) {
        case 'play': patch.status = 'playing'; break;
        case 'pause': patch.status = 'paused'; break;
        case 'seek': patch.status = 'paused'; patch.positionMs = command.positionMs; break;
        case 'stop': patch.status = 'stopped'; break;
        case 'stop-mtc': patch.mtcPortName = null; break;
        case 'volume': patch.gain = command.volume; break;
      }
      return emit(patch);
    },
    getNativePlaybackDevices: () => Promise.resolve({ protocol: 4, audio: [], midiOutputs: [], midiInputs: [] }),
    onNativePlaybackStatus: listener => { audioListeners.add(listener); return () => { audioListeners.delete(listener); }; },
    prepareNativeObs: request => requests.prepare(request), stopNativeObs: request => requests.stop(request),
    onNativeObsStatus: listener => { obsListeners.add(listener); return () => { obsListeners.delete(listener); }; },
    preloadNativeObs: () => Promise.resolve(), cancelNativeObsPreload: () => Promise.resolve()
  }, { change: () => Promise.resolve({ failed: [] }), stop: () => Promise.resolve({ failed: [] }), widen: () => undefined });
  /** The music plays on from `from` to `to` ms (the end of the song is 2000 ms). */
  const playTo = async (from: number, to: number): Promise<void> => {
    const start = time - from;
    for (let positionMs = from + 50; positionMs <= to; positionMs += 50) {
      time = start + positionMs; emit({ status: positionMs >= 2000 ? 'ended' : 'playing', positionMs }); await new Promise(resolve => setTimeout(resolve, 0));
    }
  };
  return { player: open(), open, host, execute, releaseOutputs, created, failures, notices, state: () => state, playTo, playToEnd: () => playTo(0, 2000),
    ids: () => execute.mock.calls.map(([action]) => action.id) };
}

it('自动下一首时上一首的画面清理失败：播放器在下一首上标红一次，没有另外的提示，只记一次，下一首照常切画面（2026-11-09）', async () => {
  const t = program('next');
  await t.player.play('a');
  await vi.waitFor(() => expect(t.execute.mock.calls.map(([action]) => action.id)).toEqual(['scene-a']));
  t.releaseOutputs.mockRejectedValueOnce(new Error('OBS 无响应'));
  await t.playToEnd();
  await vi.waitFor(() => expect(t.execute.mock.calls.map(([action]) => action.id)).toEqual(['scene-a', 'scene-b']));
  expect(t.state()).toMatchObject({ status: 'playing', itemId: 'b', fault: `上一首的画面没有清理干净，这一首照常播。原因：${LEFTOVER}` });
  expect(t.state().notice ?? '').not.toContain('清理'); expect(t.notices.filter(notice => notice.includes('清理'))).toEqual([]);
  expect(t.failures).toEqual(['画面没有清理干净：OBS 无响应']);
  await t.player.dispose();
  expect(t.failures).toEqual(['画面没有清理干净：OBS 无响应']); expect(t.releaseOutputs).toHaveBeenCalledTimes(2);
});

it.each([['按停止', 'next'], ['播完就停的歌播完', 'stop']] as const)('%s时画面清理失败：停下的播放器马上提示一次，只有画面那边记一次；之后再播歌不再显示、不再记录（2026-11-09）', async (_case, endAction) => {
  const t = program(endAction);
  await t.player.play('a');
  await vi.waitFor(() => expect(t.execute).toHaveBeenCalledTimes(1));
  t.releaseOutputs.mockRejectedValueOnce(new Error('OBS 无响应'));
  if (endAction === 'stop') await t.playToEnd(); else await t.player.stop();
  await vi.waitFor(() => expect(t.state()).toMatchObject({ status: 'stopped', fault: null, notice: `画面清理失败：${LEFTOVER}` }));
  expect(t.failures).toEqual(['画面没有清理干净：OBS 无响应']);
  await t.player.play('b');
  await vi.waitFor(() => expect(t.execute.mock.calls.map(([action]) => action.id)).toEqual(['scene-a', 'scene-b']));
  expect(t.state()).toMatchObject({ status: 'playing', itemId: 'b', fault: null });
  expect(t.state().notice ?? '').not.toContain('清理');
  expect(t.failures).toEqual(['画面没有清理干净：OBS 无响应']);
  expect(t.notices.filter(notice => notice.includes('清理'))).toEqual([]);
  await t.player.dispose();
});

it('关闭节目时画面清理失败：只记一次，关闭照常完成；之后打开的节目照常播，失败在它的第一首歌上标红一次（2026-11-09）', async () => {
  const t = program('next');
  await t.player.play('a');
  await vi.waitFor(() => expect(t.execute).toHaveBeenCalledTimes(1));
  t.releaseOutputs.mockRejectedValueOnce(new Error('OBS 无响应'));
  await expect(t.player.dispose()).resolves.toBeUndefined();
  expect(t.failures).toEqual(['画面没有清理干净：OBS 无响应']); expect(t.releaseOutputs).toHaveBeenCalledOnce();
  // The next program on the same picture host: the reloaded window, or another project.
  const next = t.open();
  await next.play('b');
  await vi.waitFor(() => expect(t.ids()).toEqual(['scene-a', 'scene-b']));
  expect(t.state()).toMatchObject({ status: 'playing', itemId: 'b', fault: `上一首的画面没有清理干净，这一首照常播。原因：${LEFTOVER}` });
  await next.play('a');
  await vi.waitFor(() => expect(t.ids()).toEqual(['scene-a', 'scene-b', 'scene-a']));
  expect(t.state()).toMatchObject({ status: 'playing', itemId: 'a', fault: null });
  expect(t.failures).toEqual(['画面没有清理干净：OBS 无响应']);
  expect(t.notices.filter(notice => notice.includes('清理'))).toEqual([]);
  await next.dispose();
});

// 修复前：之后打开的节目第一首已经在等这次清理时，清理失败交还给了已经换掉的那一首，没人再收，红字一直不出来，只留在日志里。
it('关闭节目时画面还在清理、之后打开的节目第一首已经在等这次清理：清理失败在这首歌上标红一次（2026-11-09）', async () => {
  vi.useFakeTimers();
  try {
    const gate = hold();
    let refuse: (error: Error) => void = () => { throw new Error('还没开始清理'); };
    const cleaning = vi.fn(() => new Promise<void>((_resolve, reject) => { refuse = reject; }));
    // Songs without picture work give their picture one second; OBS answers neither the first picture nor its cleanup in time.
    const t = program({ cueSeconds: [], outputs: (base, index) => index === 0 ? { ...base, prepareOutputs: gate.wait, releaseOutputs: cleaning } : base });
    const playing = t.player.play('a');
    await vi.advanceTimersByTimeAsync(1100); await playing;
    expect(t.state()).toMatchObject({ status: 'playing', itemId: 'a' });
    gate.release();
    await vi.waitFor(() => expect(cleaning).toHaveBeenCalledOnce());
    // The window reloads, or another project opens: the program closes while that cleanup still waits on OBS.
    await expect(t.player.dispose()).resolves.toBeUndefined();
    const next = t.open(), prepare = vi.spyOn(t.host, 'prepare');
    const starting = next.play('b');
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    refuse(new Error('OBS 无响应'));
    await starting;
    await vi.waitFor(() => expect(t.state()).toMatchObject({ status: 'playing', itemId: 'b', fault: `上一首的画面没有清理干净，这一首照常播。原因：${LEFTOVER}` }));
    expect(t.failures).toEqual(['画面没有清理干净：OBS 无响应']);
    await next.play('a');
    expect(t.state()).toMatchObject({ status: 'playing', itemId: 'a', fault: null });
    await next.dispose();
  } finally { vi.useRealTimers(); }
});

// 修复前：关闭的节目交还的清理失败放回了它自己那一首，已经接手画面的歌不会再来取，红字一直不出来，只留在日志里。
it('关闭的节目交还画面清理失败：接手画面的歌还在播就在它上面标红，排在它原有的红字前面；接手的歌已经停了就在再下一首上标红，都只一次（2026-11-09）', async () => {
  const test = setup();
  /** The program's own stop of the song playing hears its failed cleanup; the program then closes before showing it. */
  const failedStop = async (generation: number): Promise<ObsPictureLeftover> => {
    test.releaseOutputs.mockRejectedValueOnce(new Error('OBS 无响应'));
    const heard: unknown = await test.host.stopOwned({ version: 1, sessionId: test.request.sessionId, generation }).then(() => null, (error: unknown) => error);
    if (!(heard instanceof ObsPictureLeftover)) throw new Error('清理失败没有交给节目自己的停止');
    return heard;
  };
  await test.host.prepare(test.request); test.observe({ status: 'playing', generation: 1, positionMs: 0 }, 0);
  const first = await failedStop(1);
  // The next program's song took the picture over and plays, already in red, when the closed program hands it back.
  test.change({ generation: 2, itemId: 'next', status: 'ready', positionMs: 0 });
  await test.host.prepare(test.song('next', 2)); test.observe({ status: 'playing', generation: 2, positionMs: 0 }, 1000);
  test.host.report({ log: '乙：No source was found', shown: '乙' });
  first.handBack();
  expect(test.host.status).toMatchObject({ state: 'running', itemId: 'next', fault: `上一首的画面没有清理干净，这一首照常播。原因：${LEFTOVER}；乙` });
  const second = await failedStop(2);
  // This time the song that took the picture over has stopped already: the song after it shows it.
  test.change({ generation: 3, itemId: 'song', status: 'ready', positionMs: 0 });
  expect((await test.host.prepare(test.song('song', 3))).fault ?? null).toBeNull();
  await test.host.stop();
  second.handBack();
  test.change({ generation: 4, status: 'ready', positionMs: 0 });
  await expect(test.host.prepare(test.song('song', 4))).resolves.toMatchObject({ itemId: 'song', fault: `上一首的画面没有清理干净，这一首照常播。原因：${LEFTOVER}` });
  await test.host.stop();
  test.change({ generation: 5, status: 'ready', positionMs: 0 });
  expect((await test.host.prepare(test.song('song', 5))).fault ?? null).toBeNull();
  // Logged once each, where the cleanup ran.
  expect(test.failures).toEqual(['画面没有清理干净：OBS 无响应', '乙：No source was found', '画面没有清理干净：OBS 无响应']);
  await test.host.stop();
});

// 修复前：这一首的画面准备失败的红字整句顶掉“上一首的画面没有清理干净”，OBS 卡住时最常见。
it('OBS 卡住：上一首的画面没清理干净、这一首的画面也准备失败：两条一起在这一首上标红，音乐照常播（2026-11-09）', async () => {
  const t = program({ outputs: (base, index) => index === 0 ? { ...base, releaseOutputs: () => Promise.reject(new Error('OBS 无响应')) }
    : index === 1 ? { ...base, prepareOutputs: () => Promise.reject(new Error('OBS 请求超时（2000 ms）')) } : base });
  await t.player.play('a');
  await vi.waitFor(() => expect(t.ids()).toEqual(['scene-a']));
  await t.player.play('b');
  expect(t.state()).toMatchObject({ status: 'playing', itemId: 'b',
    fault: `上一首的画面没有清理干净，这一首照常播。原因：${LEFTOVER}；画面准备失败，音乐和时间码照常播放：OBS 请求超时（2000 ms）` });
  expect(t.failures).toEqual(['画面没有清理干净：OBS 无响应', 'OBS 请求超时（2000 ms）']);
  await t.player.dispose();
});

it('画面清理失败的原因：运行日志里留着 OBS 的原话和来源名，界面上是看得懂的说法（2026-11-09）', async () => {
  const t = program('next');
  await t.player.play('a');
  await vi.waitFor(() => expect(t.ids()).toEqual(['scene-a']));
  t.releaseOutputs.mockRejectedValueOnce(new Error('SetInputSettings：No source was found by the name of `团播联动台·素材·开场`.'));
  await t.player.stop();
  expect(t.failures).toEqual(['画面没有清理干净：SetInputSettings：No source was found by the name of `团播联动台·素材·开场`.']);
  // One next step: what to check after a failed cleanup, not the step a failed preparation suggests.
  expect(t.state()).toMatchObject({ status: 'stopped',
    notice: '画面清理失败：OBS 中找不到需要的场景或来源。请检查 OBS 节目画面上是否还留着刚才的素材' });
  await t.player.dispose();
});

/** Holds one step until the test lets it go. */
function hold() {
  let release: () => void = () => { throw new Error('还没到这一步'); }, reached = false;
  return { wait: (): Promise<void> => { reached = true; return new Promise<void>(resolve => { release = resolve; }); },
    reached: () => reached, release: () => release() };
}

it.each([['画面还在准备时按继续', 'picture', 'resume'], ['画面还在准备时按 MIDI 播放键', 'picture', 'midi'], ['定位指令还没回来时按继续', 'seek', 'resume']] as const)(
  '暂停时拖动定位，%s：定位好了接着播，这首歌后面的画面照常按时间线切换（2026-11-09）', async (_case, step, press) => {
    const gate = hold();
    let seeking = false;
    // The second picture is the one the scrub prepares at the new position.
    const t = program({ cueSeconds: [0, 1], outputs: (base, index) => step === 'picture' && index === 1 ? { ...base, prepareOutputs: gate.wait } : base,
      beforeAnswer: command => step === 'seek' && seeking && command.kind === 'seek' ? gate.wait() : undefined });
    await t.player.play('a'); await t.playTo(0, 300); await t.player.pause();
    seeking = true;
    const scrubbing = t.player.scrub('a', 500);
    await vi.waitFor(() => expect(gate.reached()).toBe(true));
    const resuming = press === 'midi' ? Promise.resolve(t.player.receiveMidi(Uint8Array.from([0x90, 1, 100]))) : t.player.resume();
    gate.release(); await scrubbing; await resuming;
    await vi.waitFor(() => expect(t.state().status).toBe('playing'));
    await t.playTo(500, 1500);
    // The camera at the new position, then the switch at 1 s.
    expect(t.ids()).toEqual(['scene-a', 'scene-a', 'scene-a-1']);
    expect(t.host.status).toMatchObject({ state: 'running', itemId: 'a' }); expect(t.state().fault).toBeNull();
    // The scrub is over: pause works as usual again.
    await t.player.pause(); expect(t.state().status).toBe('paused');
    await t.player.dispose();
  });

it('播放中拖动定位、画面还在准备时按 MIDI 暂停键：停在新位置，画面照样准备好；松手接着播后画面照常切换（2026-11-09）', async () => {
  const gate = hold();
  const t = program({ cueSeconds: [0, 1], outputs: (base, index) => index === 1 ? { ...base, prepareOutputs: gate.wait } : base });
  await t.player.play('a'); await t.playTo(0, 300);
  const scrubbing = t.player.scrub('a', 500);
  await vi.waitFor(() => expect(gate.reached()).toBe(true));
  t.player.receiveMidi(Uint8Array.from([0x90, 1, 100]));
  gate.release(); await scrubbing;
  await vi.waitFor(() => expect(t.state()).toMatchObject({ status: 'paused', positionMs: 500 }));
  // The editor plays on once the drag ends, as after every scrub that started while playing.
  await t.player.resume(); await t.playTo(500, 1500);
  expect(t.ids()).toEqual(['scene-a', 'scene-a', 'scene-a-1']);
  expect(t.host.status?.state).toBe('running'); expect(t.state().fault).toBeNull();
  await t.player.dispose();
});

// 修复前：准备中按 MIDI 播放键会从歌头重新准备并开播：音乐、时间码、灯光和画面都回到歌头。
it('播放中点波形换位置、新位置的画面还在准备时按 MIDI 播放键：从新位置照常播，画面按新位置切，不从歌头重来（2026-11-09）', async () => {
  const gate = hold();
  const t = program({ cueSeconds: [0, 1], outputs: (base, index) => index === 1 ? { ...base, prepareOutputs: gate.wait } : base });
  await t.player.play('a'); await t.playTo(0, 300);
  const seeking = t.player.seek(1500);
  await vi.waitFor(() => expect(gate.reached()).toBe(true));
  expect(t.state().status).toBe('preparing');
  t.player.receiveMidi(Uint8Array.from([0x90, 1, 100]));
  gate.release(); await seeking;
  expect(t.state()).toMatchObject({ status: 'playing', itemId: 'a', positionMs: 1500 });
  // The camera at the new position; nothing from the head of the song again.
  expect(t.ids()).toEqual(['scene-a', 'scene-a-1']);
  expect(t.host.status).toMatchObject({ state: 'running', itemId: 'a' });
  await t.player.dispose();
});

it('暂停时拖动定位、原来的画面清理失败：在这首歌上标红一次，不另外提示、播放器不再记一次；新位置的画面照常准备（2026-11-09）', async () => {
  const t = program({ cueSeconds: [0, 1] });
  await t.player.play('a'); await t.playTo(0, 300); await t.player.pause();
  t.releaseOutputs.mockRejectedValueOnce(new Error('OBS 无响应'));
  await t.player.scrub('a', 500);
  expect(t.state()).toMatchObject({ status: 'paused', fault: `上一次的画面没有清理干净，这一首照常播。原因：${LEFTOVER}` });
  expect(t.state().notice ?? '').not.toContain('清理'); expect(t.notices.filter(notice => notice.includes('清理'))).toEqual([]);
  expect(t.failures).toEqual(['画面没有清理干净：OBS 无响应']);
  await t.player.resume(); await t.playTo(500, 1500);
  expect(t.ids()).toEqual(['scene-a', 'scene-a', 'scene-a-1']);
  await t.player.dispose();
});

it('画面还在准备时换歌、取消的画面清理失败：在新开的歌上标红一次，不另外提示、播放器不再记一次（2026-11-09）', async () => {
  const gate = hold();
  const t = program({ outputs: (base, index) => index === 0 ? { ...base, prepareOutputs: gate.wait, releaseOutputs: () => Promise.reject(new Error('OBS 无响应')) } : base });
  const first = t.player.play('a');
  await vi.waitFor(() => expect(gate.reached()).toBe(true));
  const second = t.player.play('b');
  gate.release(); await first; await second;
  await vi.waitFor(() => expect(t.ids()).toEqual(['scene-b']));
  expect(t.state()).toMatchObject({ status: 'playing', itemId: 'b', fault: `上一首的画面没有清理干净，这一首照常播。原因：${LEFTOVER}` });
  expect(t.state().notice ?? '').not.toContain('清理'); expect(t.notices.filter(notice => notice.includes('清理'))).toEqual([]);
  expect(t.failures).toEqual(['画面没有清理干净：OBS 无响应']);
  await t.player.dispose();
});

it('自动下一首时上一首的画面清理失败、下一首接手的提前准备也失败：两个原因一起在下一首上标红，下一首照常切画面（2026-11-09）', async () => {
  let failLookahead: (error: Error) => void = () => { throw new Error('下一首还没开始提前准备'); };
  const t = program({ pool: true, outputs: (base, index) => index === 0 ? { ...base, releaseOutputs: () => Promise.reject(new Error('OBS 无响应')) }
    : index === 1 ? { ...base, preloadResources: (_current, phase) => phase === 'background' ? new Promise<void>((_resolve, reject) => { failLookahead = reject; }) : Promise.resolve() }
    : base });
  const prepare = vi.spyOn(t.host, 'prepare');
  await t.player.play('a');
  await vi.waitFor(() => expect(t.created).toHaveLength(2));
  await t.playToEnd();
  // The next song took the lookahead over and waits for it; only then does it fail.
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
  await new Promise(resolve => setTimeout(resolve, 0));
  failLookahead(new Error('OBS 预热素材静音 请求排队超时（2000 ms）；还没发送'));
  await vi.waitFor(() => expect(t.state()).toMatchObject({ status: 'playing', itemId: 'b' }));
  const red = `上一首的画面没有清理干净，这一首照常播。原因：${LEFTOVER}；提前准备的画面没能用上，已改为重新准备。原因：OBS 预热素材静音 请求排队超时（2000 ms）；还没发送`;
  expect(t.state().fault).toBe(red);
  // The picture host repeats its red text with each status; it stays next to the failed cleanup.
  await t.playTo(0, 500);
  expect(t.state().fault).toBe(red);
  expect(t.ids()).toEqual(['scene-a', 'scene-b']); expect(t.created).toHaveLength(3);
  expect(t.failures).toEqual(['画面没有清理干净：OBS 无响应', '提前准备的画面没能用上，已改为重新准备。原因：OBS 预热素材静音 请求排队超时（2000 ms）；还没发送']);
  expect(t.notices.filter(notice => notice.includes('清理'))).toEqual([]);
  await t.player.dispose();
});

/** Wired as in link-main: each song takes its picture from the pool, which prepares the next song's in the background
 * once this one plays. The next song's background preparation waits until the test fails it. */
function lookahead() {
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
  const pool = new NativeObsPreloadPool({ authorize: () => Promise.resolve(), create, report: failure => host.report(failure) });
  const host = new NativeObsHost({ audio: () => test.audio(), changed: () => undefined, error: message => failures.push(message),
    outputs: (request, positionMs, assertCurrent) => pool.take(request, positionMs, assertCurrent),
    prepareNextFiles: async (request, assertCurrent) => { await pool.prepareNext(request, assertCurrent); } });
  const observe = (patch: Partial<NativePlayerStatus>, at: number): void => { time = at; test.change(patch); host.observe(test.audio(), (process.hrtime.bigint() / 100n).toString()); };
  /** The first song plays while the next one's picture is prepared in the background; then it ends and stops its own picture. */
  const playFirstToEnd = async (): Promise<void> => {
    await host.prepare({ ...test.request, nextFiles: { snapshot: test.song('next', 1).snapshot, positionMs: 0 } });
    observe({ status: 'playing', positionMs: 0 }, 0);
    await vi.waitFor(() => expect(created).toHaveLength(2));
    observe({ status: 'ended', positionMs: 50 }, 50);
    await host.stopOwned({ version: 1, sessionId: test.request.sessionId, generation: 1 });
    test.change({ generation: 2, itemId: 'next', status: 'ready', positionMs: 0 });
  };
  return { test, host, failures, created, execute, observe, playFirstToEnd, fail: (error: Error) => failLookahead(error) };
}

it('下一首接手的提前准备失败、清理也失败：下一首照常准备并按时间线切画面，两个原因都在下一首上标红，各记一次（2026-11-09）', async () => {
  const t = lookahead();
  // The song ends while the next song's picture is still being prepared in the background; the next song takes it over.
  await t.playFirstToEnd();
  const preparing = t.host.prepare(t.test.song('next', 2));
  vi.mocked(t.created[1]!.releaseOutputs).mockRejectedValueOnce(new Error('画面没有清理干净：OBS 停止 请求排队超时（2000 ms）；还没发送'));
  t.fail(new Error('OBS 预热素材静音 请求排队超时（2000 ms）；还没发送'));
  await expect(preparing).resolves.toMatchObject({ state: 'ready', itemId: 'next',
    fault: '提前准备的画面没能用上，已改为重新准备。原因：OBS 预热素材静音 请求排队超时（2000 ms）；还没发送；提前准备的画面没有清理干净，不影响播放。原因：OBS 停止 请求排队超时（2000 ms）；还没发送' });
  expect(t.created).toHaveLength(3);
  t.observe({ status: 'playing', generation: 2, positionMs: 0 }, 1000);
  await vi.waitFor(() => expect(t.execute.mock.calls.map(([action]) => action.id)).toEqual(['scene-0', 'next-scene-0']));
  expect(t.failures).toEqual(['提前准备的画面没能用上，已改为重新准备。原因：OBS 预热素材静音 请求排队超时（2000 ms）；还没发送',
    '提前准备的画面没有清理干净，不影响播放。原因：OBS 停止 请求排队超时（2000 ms）；还没发送']);
  await t.host.stop();
});

// 修复前：提前准备那边把“记进日志的原话”和“标红给人看的说法”按位置传给画面宿主，接线时两个对调了也没有检查发现。
it('提前准备的画面清理失败：运行日志里是 OBS 的原话，下一首上标红的是看得懂的说法，两种说法不会对调（2026-11-09）', async () => {
  const t = lookahead();
  await t.playFirstToEnd();
  const preparing = t.host.prepare(t.test.song('next', 2));
  vi.mocked(t.created[1]!.releaseOutputs).mockRejectedValueOnce(new Error('画面没有清理干净：Error: SetInputSettings：No source was found by the name of `团播联动台·素材·next`.'));
  t.fail(new Error('OBS 预热素材静音 请求排队超时（2000 ms）；还没发送'));
  await expect(preparing).resolves.toMatchObject({ state: 'ready', itemId: 'next',
    fault: '提前准备的画面没能用上，已改为重新准备。原因：OBS 预热素材静音 请求排队超时（2000 ms）；还没发送；提前准备的画面没有清理干净，不影响播放。原因：OBS 中找不到需要的场景或来源' });
  expect(t.failures).toEqual(['提前准备的画面没能用上，已改为重新准备。原因：OBS 预热素材静音 请求排队超时（2000 ms）；还没发送',
    '提前准备的画面没有清理干净，不影响播放。原因：SetInputSettings：No source was found by the name of `团播联动台·素材·next`.']);
  await t.host.stop();
});

it('上一首停了、下一首还没来接手时提前准备失败：照样记一次，不当成取消；下一首照常准备画面（2026-11-09）', async () => {
  const t = lookahead();
  await t.playFirstToEnd();
  // OBS answers only now: after this song stopped, before the next song asks for its picture.
  t.fail(new Error('OBS 读取目录失败：GetSceneList 请求排队超时（2000 ms）；还没发送'));
  await vi.waitFor(() => expect(t.failures).toEqual(['准备下一个节目的文件失败：OBS 读取目录失败：GetSceneList 请求排队超时（2000 ms）；还没发送']));
  const status = await t.host.prepare(t.test.song('next', 2));
  expect(status).toMatchObject({ state: 'ready', itemId: 'next' }); expect(status.fault ?? null).toBeNull();
  expect(t.created).toHaveLength(3); expect(t.created[1]!.releaseOutputs).toHaveBeenCalledOnce();
  t.observe({ status: 'playing', generation: 2, positionMs: 0 }, 1000);
  await vi.waitFor(() => expect(t.execute.mock.calls.map(([action]) => action.id)).toEqual(['scene-0', 'next-scene-0']));
  expect(t.failures).toHaveLength(1);
  await t.host.stop();
});

it('画面资源交接后被新的操作取消：照常报取消；释放失败另报一次，不顶替取消', async () => {
  const test = setup(), failures: string[] = [];
  let handOver: () => void = () => { throw new Error('还没开始交接'); };
  const releaseOutputs = vi.fn(() => Promise.reject(new Error('SetInputSettings：No source was found by the name of `团播联动台·素材·开场`.')));
  const host = new NativeObsHost({ audio: () => test.audio(), changed: () => undefined, error: message => failures.push(message),
    outputs: () => new Promise(resolve => { handOver = () => resolve({ executor: { id: 'test', supports: () => true, execute: () => Promise.resolve() },
      guardOutput: <T>(_canSend: () => boolean, operation: () => Promise<T>) => operation(), prepareOutputs: () => Promise.resolve(), releaseOutputs,
      now: () => 0, seekMedia: () => Promise.resolve(), executeManagedMediaEvent: () => Promise.resolve(),
      recordLog: (entry: Parameters<LinkDesktopApi['recordLog']>[0]) => Promise.resolve({ ...entry, id: 'log', sessionId: 'test', timestamp: '2026-11-09T00:00:00Z', monotonicMs: 0 }) }); }) });
  const preparing = expect(host.prepare(test.request)).rejects.toThrow('画面资源交接已取消');
  // The operator stops while the picture resources are still being handed over.
  await host.stop(); handOver(); await preparing;
  expect(releaseOutputs).toHaveBeenCalledOnce();
  // The log keeps OBS's own words.
  expect(failures).toEqual(['取消的画面准备没有清理干净，不影响播放。原因：SetInputSettings：No source was found by the name of `团播联动台·素材·开场`.']);
  // That song never got its picture, so the message stays in the log; a later song does not show it.
  const next = host.prepare(test.request); handOver();
  expect((await next).fault ?? null).toBeNull();
  expect(failures).toHaveLength(1);
});

it('别处没人报告的预备清理失败交给宿主：记录原话一次；有歌在播就标红显示看得懂的说法；歌还在准备时等它有了画面状态再标红；没有歌时只记录', async () => {
  const test = setup();
  test.host.report({ log: '甲：No source was found', shown: '甲' }); expect(test.host.status).toBeNull();
  // Nothing played when it happened: not carried over to a later song.
  expect((await test.host.prepare(test.request)).fault ?? null).toBeNull();
  test.observe({ status: 'playing', generation: 1, positionMs: 0 }, 0);
  test.host.report({ log: '乙：No source was found', shown: '乙' }); expect(test.host.status).toMatchObject({ state: 'running', fault: '乙' });
  let release: () => void = () => { throw new Error('还没开始清理'); };
  test.releaseOutputs.mockReturnValueOnce(new Promise<void>(resolve => { release = resolve; }));
  test.change({ generation: 2, status: 'ready', positionMs: 0 });
  const preparing = test.host.prepare({ ...test.request, generation: 2 });
  await vi.waitFor(() => expect(test.releaseOutputs).toHaveBeenCalledOnce());
  test.host.report({ log: '丙：No source was found', shown: '丙' }); release();
  await expect(preparing).resolves.toMatchObject({ state: 'ready', generation: 2, fault: '丙' });
  expect(test.failures).toEqual(['甲：No source was found', '乙：No source was found', '丙：No source was found']);
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
