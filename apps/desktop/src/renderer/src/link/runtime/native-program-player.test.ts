import { describe, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, lightingDocumentSchema, linkCueSchema, parseLinkProject, type NativePlayerControl, type NativePlayerPrepare, type NativePlayerStatus, type NativeObsPrepare, type NativeObsStatus } from '@tb/schema';
import { NativeProgramPlayer, type ProgramLightingOutput } from '@tb/core/link';
import { emptyInternalPlayerState } from '@tb/core/link';
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
    getNativePlaybackDevices: vi.fn(() => Promise.resolve({ protocol: 4 as const, audio: [], midiOutputs: [], midiInputs: [] })),
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
  const lighting = { prepare: vi.fn<ProgramLightingOutput['prepare']>(() => Promise.resolve()), cancelPreparation: vi.fn<ProgramLightingOutput['cancelPreparation']>(), release: vi.fn<ProgramLightingOutput['release']>(() => Promise.resolve()) };
  const player = new NativeProgramPlayer(project, 'C:/test/project.tblink', 7, deps, api, lighting);
  return { player, project, deps, api, lighting, emit, state: () => state };
}

it('随时可播放：有画面动作的歌画面准备失败时照常放音乐、发时间码，画面标红；纯音频的歌只提示（第 9 条取代 10-19 的决定）', async () => {
  const f = fixture(); f.project.obsOutputMode = 'scenes';
  f.project.rundown[0]!.cues = [linkCueSchema.parse({ id: 'cue', name: '机位', timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 },
    actions: [{ id: 'scene', label: '机位', kind: 'obs.setProgramScene', sceneName: '场景' }] })];
  f.api.prepareNativeObs.mockRejectedValueOnce(new Error('素材来源与工程文件不一致，拒绝覆盖'));
  await f.player.play('song-0');
  expect(f.state()).toMatchObject({ status: 'playing', error: null, fault: '画面准备失败，音乐和时间码照常播放：素材来源与工程文件不一致，拒绝覆盖' });
  expect(f.api.prepareNativePlayback.mock.calls[0]?.[0]).toMatchObject({ midiPortName: 'TEST', snapshot: { offsetMs: 480000 } });
  expect(f.api.controlNativePlayback.mock.calls.map(([command]) => command.kind)).toContain('play');
  expect(f.deps.notice).toHaveBeenCalledWith(expect.stringContaining('画面准备失败，音乐和时间码照常播放'), 'song-0');
  f.api.prepareNativeObs.mockRejectedValueOnce(new Error('OBS 未连接'));
  await f.player.play('song-1');
  expect(f.state().status).toBe('playing');
  expect(f.deps.notice).toHaveBeenCalledWith(expect.stringContaining('画面没有联动，音频照常播放。原因：OBS 未连接'), 'song-1');
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
  expect(f.state()).toMatchObject({ status: 'playing', fault: '画面联动已停止：实际音频位置无效' });
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

it('随时可播放：开播检查不过的歌照发本曲起始码的时间码，只提示不标红；同曲定位不重复提示；没有灯光工作的歌不提示（2026-10-26）', async () => {
  const f = fixture(), lighting = createLightingDocument();
  lighting.ma2Bindings = [{ id: 'binding', timecode: 2, name: '音频 0', readAt: '2026-10-22T00:00:00.000Z', sourceXml: '<MA/>', baselineTracks: [], mappings: [], playback: 'editable', timeOriginMs: 480000 }];
  f.project.rundown[0]!.lighting = lighting;
  // The console show now starts one second later than the song: not paired, the song still sends its own start.
  f.project.ma2ReadState = { source: 'console', catalog: { directory: { show: 'test', generation: 'session', version: '3.7.0.5', entries: [{ target: 2, name: '音频 0' }] }, readAt: '2026-10-22T00:00:00.000Z',
    entries: [{ target: 2, name: '音频 0', eventCount: 1, frameFormat: '30 FPS', offset: '14430', slot: 'TC Slot 2', events: [{ path: '1', time: '30', action: 'Goto', executor: '1.1', cue: '1', name: null }], error: null, warnings: [] }] },
    pairs: {}, failures: [], selectedTarget: null, query: '', filter: 'all', message: '' };
  await f.player.play('song-0');
  expect(f.api.prepareNativePlayback.mock.calls[0]?.[0]).toMatchObject({ midiPortName: 'TEST', snapshot: { offsetMs: 480000 } });
  expect(f.lighting.prepare).toHaveBeenCalledOnce();
  expect(f.state()).toMatchObject({ status: 'playing', fault: null }); expect(f.state().notice).toMatch(/^控台 Timecode 2 从 .*对不上.*；时间码照常发送(；|$)/);
  await f.player.seek(3000);
  expect(f.api.prepareNativePlayback.mock.calls[1]?.[0].midiPortName).toBe('TEST'); expect(f.state().fault).toBeNull();
  expect(f.deps.notice.mock.calls.filter(([message]) => String(message).startsWith('控台 Timecode 2'))).toHaveLength(1);
  await f.player.play('song-1');
  expect(f.api.prepareNativePlayback.mock.calls[2]?.[0]).toMatchObject({ midiPortName: 'TEST', snapshot: { offsetMs: 500000 } });
  expect(f.state().fault).toBeNull(); expect(f.state().notice ?? '').not.toContain('对不上');
  await f.player.dispose();
});

it('播放只发时间码：旧工程存成网络输出的歌也照发时间码，灯光只准备停止时的关闭，停止时释放本曲执行器', async () => {
  const f = fixture(), lighting = lightingDocumentSchema.parse({ ...createLightingDocument(), outputMode: 'network' });
  lighting.tracks = [{ id: 'track', name: '灯光', kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false, channel: 1, controller: 7, portProfileId: '', noteNames: {},
    clips: [{ id: 'clip', name: '编排', start: 0, duration: 5000, timeLock: 'time', muted: false, events: [{ id: 'cue', kind: 'ma2', at: 1000, sequence: 1, executor: '1.101', cue: '1', action: 'goto', label: '开场', runMode: 'independent' }] }] }];
  f.project.rundown[0]!.lighting = lighting;
  await f.player.play('song-0');
  expect(f.api.prepareNativePlayback.mock.calls[0]?.[0].midiPortName).toBe('TEST');
  expect(f.lighting.prepare.mock.calls[0]?.[0]).toMatchObject({ outputMode: 'timecode' });
  expect(f.state().fault).toBeNull();
  await f.player.stop(); expect(f.lighting.release).toHaveBeenCalledOnce();
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

it('同一首歌开始播放后，被拒绝的预选画面预备不提示失败；播放前被拒绝仍提示', async () => {
  const f = fixture(); f.project.obsOutputMode = 'scenes';
  let refuse: (error: Error) => void = () => undefined;
  f.api.preloadNativeObs.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { refuse = reject; }));
  f.player.preloadSelected('song-0'); await f.player.play('song-0');
  refuse(new Error('正在播放时不能准备另一个节目')); await Promise.resolve(); await Promise.resolve();
  expect(f.state().notice ?? '').not.toContain('节目画面没有准备好');
  await f.player.stop();
  f.api.preloadNativeObs.mockRejectedValueOnce(new Error('素材不可读')); f.player.preloadSelected('song-1');
  await vi.waitFor(() => expect(f.state().notice).toContain('节目画面没有准备好：素材不可读'));
  await f.player.dispose();
});

it('播放另一首时后台丢弃预选节目的画面预备，这是正常切换，不提示“节目画面预备未完成”', async () => {
  const f = fixture(); f.project.obsOutputMode = 'scenes';
  let cancel: (error: Error) => void = () => { throw new Error('预备未开始'); };
  f.api.preloadNativeObs.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { cancel = reject; }));
  f.player.preloadSelected('song-1');
  await f.player.play('song-0'); cancel(new Error('节目准备已取消')); await Promise.resolve(); await Promise.resolve();
  expect(f.state().notice ?? '').not.toContain('节目画面没有准备好');
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
  it('全局顺序连播时，首次同步分配了起始码的歌没有自己的播完动作，播完接着播下一首', async () => {
    const f = fixture();
    // What the first console sync writes into a song without an MTC start.
    f.project.rundown[0]!.playback = { volume: 100, startMs: 0, endMs: 0, mtcOffsetMs: 810_000, shortcut: '' };
    f.player.setEndAction('next'); await f.player.play('song-0');
    expect(f.state().endAction).toBe('next');
    f.emit({ status: 'ended', positionMs: 10000 });
    await vi.waitFor(() => expect(f.state()).toMatchObject({ itemId: 'song-1', status: 'playing' }));
    await f.player.stop();
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
  it.each(['pause', 'next'] as const)('曲尾不发灯光指令，原定的 %s 照常进行，停止时才关执行器', async endAction => {
    const f = fixture();
    f.project.rundown[0]!.lighting = createLightingDocument();
    f.project.rundown[0]!.playback!.endAction = endAction;
    await f.player.play('song-0');
    expect(f.lighting.prepare).toHaveBeenCalledOnce();
    f.emit({ status: 'ended', positionMs: 9500 });
    await vi.waitFor(() => expect(f.state()).toMatchObject({
      status: endAction === 'pause' ? 'paused' : 'playing',
      itemId: endAction === 'pause' ? 'song-0' : 'song-1', error: null
    }));
    expect(f.state().playedItemIds).toContain('song-0');
    expect(f.lighting.release).not.toHaveBeenCalled();
    await f.player.stop();
    expect(f.lighting.release).toHaveBeenCalledOnce();
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
      rejectPreparation!(new Error('播放请求在排队时被取消'));
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
    expect(f.state().status).toBe('playing'); expect(f.state().notice).toContain('原因：OBS 未连接');
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
      expect(f.state().status).toBe('playing'); expect(f.state().notice).toContain('准备超时（');
      expect(f.deps.stop).toHaveBeenCalledTimes(2);
      release!(); await Promise.resolve(); f.emit({ positionMs: 2000 });
      expect(f.deps.ingest).not.toHaveBeenCalled(); expect(f.deps.started).not.toHaveBeenCalled();
      await f.player.stop();
    } finally { release?.(); vi.useRealTimers(); }
  });
});

it('29.97 丢帧工程照常发时间码，引擎按丢帧计算；不修改歌曲偏移', () => {
  const f = fixture(); f.project.timebase.frameRate = '29.97df';
  f.project.rundown[0]!.lighting = createLightingDocument();
  const result = nativeProgramSnapshot(f.project, 'song-0', 7, 1000, 48000);
  expect(result).toMatchObject({ allowMtc: true, notice: null, snapshot: { frameRate: 29.97, offsetMs: 480000 } });
  expect(f.project.rundown[0]!.playback!.mtcOffsetMs).toBe(480000);
});

for (const mode of ['network', 'direct', 'timecode']) it(`原生播放：控台上两个节目起点和存成 ${mode} 的歌曲相同时照发时间码，只提示（2026-10-26）`, async () => {
  const f = fixture();
  f.project.rundown[0]!.lighting = lightingDocumentSchema.parse({ ...createLightingDocument(), outputMode: mode });
  const entry = (target: number) => ({ target, name: `节目 ${target}`, eventCount: 1, frameFormat: '30 FPS', offset: '14400', slot: 'TC Slot 2', events: [{ path: '1', time: '30', action: 'Goto', executor: '1.1', cue: '1', name: null }], error: null, warnings: [] });
  f.project.ma2ReadState = { source: 'console', catalog: { directory: { show: 'test', generation: 'session', version: '3.7.0.5', entries: [] }, readAt: '2026-10-08T00:00:00.000Z', entries: [entry(2), entry(3)] },
    pairs: {}, failures: [], selectedTarget: null, query: '', filter: 'all', message: '' };
  const result = nativeProgramSnapshot(f.project, 'song-0', 7, 500, 48000);
  expect(result).toMatchObject({ allowMtc: true, notice: null, snapshot: { offsetMs: 480000 } });
  await f.player.play('song-0');
  expect(f.state()).toMatchObject({ status: 'playing', fault: null }); expect(f.state().notice).toMatch(/Timecode 2、3 的起点和这首歌相同.*时间码照常发送/);
  expect(f.lighting.prepare).toHaveBeenCalledOnce();
  expect(f.api.prepareNativePlayback.mock.calls[0]?.[0].midiPortName).toBe('TEST');
  await f.player.stop();
});

it('时间码输出失败只记录一次；另一条输出异常盖住提示后，后续状态不再重复记录', async () => {
  const f = fixture();
  await f.player.play('song-0');
  const failed = '时间码没有发出，音频照常播放。原因：Windows MIDI 输出失败（TEST）：错误码 6，请检查接口和驱动后手动重新播放';
  f.emit({ mtcError: 'Windows MIDI 输出失败（TEST）：错误码 6，请检查接口和驱动后手动重新播放' });
  f.player.reportFault('MIDI Cue 未参与：MIDI 驱动服务异常退出：3；音频继续播放。');
  for (let tick = 0; tick < 5; tick++) f.emit({ positionMs: 1000 + tick * 50 });
  expect(f.deps.notice.mock.calls.filter(([message]) => message === failed)).toHaveLength(1);
  expect(f.state().mtcConnectionFailed).toBe(true);
  await f.player.stop();
  await f.player.play('song-0');
  f.emit({ mtcError: 'Windows MIDI 输出失败（TEST）：错误码 6，请检查接口和驱动后手动重新播放' });
  expect(f.deps.notice.mock.calls.filter(([message]) => message === failed)).toHaveLength(2);
  await f.player.stop();
});

it('准备阶段音频读取失败时标明播放未开始，并给出处理音频的提示', async () => {
  const f = fixture();
  f.api.prepareNativePlayback.mockRejectedValueOnce(new Error('音频解码或读取失败：ENOENT: no such file or directory, stat \'C:/test/a-0.wav\''));
  await f.player.play('song-0');
  expect(f.state()).toMatchObject({ status: 'error', errorTitle: '没有开始播放：准备失败' });
  expect(f.state().error).toContain('换一个音频文件后重新播放');
});

it('没有画面动作的歌，OBS 未连接只提示画面未参与，不标成输出异常', async () => {
  const f = fixture(); f.project.obsOutputMode = 'scenes';
  f.api.prepareNativeObs.mockImplementation(request => Promise.resolve({ version: 1, sessionId: request.sessionId, generation: request.generation,
    itemId: request.snapshot.item.id, revision: request.snapshot.revision, state: 'failed', reason: 'OBS 没有连接，这一首不联动画面',
    currentCueId: null, nextCueId: null, pendingCount: 0, positionMs: 0 }));
  await f.player.play('song-0');
  expect(f.state()).toMatchObject({ status: 'playing', fault: null });
  expect(f.state().notice).toContain('OBS 没有连接');
  await f.player.dispose();
});

it('时间码接口断开后标红；同一接口回来后红色换成一次「时间码中断 X.X 秒后已恢复」提示，之后再断开仍标红', async () => {
  const f = fixture();
  await f.player.play('song-0');
  const lost = 'Windows MIDI 输出失败（TEST）：接口已断开（错误码 6）；同一接口重新连接后自动恢复时间码';
  f.emit({ mtcError: lost }); f.emit({ mtcError: lost });
  expect(f.state()).toMatchObject({ status: 'playing', fault: `时间码没有发出，音频照常播放。原因：${lost}`, mtcConnectionFailed: true });
  const recovered = { portName: 'TEST', interruptedAt: '2026-10-24T08:00:00.000Z', recoveredAt: '2026-10-24T08:00:02.400Z', durationMs: 2400 };
  f.emit({ mtcError: null, mtcPortName: 'TEST', mtcRecovered: recovered }); f.emit({ positionMs: 3000 });
  expect(f.state()).toMatchObject({ status: 'playing', fault: null, mtcConnectionFailed: false, mtcPortName: 'TEST' });
  expect(f.state().notice).toContain('时间码中断 2.4 秒后已恢复（TEST）');
  expect(f.deps.notice.mock.calls.filter(([message]) => String(message).includes('已恢复'))).toHaveLength(1);
  f.emit({ mtcError: lost });
  expect(f.state().fault).toBe(`时间码没有发出，音频照常播放。原因：${lost}`);
  await f.player.stop();
});

