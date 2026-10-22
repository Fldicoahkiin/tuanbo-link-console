import { describe, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, linkCueSchema, parseLinkProject, type NativePlayerControl, type NativePlayerPrepare, type NativePlayerStatus, type NativeObsPrepare, type NativeObsStatus } from '@tb/schema';
import { NativeProgramPlayer } from '@tb/core/link';
import { emptyInternalPlayerState } from './internal-playback-controller';
import { nativeProgramSnapshot } from '@tb/core/link';
import type { NativeObsPreload } from '@tb/schema';

function fixture() {
  const project = parseLinkProject({ ...createEmptyLinkProject('原生播放操作'), playbackSource: 'internal',
    rundown: [0, 1].map(index => ({ id: `song-${index}`, title: `音频 ${index}`, referenceAudio: { assetId: `a-${index}`, relativePath: `a-${index}.wav`, sha256: 'a'.repeat(64), durationMs: 10000 },
      playback: { startMs: 500, endMs: 9500, mtcOffsetMs: 480000 + index * 20000, volume: 80, endAction: 'pause', shortcut: '' } })) });
  let status: NativePlayerStatus | null = null, listener: ((value: NativePlayerStatus) => void) | null = null;
  let state = { ...emptyInternalPlayerState };
  const emit = (patch: Partial<NativePlayerStatus> = {}): NativePlayerStatus => { if (!status) throw new Error('没有准备音频'); status = { ...status, ...patch }; listener?.(status); return status; };
  const api = {
    preloadNativeObs: vi.fn<(request: NativeObsPreload) => Promise<void>>(() => Promise.resolve()),
    cancelNativeObsPreload: vi.fn(() => Promise.resolve()),
    onNativeObsStatus: vi.fn<(_receive: (value: NativeObsStatus) => void) => () => void>(() => () => undefined),
    stopNativeObs: vi.fn(() => Promise.resolve()),
    prepareNativeObs: vi.fn((request: NativeObsPrepare): Promise<NativeObsStatus> => Promise.resolve({ version: 1, sessionId: request.sessionId,
      generation: request.generation, itemId: request.snapshot.item.id, revision: request.snapshot.revision, state: 'ready', reason: null,
      currentCueId: null, nextCueId: null, pendingCount: 0, positionMs: status?.positionMs ?? 0 })),
    onNativePlaybackStatus: (receive: (value: NativePlayerStatus) => void) => { listener = receive; return () => { listener = null; }; },
    getNativePlaybackDevices: vi.fn(() => Promise.resolve({ protocol: 4 as const, audio: [], midiOutputs: [] })),
    prepareNativePlayback: vi.fn((request: NativePlayerPrepare): Promise<NativePlayerStatus> => {
      const s = request.snapshot;
      status = { version: 1, sessionId: request.sessionId, generation: request.generation, itemId: s.itemId,
        status: 'ready', positionMs: s.positionMs, offsetMs: s.offsetMs, sampleRate: s.sampleRate,
        enginePid: 123, engineTitle: 'TBLINK Audio 123', mtcPortName: request.midiPortName, mtcSent: 0,
        audioError: null, mtcError: null, underruns: 0, mtcInterruptions: 0, gain: s.volume, analysis: null };
      return Promise.resolve(emit());
    }),
    controlNativePlayback: vi.fn((command: NativePlayerControl): Promise<NativePlayerStatus> => {
      if (!status || command.sessionId !== status.sessionId || command.generation < status.generation) throw new Error('会话失效');
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
    })
  };
  const deps = { prepare: vi.fn(() => Promise.resolve()), ingest: vi.fn(() => Promise.resolve()), started: vi.fn(), scrub: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()), pause: vi.fn(() => Promise.resolve()), resolveAudio: vi.fn(() => Promise.resolve('unused')),
    configuration: () => ({ outputDeviceId: 'default', mtcPortName: 'TEST', audioSampleRate: 48000 as const }),
    changed: (next: typeof state) => { state = next; }, notice: vi.fn() };
  const lighting = { prepare: vi.fn(() => Promise.resolve()), tick: vi.fn(), finish: vi.fn(), stop: vi.fn() };
  const player = new NativeProgramPlayer(project, 'C:/test/project.tblink', 7, deps, api, lighting);
  return { player, project, deps, api, lighting, emit, state: () => state };
}

it('有画面动作的歌，后台画面准备失败时不开始播放；纯音频的歌照常播放并提示', async () => {
  const f = fixture(); f.project.obsOutputMode = 'scenes';
  f.project.rundown[0]!.cues = [linkCueSchema.parse({ id: 'cue', name: '机位', timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 },
    actions: [{ id: 'scene', label: '机位', kind: 'obs.setProgramScene', sceneName: '场景' }] })];
  f.api.prepareNativeObs.mockRejectedValueOnce(new Error('素材来源与工程文件不一致，拒绝覆盖'));
  await f.player.play('song-0');
  expect(f.state()).toMatchObject({ status: 'error' });
  expect(f.state().error).toContain('画面准备失败：素材来源与工程文件不一致');
  expect(f.api.controlNativePlayback.mock.calls.map(([command]) => command.kind)).not.toContain('play');
  f.api.prepareNativeObs.mockRejectedValueOnce(new Error('OBS 未连接'));
  await f.player.play('song-1');
  expect(f.state().status).toBe('playing');
  expect(f.deps.notice).toHaveBeenCalledWith(expect.stringContaining('画面未参与：OBS 未连接'), 'song-1');
  await f.player.dispose();
});

it('播放中画面通道的直播故障显示为输出异常，音频继续；下一次播放清除', async () => {
  const f = fixture(); f.project.obsOutputMode = 'scenes';
  f.project.rundown[0]!.cues = [linkCueSchema.parse({ id: 'cue', name: '机位', timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 },
    actions: [{ id: 'scene', label: '机位', kind: 'obs.setProgramScene', sceneName: '场景' }] })];
  let receive: ((value: NativeObsStatus) => void) | null = null;
  f.api.onNativeObsStatus.mockImplementation(listener => { receive = listener; return () => undefined; });
  const player = new NativeProgramPlayer(f.project, 'C:/test/project.tblink', 7, f.deps, f.api, f.lighting);
  await player.play('song-0');
  const request = f.api.prepareNativeObs.mock.calls.at(-1)![0];
  const running: NativeObsStatus = { version: 1, sessionId: request.sessionId, generation: request.generation, itemId: 'song-0', revision: 7,
    state: 'running', reason: null, currentCueId: null, nextCueId: null, pendingCount: 0, positionMs: 1000 };
  receive!({ ...running, fault: '画面动作失败：机位 · OBS 无响应' });
  expect(f.state()).toMatchObject({ status: 'playing', fault: '画面动作失败：机位 · OBS 无响应' });
  receive!({ ...running, state: 'failed', reason: '实际音频位置无效' });
  expect(f.state()).toMatchObject({ status: 'playing', fault: '画面通道已停止：实际音频位置无效' });
  await player.play('song-1');
  expect(f.state().fault).toBeNull();
  await player.dispose();
});

it('时间码短暂中断和 P1 一样按整帧继续，不标红；音频与时间码继续', async () => {
  const f = fixture();
  await f.player.play('song-0');
  expect(f.state()).toMatchObject({ status: 'playing', fault: null });
  f.emit({ mtcInterruptions: 1 }); f.emit({ positionMs: 2000 }); f.emit({ mtcInterruptions: 2 });
  expect(f.state()).toMatchObject({ status: 'playing', mtcConnectionFailed: false, fault: null });
  await f.player.dispose();
});

it('有画面的歌等待画面准备完成（例如首次生成定位缓存）再开始，不因一秒窗口放弃画面', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(); f.project.obsOutputMode = 'scenes';
    f.project.rundown[0]!.cues = [linkCueSchema.parse({ id: 'cue', name: '机位', timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 },
      actions: [{ id: 'scene', label: '机位', kind: 'obs.setProgramScene', sceneName: '场景' }] })];
    const ready = f.api.prepareNativeObs.getMockImplementation()!;
    f.api.prepareNativeObs.mockImplementationOnce(request => new Promise(resolve => { setTimeout(() => resolve(ready(request)), 3000); }));
    const playing = f.player.play('song-0');
    await vi.advanceTimersByTimeAsync(1500);
    expect(f.state().status).toBe('preparing'); expect(f.api.stopNativeObs).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000); await playing;
    expect(f.state()).toMatchObject({ status: 'playing', error: null });
    expect(f.api.controlNativePlayback.mock.calls.map(([command]) => command.kind)).toContain('play');
    await f.player.dispose();
  } finally { vi.useRealTimers(); }
});

it('引擎异常退出后再次播放不向已退出的引擎发 stop，直接重新准备并播放；销毁时同样不发', async () => {
  // 修复前：每次播放都先向已退出的引擎发 stop 并被拒绝，同一播放器此后永远停在错误状态。
  const f = fixture();
  const commands = (): string[] => f.api.controlNativePlayback.mock.calls.map(([command]) => command.kind);
  await f.player.play('song-0');
  f.emit({ status: 'error', audioError: '播放引擎已退出：1' });
  f.api.controlNativePlayback.mockClear();
  await f.player.play('song-0');
  expect(commands()).not.toContain('stop');
  expect(f.api.prepareNativePlayback).toHaveBeenCalledTimes(2);
  expect(f.state().status).toBe('playing');
  f.emit({ status: 'error', audioError: '播放引擎已退出：1' });
  f.api.controlNativePlayback.mockClear();
  await f.player.dispose();
  expect(commands()).not.toContain('stop');
});

it('选择节目提前预备画面且不出声；重复选择不重做，播放中不能改准备目标', async () => {
  const f = fixture(); f.project.obsOutputMode = 'scenes';
  f.player.preloadSelected('song-0'); f.player.preloadSelected('song-0');
  expect(f.api.preloadNativeObs).toHaveBeenCalledTimes(1);
  expect(f.api.preloadNativeObs.mock.calls[0]?.[0]).toMatchObject({ positionMs: 500, snapshot: { item: { id: 'song-0' } } });
  expect(f.api.prepareNativePlayback).not.toHaveBeenCalled();
  await f.player.play('song-0'); f.player.preloadSelected('song-1');
  expect(f.api.preloadNativeObs).toHaveBeenCalledTimes(1);
  await f.player.stop(); expect(f.api.cancelNativeObsPreload).toHaveBeenCalledTimes(1);
  await f.player.dispose();
});

it('后台画面可用而音乐采集失败时保留播放并展示、记录采集原因', async () => {
  const f = fixture(); f.project.obsOutputMode = 'scenes';
  f.api.prepareNativeObs.mockImplementationOnce(request => Promise.resolve({ version: 1, sessionId: request.sessionId,
    generation: request.generation, itemId: request.snapshot.item.id, revision: request.snapshot.revision, state: 'ready', reason: null,
    notice: 'OBS 音乐采集未就绪：窗口不可见', currentCueId: null, nextCueId: null, pendingCount: 0, positionMs: 500 }));
  try {
    await f.player.play('song-0');
    expect(f.state()).toMatchObject({ status: 'playing', notice: 'OBS 音乐采集未就绪：窗口不可见' });
    expect(f.deps.notice).toHaveBeenCalledWith('OBS 音乐采集未就绪：窗口不可见', 'song-0');
  } finally { await f.player.dispose(); }
});

it('关闭宿主等待所有通道释放，音频停止失败也清理画面且不回写旧界面', async () => {
  const f = fixture(); f.project.obsOutputMode = 'scenes'; await f.player.play('song-0');
  expect(f.api.prepareNativeObs).toHaveBeenCalledOnce();
  f.deps.stop.mockClear(); f.api.stopNativeObs.mockClear();
  const state = f.state();
  f.api.controlNativePlayback.mockRejectedValue(new Error('测试：音频停止失败'));
  const closed = f.player.dispose();
  expect(f.player.dispose()).toBe(closed);
  await expect(closed).rejects.toThrow('音频停止失败');
  expect(f.api.stopNativeObs).toHaveBeenCalledOnce();
  expect(f.deps.stop).toHaveBeenCalledOnce();
  expect(f.state()).toBe(state);
  f.emit({ status: 'playing', positionMs: 3000 });
  expect(f.state()).toBe(state);
});

it('关闭准备中的宿主必须等旧准备退出，不在后台留下迟到的继续操作', async () => {
  const f = fixture(), original = f.api.prepareNativePlayback.getMockImplementation()!;
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.api.prepareNativePlayback.mockImplementation(async request => { await original(request); await gate; return f.emit(); });
  const playing = f.player.play('song-0');
  await vi.waitFor(() => expect(f.api.prepareNativePlayback).toHaveBeenCalledOnce());
  let closed = false;
  const closing = f.player.dispose().then(() => { closed = true; });
  try {
    for (let index = 0; index < 20; index++) await Promise.resolve();
    expect(closed).toBe(false);
  } finally { release!(); await playing; await closing; }
  expect(closed).toBe(true);
  expect(f.api.controlNativePlayback.mock.calls.some(([request]) => request.kind === 'play')).toBe(false);
});

describe('原生正式播放器的操作与会话', () => {
  it('暂停后恢复先重新准备已取消的通用 MIDI，不在音频恢复后才接入', async () => {
    const f = fixture(); await f.player.play('song-0'); await f.player.pause();
    f.deps.prepare.mockClear(); f.api.controlNativePlayback.mockClear();
    let release: (() => void) | undefined;
    f.deps.prepare.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const resumed = f.player.resume();
    try {
      await vi.waitFor(() => expect(f.deps.prepare).toHaveBeenCalledOnce());
      expect(f.api.controlNativePlayback.mock.calls.some(([request]) => request.kind === 'play')).toBe(false);
    } finally { release?.(); await resumed; await f.player.dispose(); }
  });
  it('下一首快照保留独立原始偏移，曲尾不会先停止并丢弃预填充', async () => {
    const f = fixture(); f.project.rundown[0]!.playback!.endAction = 'next';
    await f.player.play('song-0');
    expect(f.api.prepareNativePlayback.mock.calls[0]![0].nextSnapshot).toMatchObject({
      itemId: 'song-1', offsetMs: 500000, startMs: 500, positionMs: 500, revision: 7
    });
    f.api.controlNativePlayback.mockClear(); f.emit({ status: 'ended', positionMs: 9500 });
    await vi.waitFor(() => expect(f.state()).toMatchObject({ itemId: 'song-1', status: 'playing' }));
    expect(f.api.controlNativePlayback.mock.calls.map(([request]) => request.kind)).toEqual(['play']);
    await f.player.stop();
    expect(f.api.controlNativePlayback.mock.calls.at(-1)?.[0].kind).toBe('stop');
  });
  it.each(['pause', 'next'] as const)('曲尾灯光发送失败不阻止原定的 %s 播放动作', async endAction => {
    const f = fixture();
    f.project.rundown[0]!.lighting = { ...createLightingDocument(), outputMode: 'network' };
    f.project.rundown[0]!.playback!.endAction = endAction;
    f.lighting.finish.mockImplementation(() => { throw new Error('曲尾灯光网络断开'); });
    await f.player.play('song-0');
    expect(f.lighting.prepare).toHaveBeenCalledOnce();
    f.emit({ status: 'ended', positionMs: 9500 });
    await vi.waitFor(() => expect(f.state()).toMatchObject({
      status: endAction === 'pause' ? 'paused' : 'playing',
      itemId: endAction === 'pause' ? 'song-0' : 'song-1', error: null
    }));
    expect(f.lighting.finish).toHaveBeenCalledOnce();
    expect(f.state().playedItemIds).toContain('song-0');
    expect(f.deps.notice).toHaveBeenCalledWith(expect.stringContaining('曲尾灯光网络断开'), 'song-0');
    if (endAction === 'pause') expect(f.state().notice).toContain('曲尾灯光网络断开');
    await f.player.stop();
  });
  it('44.1kHz 曲尾位置按整采样取整，灯光收尾使用引擎实际结束位置，不用名义结束时间', async () => {
    const f = fixture();
    f.project.rundown[0]!.lighting = { ...createLightingDocument(), outputMode: 'network' };
    f.project.rundown[0]!.playback!.endMs = 9499.99;
    await f.player.play('song-0');
    // The engine ends on a whole sample: llround(9499.99 × 44.1) = 418950 samples = 9500 ms.
    const endedAt = Math.round(9499.99 * 44.1) / 44.1;
    expect(endedAt).not.toBe(9499.99);
    f.emit({ status: 'ended', positionMs: endedAt });
    await vi.waitFor(() => expect(f.lighting.finish).toHaveBeenCalledOnce());
    expect(f.lighting.finish).toHaveBeenCalledWith(endedAt);
    await f.player.stop();
  });
  it('界面伴随 Cue 启动失败不停止已开始的后台音频与 OBS', async () => {
    const f = fixture(); f.deps.started.mockImplementation(() => { throw new Error('本地 MIDI 起点已错过'); });
    await f.player.play('song-0');
    expect(f.state()).toMatchObject({ status: 'playing', error: null });
    expect(f.state().notice).toContain('本地 MIDI 起点已错过');
    expect(f.deps.ingest).not.toHaveBeenCalled(); expect(f.api.stopNativeObs).not.toHaveBeenCalled();
    expect(f.api.controlNativePlayback.mock.calls.map(([request]) => request.kind)).toEqual(['play']);
    await f.player.stop();
  });
  it('准备和暂停定位不提前触发 Cue，只有实际播放状态才交付设备位置', async () => {
    const f = fixture();
    f.deps.ingest.mockImplementation(() => {
      expect(f.api.controlNativePlayback.mock.calls.at(-1)?.[0].kind).toBe('play');
      return Promise.resolve();
    });
    await f.player.play('song-0', 500, true);
    expect(f.state().status).toBe('paused'); expect(f.deps.ingest).not.toHaveBeenCalled();
    await f.player.resume(); await vi.waitFor(() => expect(f.deps.ingest).toHaveBeenCalledWith(500));
    f.deps.ingest.mockClear(); await f.player.pause(); await f.player.scrub('song-0', 1500);
    expect(f.deps.ingest).not.toHaveBeenCalled();
    await f.player.resume(); await vi.waitFor(() => expect(f.deps.ingest).toHaveBeenCalledWith(1500));
    await f.player.stop();
  });
  it('画面与 MIDI Cue 分别准备，任一通道失败都不阻止另一通道或有效音频', async () => {
    const f = fixture(); f.project.obsOutputMode = 'scenes';
    f.deps.prepare.mockRejectedValueOnce(new Error('MIDI 端口缺失'));
    await f.player.play('song-0');
    expect(f.api.prepareNativeObs).toHaveBeenCalledTimes(1);
    expect(f.state()).toMatchObject({ status: 'playing', error: null });
    expect(f.state().notice).toContain('MIDI 端口缺失');
    await f.player.stop();
    f.api.prepareNativeObs.mockRejectedValueOnce(new Error('OBS 网络断开'));
    await f.player.play('song-1');
    expect(f.state()).toMatchObject({ status: 'playing', error: null });
    expect(f.state().notice).toContain('OBS 网络断开');
    f.emit({ positionMs: 1200 }); await Promise.resolve();
    expect(f.deps.ingest).toHaveBeenCalledWith(1200); await f.player.stop();
  });
  it('尚未收到任何原生状态时，停止仍取消正在等待许可的准备请求', async () => {
    const f = fixture();
    let rejectPreparation: ((error: Error) => void) | undefined;
    f.api.prepareNativePlayback.mockImplementation(() => new Promise<NativePlayerStatus>((_resolve, reject) => { rejectPreparation = reject; }));
    f.api.controlNativePlayback.mockImplementation(command => {
      expect(command.kind).toBe('stop');
      const request = f.api.prepareNativePlayback.mock.calls[0]![0], snapshot = request.snapshot;
      rejectPreparation!(new Error('播放请求在等待许可时已被取消'));
      return Promise.resolve({ version: 1, sessionId: request.sessionId, generation: command.generation, itemId: snapshot.itemId,
        status: 'stopped', positionMs: snapshot.positionMs, offsetMs: snapshot.offsetMs, sampleRate: snapshot.sampleRate,
        enginePid: null, engineTitle: null, mtcPortName: null, mtcSent: 0, audioError: null, mtcError: null, underruns: 0, mtcInterruptions: 0, gain: snapshot.volume, analysis: null });
    });
    const playing = f.player.play('song-0');
    await vi.waitFor(() => expect(f.api.prepareNativePlayback).toHaveBeenCalledOnce());
    await Promise.all([playing, f.player.stop()]);
    expect(f.state().status).toBe('stopped'); expect(f.state().error).toBeNull();
    expect(f.api.controlNativePlayback).toHaveBeenCalledOnce();
  });
  it('歌曲原始偏移与播放裁剪只计算一次，界面采用真实时钟，OBS 失败不阻止音频', async () => {
    const f = fixture(); f.deps.prepare.mockRejectedValue(new Error('OBS 未连接'));
    await f.player.play('song-0');
    expect(f.api.prepareNativePlayback.mock.calls[0]![0].snapshot).toMatchObject({ offsetMs: 480000, startMs: 500, positionMs: 500, revision: 7, endMs: 9500 });
    expect(f.state().status).toBe('playing'); expect(f.state().notice).toContain('OBS 未连接');
    f.emit({ positionMs: 1300, mtcSent: 50 });
    expect(f.state()).toMatchObject({ positionMs: 1300, mtcPositionMs: 481300 });
    expect(f.player.clock.read()).toMatchObject({ positionMs: 1300, playing: true });
    expect(f.deps.resolveAudio).not.toHaveBeenCalled(); await f.player.stop();
  });
  it('暂停、定位、继续和停止不重发旧时间线；只关闭时间码不暂停音频', async () => {
    const f = fixture(), boundary = vi.fn(); f.player.clock.subscribeBoundary(boundary);
    await f.player.play('song-0'); f.emit({ positionMs: 1200 });
    await f.player.pause(); expect(f.state().status).toBe('paused');
    await f.player.scrub('song-0', 800); expect(f.player.clock.read().positionMs).toBe(800);
    await f.player.resume(); expect(f.state().status).toBe('playing');
    f.player.toggleMtc(); await vi.waitFor(() => expect(f.state().mtcPortName).toBeNull());
    expect(f.state().status).toBe('playing'); expect(f.api.prepareNativePlayback).toHaveBeenCalledOnce();
    expect(boundary.mock.calls.flat()).toContain('pause'); expect(boundary.mock.calls.flat()).toContain('seek');
    await f.player.stop(); expect(f.state().status).toBe('stopped');
  });
  it('准备中取消保留停止意图，迟到准备结果不能启动音频', async () => {
    const f = fixture(), original = f.api.prepareNativePlayback.getMockImplementation()!;
    let release: (() => void) | undefined; const gate = new Promise<void>(resolve => { release = resolve; });
    f.api.prepareNativePlayback.mockImplementation(async request => { await original(request); await gate; return f.emit(); });
    const playing = f.player.play('song-0');
    await vi.waitFor(() => expect(f.api.prepareNativePlayback).toHaveBeenCalledOnce());
    const stopping = f.player.stop(); release!(); await Promise.all([playing, stopping]);
    expect(f.api.controlNativePlayback.mock.calls.some(([action]) => action.kind === 'play')).toBe(false);
    expect(f.state().status).toBe('stopped');
  });
  it('连续切歌忽略旧准备，下一首保留自己的时间码；结束动作只执行一次', async () => {
    const f = fixture();
    await Promise.all([f.player.play('song-0'), f.player.play('song-1')]);
    expect(f.api.prepareNativePlayback).toHaveBeenCalledOnce(); expect(f.state().itemId).toBe('song-1');
    expect(f.api.prepareNativePlayback.mock.calls[0]![0].snapshot.offsetMs).toBe(500000);
    f.emit({ status: 'ended', positionMs: 9500 }); f.emit({ status: 'ended', positionMs: 9500 });
    await vi.waitFor(() => expect(f.state().status).toBe('paused'));
    expect(f.deps.pause).toHaveBeenCalledOnce(); expect(f.state().playedItemIds).toEqual(['song-1']); await f.player.stop();
  });
  it('准备过程中关闭再打开时间码，迟到的准备不得在本首重新启用 MIDI', async () => {
    const f = fixture(), original = f.api.prepareNativePlayback.getMockImplementation()!;
    let release: (() => void) | undefined; const gate = new Promise<void>(resolve => { release = resolve; });
    f.api.prepareNativePlayback.mockImplementation(async request => { await gate; return original(request); });
    const playing = f.player.play('song-0');
    await vi.waitFor(() => expect(f.api.prepareNativePlayback).toHaveBeenCalledOnce());
    f.player.toggleMtc(); f.player.toggleMtc(); release!(); await playing;
    expect(f.state().status).toBe('playing'); expect(f.state().mtcEnabled).toBe(true);
    expect(f.state().mtcPortName).toBeNull();
    const actions = f.api.controlNativePlayback.mock.calls.map(([action]) => action.kind);
    expect(actions.indexOf('stop-mtc')).toBeGreaterThanOrEqual(0);
    expect(actions.indexOf('stop-mtc')).toBeLessThan(actions.indexOf('play'));
    await f.player.stop();
  });
  it('反复收到同一原生故障只清理一次，不在后台无限重试', async () => {
    const f = fixture(); await f.player.play('song-0'); f.deps.stop.mockClear();
    f.emit({ status: 'error', audioError: '设备失效' }); f.emit({ status: 'error', audioError: '设备失效' });
    expect(f.state().status).toBe('error'); expect(f.deps.stop).toHaveBeenCalledOnce();
  });
  it('OBS 准备到期让音频继续，迟到结果不能启用本轮联动', async () => {
    const f = fixture(); let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; }); f.deps.prepare.mockReturnValue(gate);
    vi.useFakeTimers();
    try {
      const playing = f.player.play('song-0'); await vi.advanceTimersByTimeAsync(1001); await playing;
      expect(f.state().status).toBe('playing'); expect(f.state().notice).toContain('准备窗口内未就绪');
      expect(f.deps.stop).toHaveBeenCalledTimes(2);
      release!(); await Promise.resolve(); f.emit({ positionMs: 2000 });
      expect(f.deps.ingest).not.toHaveBeenCalled(); expect(f.deps.started).not.toHaveBeenCalled();
      await f.player.stop();
    } finally { release?.(); vi.useRealTimers(); }
  });
});

it('不支持的 MTC 帧率明确隔离该通道，保留已知直接灯光和音频；不修改歌曲偏移', () => {
  const f = fixture(); f.project.timebase.frameRate = '29.97df';
  f.project.rundown[0]!.lighting = { ...createLightingDocument(), outputMode: 'network' };
  const result = nativeProgramSnapshot(f.project, 'song-0', 7, 1000, 48000);
  expect(result).toMatchObject({ allowMtc: false, allowLighting: true }); expect(result.notice).toContain('29.97df');
  expect(f.project.rundown[0]!.playback!.mtcOffsetMs).toBe(480000);
});

for (const mode of ['network', 'direct', 'timecode'] as const) it(`原生播放：待核对的时间码配对与 ${mode} 输出隔离`, async () => {
  const f = fixture();
  f.project.rundown[0]!.lighting = { ...createLightingDocument(), outputMode: mode };
  f.project.ma2ReadState = { source: 'console', catalog: { directory: { show: 'test', generation: 'session', version: '3.7.0.5', entries: [] }, readAt: '2026-10-08T00:00:00.000Z', entries: [] },
    pairs: {}, pairings: { '2': { itemId: 'song-0', status: 'stale', evidence: '', reason: '时间依据已变化' } }, failures: [], selectedTarget: null, query: '', filter: 'all', message: '' };
  const result = nativeProgramSnapshot(f.project, 'song-0', 7, 500, 48000);
  expect(result).toMatchObject({ allowMtc: false, allowLighting: mode !== 'timecode' });
  if (mode !== 'timecode') expect(result.notice).toBeNull();
  else expect(result.notice).toContain('本次不发送时间码');
  await f.player.play('song-0');
  expect(f.state().status).toBe('playing');
  expect(f.lighting.prepare).toHaveBeenCalledTimes(mode !== 'timecode' ? 1 : 0);
  expect(f.state().notice).not.toContain('按开关设置输出');
  expect(f.api.prepareNativePlayback.mock.calls[0]?.[0].midiPortName).toBeNull();
  expect(f.project.ma2ReadState?.pairings?.['2']?.status).toBe('stale');
  await f.player.stop();
});
