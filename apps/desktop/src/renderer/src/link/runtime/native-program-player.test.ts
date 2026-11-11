import { describe, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, lightingDocumentSchema, linkCueSchema, parseLinkProject, type NativePlayerControl, type NativePlayerPrepare, type NativePlayerStatus, type NativeObsPrepare, type NativeObsStatus } from '@tb/schema';
import { NativeProgramPlayer, ObsPictureLeftover, type LightingOffOutcome, type ProgramLightingOutput } from '@tb/core/link';
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
    changed: (next: typeof state) => { state = next; }, notice: vi.fn(), closedFault: vi.fn() };
  // The main process's lights-off ledger (LightingOffService) as the player sees it: told what a start uses and a stop lets go.
  const lighting = { change: vi.fn<ProgramLightingOutput['change']>(() => Promise.resolve({ failed: [] })), stop: vi.fn<ProgramLightingOutput['stop']>(() => Promise.resolve({ failed: [] })) };
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

// 修复前：画面那边每次发状态都带着它的旧故障，播放器每次都重新报一遍，把之后动作 MIDI、时间码报的新故障顶回去。
it('画面那边每次发状态都重复它的旧故障：之后动作 MIDI 或时间码的红字照常显示；画面那边换了新故障才显示，换歌重新算', async () => {
  const f = fixture();
  let receive: ((value: NativeObsStatus) => void) | null = null;
  f.api.onNativeObsStatus.mockImplementation(listener => { receive = listener; return () => undefined; });
  const player = new NativeProgramPlayer(f.project, 'C:/test/project.tblink', 7, f.deps, f.api, f.lighting);
  await player.play('song-0');
  const request = f.api.prepareNativeObs.mock.calls.at(-1)![0], old = '画面动作失败：机位 · OBS 无响应';
  const running: NativeObsStatus = { version: 1, sessionId: request.sessionId, generation: request.generation, itemId: 'song-0', revision: 7,
    state: 'running', reason: null, currentCueId: null, nextCueId: null, pendingCount: 0, positionMs: 1000, fault: old };
  receive!(running);
  expect(f.state().fault).toBe(old);
  const midi = '动作 MIDI 没有发出，音频照常播放。原因：接口已断开';
  player.reportFault(midi);
  receive!({ ...running, positionMs: 1050 });
  expect(f.state().fault).toBe(midi);
  const lost = 'Windows MIDI 输出失败（TEST）：接口已断开（错误码 6）；同一接口重新连接后自动恢复时间码';
  f.emit({ mtcError: lost });
  receive!({ ...running, positionMs: 1100 });
  expect(f.state().fault).toBe(`时间码没有发出，音频照常播放。原因：${lost}`);
  f.emit({ mtcError: null, mtcPortName: 'TEST', mtcRecovered: { portName: 'TEST', interruptedAt: '2026-11-10T08:00:00.000Z', recoveredAt: '2026-11-10T08:00:02.400Z', durationMs: 2400 } });
  receive!({ ...running, positionMs: 1150 });
  expect(f.state().fault).toBeNull();
  receive!({ ...running, positionMs: 1200, fault: '画面动作失败：机位 2 · OBS 无响应' });
  expect(f.state().fault).toBe('画面动作失败：机位 2 · OBS 无响应');
  receive!({ ...running, positionMs: 1250 });
  expect(f.state().fault).toBe(old);
  // The next song's picture is its own: the same fault there is shown again, from its first status on.
  const ready = f.api.prepareNativeObs.getMockImplementation()!;
  f.api.prepareNativeObs.mockImplementationOnce(async next => ({ ...await ready(next), fault: old }));
  await player.play('song-1');
  expect(f.state()).toMatchObject({ itemId: 'song-1', fault: old });
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
  expect(f.lighting.change).toHaveBeenCalledOnce();
  expect(f.state()).toMatchObject({ status: 'playing', fault: null }); expect(f.state().notice).toMatch(/^控台 Timecode 2 从 .*对不上.*；时间码照常发送(；|$)/);
  await f.player.seek(3000);
  expect(f.api.prepareNativePlayback.mock.calls[1]?.[0].midiPortName).toBe('TEST'); expect(f.state().fault).toBeNull();
  expect(f.deps.notice.mock.calls.filter(([message]) => String(message).startsWith('控台 Timecode 2'))).toHaveLength(1);
  await f.player.play('song-1');
  expect(f.api.prepareNativePlayback.mock.calls[2]?.[0]).toMatchObject({ midiPortName: 'TEST', snapshot: { offsetMs: 500000 } });
  expect(f.state().fault).toBeNull(); expect(f.state().notice ?? '').not.toContain('对不上');
  await f.player.dispose();
});

it('播放只发时间码：旧工程存成网络输出的歌也照发时间码，开播只告诉关灯清单这首歌在用的执行器，停止时释放本曲执行器', async () => {
  const f = fixture(), lighting = lightingDocumentSchema.parse({ ...createLightingDocument(), outputMode: 'network' });
  lighting.tracks = [{ id: 'track', name: '灯光', kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false, channel: 1, controller: 7, portProfileId: '', noteNames: {},
    clips: [{ id: 'clip', name: '编排', start: 0, duration: 5000, timeLock: 'time', muted: false, events: [{ id: 'cue', kind: 'ma2', at: 1000, sequence: 1, executor: '1.101', cue: '1', action: 'goto', label: '开场', runMode: 'independent' }] }] }];
  f.project.rundown[0]!.lighting = lighting;
  await f.player.play('song-0');
  expect(f.api.prepareNativePlayback.mock.calls[0]?.[0].midiPortName).toBe('TEST');
  expect(f.lighting.change.mock.calls[0]?.[1]?.document).toMatchObject({ outputMode: 'timecode' });
  expect(f.state().fault).toBeNull();
  // The Off knows which song it is for: the failure names that song, not whichever plays when it goes out.
  const song0 = { document: lighting, song: { itemId: 'song-0', title: '音频 0' } };
  expect(f.lighting.change).toHaveBeenCalledExactlyOnceWith(null, song0);
  await f.player.stop(); expect(f.lighting.stop).toHaveBeenCalledExactlyOnceWith(song0, 'stop');
  await f.player.dispose();
});

describe('停止后马上改片段、重建播放器或关窗口，也关这首歌的执行器（0.5.9）', () => {
  // 修复前：停止排在定位、拖动定位或继续播放后面时，播放器一销毁，排队的停止就被跳过，执行器 Off 一个都不发。
  function lit() { const f = fixture(); f.project.rundown[0]!.lighting = createLightingDocument(); return f; }
  function gate() { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { promise, open }; }

  it('定位还在准备时停止并销毁：等音频和时间码停下后关一次执行器', async () => {
    const f = lit(); await f.player.play('song-0');
    const preparing = gate(), original = f.api.prepareNativePlayback.getMockImplementation()!;
    f.api.prepareNativePlayback.mockImplementationOnce(async request => { await preparing.promise; return original(request); });
    const seeking = f.player.seek(3000);
    await vi.waitFor(() => expect(f.api.prepareNativePlayback).toHaveBeenCalledTimes(2));
    const stopping = f.player.stop();
    const reply = f.api.controlNativePlayback.getMockImplementation()!, audioStopped = gate();
    f.api.controlNativePlayback.mockImplementationOnce(async command => { await audioStopped.promise; return reply(command); });
    const closing = f.player.dispose();
    await vi.waitFor(() => expect(f.api.controlNativePlayback.mock.calls.filter(([command]) => command.kind === 'stop')).toHaveLength(3));
    for (let tick = 0; tick < 10; tick++) await Promise.resolve();
    expect(f.lighting.stop).not.toHaveBeenCalled();
    audioStopped.open();
    await vi.waitFor(() => expect(f.lighting.stop).toHaveBeenCalledOnce());
    preparing.open(); await Promise.all([seeking, stopping, closing]);
    expect(f.lighting.stop).toHaveBeenCalledOnce();
  });

  it('拖动定位在等画面时停止并销毁：关一次执行器', async () => {
    const f = lit(); f.project.obsOutputMode = 'scenes';
    f.project.rundown[0]!.cues = [linkCueSchema.parse({ id: 'cue', name: '机位', timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 },
      actions: [{ id: 'scene', label: '机位', kind: 'obs.setProgramScene', sceneName: '场景' }] })];
    await f.player.play('song-0');
    const picture = gate(), ready = f.api.prepareNativeObs.getMockImplementation()!;
    f.api.prepareNativeObs.mockImplementationOnce(async request => { await picture.promise; return ready(request); });
    const scrubbing = f.player.scrub('song-0', 2000);
    await vi.waitFor(() => expect(f.api.prepareNativeObs).toHaveBeenCalledTimes(2));
    const stopping = f.player.stop(), closing = f.player.dispose();
    await vi.waitFor(() => expect(f.lighting.stop).toHaveBeenCalledOnce());
    picture.open(); await Promise.all([scrubbing, stopping, closing]);
    expect(f.lighting.stop).toHaveBeenCalledOnce();
  });

  it('继续播放在准备 MIDI 时停止并销毁：关一次执行器', async () => {
    const f = lit(); await f.player.play('song-0'); await f.player.pause();
    const midi = gate(); f.deps.prepare.mockImplementationOnce(() => midi.promise);
    const resuming = f.player.resume();
    await vi.waitFor(() => expect(f.deps.prepare).toHaveBeenCalledTimes(2));
    const stopping = f.player.stop(), closing = f.player.dispose();
    await vi.waitFor(() => expect(f.lighting.stop).toHaveBeenCalledOnce());
    midi.open(); await Promise.all([resuming, stopping, closing]);
    expect(f.lighting.stop).toHaveBeenCalledOnce();
  });

  it('停止已经关过灯，之后销毁不再发第二次', async () => {
    const f = lit(); await f.player.play('song-0');
    await f.player.stop(); await f.player.dispose();
    expect(f.lighting.stop).toHaveBeenCalledOnce();
  });

  // 修复前：播放器关了以后，状态不再发给任何界面，关灯失败只写进运行日志（第二次起只是 info），屏幕上什么都没有。
  // 这里只看播放器把失败交给宿主（closedFault）；宿主在窗口里标红、按错误记录，由 license-rules.test.ts 和
  // main-process-errors.test.ts 守着。文案先说结果，再说原因，最后说怎么办（docs/UI_COPY_GUIDE.md）。
  const closedOff = '「音频 0」的灯光没能完全关闭，控台上可能还亮着。原因：现在连着的不是原来那台控台，关灯指令没有发送。请在控台上关掉这首歌的执行器。';
  /** What the lights-off ledger answers when the Off did not go out: the reason, and the song the Off was for. */
  const refused = (itemId = 'song-0', title = '音频 0'): LightingOffOutcome => ({ failed: [{ song: { itemId, title }, reason: '现在连着的不是原来那台控台，关灯指令没有发送' }] });

  it('销毁时补发的关灯失败交给宿主，不再只写日志；不重试，也不让关闭播放器失败', async () => {
    const f = lit(); await f.player.play('song-0');
    const preparing = gate(), original = f.api.prepareNativePlayback.getMockImplementation()!;
    f.api.prepareNativePlayback.mockImplementationOnce(async request => { await preparing.promise; return original(request); });
    const seeking = f.player.seek(3000);
    await vi.waitFor(() => expect(f.api.prepareNativePlayback).toHaveBeenCalledTimes(2));
    f.lighting.stop.mockResolvedValueOnce(refused());
    const stopping = f.player.stop(), closing = f.player.dispose();
    await vi.waitFor(() => expect(f.lighting.stop).toHaveBeenCalledOnce());
    preparing.open();
    await expect(closing).resolves.toBeUndefined(); await Promise.all([seeking, stopping]);
    expect(f.deps.closedFault).toHaveBeenCalledExactlyOnceWith(closedOff, 'song-0');
    expect(f.deps.notice.mock.calls.filter(([message]) => String(message).includes('灯光没能完全关闭'))).toEqual([]);
    expect(f.lighting.stop).toHaveBeenCalledOnce();
  });

  it('停止正在关灯时播放器被销毁：关灯失败同样交给宿主，只发一次', async () => {
    const f = lit(); await f.player.play('song-0');
    let fail!: () => void;
    f.lighting.stop.mockImplementationOnce(() => new Promise<LightingOffOutcome>(resolve => { fail = () => resolve(refused()); }));
    const stopping = f.player.stop();
    await vi.waitFor(() => expect(f.lighting.stop).toHaveBeenCalledOnce());
    const closing = f.player.dispose();
    fail();
    await Promise.all([stopping, closing]);
    expect(f.deps.closedFault).toHaveBeenCalledExactlyOnceWith(closedOff, 'song-0');
    expect(f.lighting.stop).toHaveBeenCalledOnce();
  });

  it('播放器还开着时停止的关灯失败显示在播放器里，和红字一样写明哪首歌、怎么办，不另外弹窗', async () => {
    const f = lit(); await f.player.play('song-0');
    f.lighting.stop.mockResolvedValueOnce(refused());
    await f.player.stop();
    expect(f.state().notice).toContain(closedOff);
    expect(f.deps.notice).toHaveBeenCalledWith(closedOff, 'song-0');
    await f.player.dispose();
    expect(f.deps.closedFault).not.toHaveBeenCalled();
  });

  // 修复前：播放器开着时只写“灯光没能完全关闭：原因”，不说是哪首歌、该怎么办，日志还记在正在放的歌上；关的是上一首的
  // Off 时，操作员会去找一首根本没有执行器的歌。第 4 题（R13）以后，上一首的 Off 在换歌时就发，不再等到下一次停止或关闭。
  it('播放器开着时换歌关的是上一首的灯：提示写上一首的歌名，日志也记在上一首；之后停止和关闭不再发上一首的', async () => {
    const f = lit(); await f.player.play('song-0');
    const preparing = gate(), original = f.api.prepareNativePlayback.getMockImplementation()!;
    f.api.prepareNativePlayback.mockImplementationOnce(async request => { await preparing.promise; return original(request); });
    const seeking = f.player.seek(3000);
    await vi.waitFor(() => expect(f.api.prepareNativePlayback).toHaveBeenCalledTimes(2));
    f.lighting.change.mockResolvedValueOnce(refused());
    const stopping = f.player.stop(), next = f.player.play('song-1');
    preparing.open(); await Promise.all([seeking, stopping, next]);
    expect(f.state()).toMatchObject({ itemId: 'song-1', status: 'playing' });
    const song0 = { document: f.project.rundown[0]!.lighting!, song: { itemId: 'song-0', title: '音频 0' } };
    // The stop skipped behind the seek: the song change lets song 0's executors go, song 1 has no lighting.
    expect(f.lighting.change.mock.calls.at(-1)).toEqual([song0, null]);
    await vi.waitFor(() => expect(f.state().notice).toContain(closedOff));
    expect(f.deps.notice.mock.calls.filter(([message]) => String(message).includes('灯光没能完全关闭'))).toEqual([[closedOff, 'song-0']]);
    await f.player.stop();
    expect(f.lighting.stop).toHaveBeenCalledExactlyOnceWith(null, 'stop');
    await f.player.dispose();
    expect(f.lighting.stop).toHaveBeenCalledOnce();
    expect(f.deps.closedFault).not.toHaveBeenCalled();
  });

  // 修复前：红字里的歌名取自关闭那一刻正在放的歌。不带灯光的歌不换掉关灯计划，补发的是上一首的 Off，红字却叫操作员去找这一首的执行器。
  it('红字写这份 Off 所属的歌：上一首的停止排在定位后面被跳过、接着放不带灯光的歌、然后关闭；关闭时不再欠上一首的', async () => {
    const f = lit(); await f.player.play('song-0');
    const preparing = gate(), original = f.api.prepareNativePlayback.getMockImplementation()!;
    f.api.prepareNativePlayback.mockImplementationOnce(async request => { await preparing.promise; return original(request); });
    const seeking = f.player.seek(3000);
    await vi.waitFor(() => expect(f.api.prepareNativePlayback).toHaveBeenCalledTimes(2));
    const answer = gate(); let settle!: () => void;
    f.lighting.change.mockImplementationOnce(() => new Promise<LightingOffOutcome>(resolve => { settle = () => resolve(refused()); answer.open(); }));
    const stopping = f.player.stop(), next = f.player.play('song-1');
    preparing.open(); await Promise.all([seeking, stopping, next]);
    expect(f.state()).toMatchObject({ itemId: 'song-1', status: 'playing' });
    await f.player.dispose();
    // The console answers the song change's Off after the player closed: the host shows it.
    settle(); await answer.promise;
    await vi.waitFor(() => expect(f.deps.closedFault).toHaveBeenCalledExactlyOnceWith(closedOff, 'song-0'));
    expect(f.lighting.stop).not.toHaveBeenCalled();
  });

  // 修复前：界面进程退出后节目在后台继续，播放器没关，关灯失败只进播放器的提示（没有窗口看得到），日志里只是 warning，之后是 info。
  it('没有窗口在看时（界面退出，节目在后台继续），停止的关灯失败交给宿主标红；窗口接回后照旧显示在播放器里', async () => {
    const f = lit(); await f.player.play('song-0');
    f.player.setWatched(false);
    f.lighting.stop.mockResolvedValueOnce(refused());
    await f.player.stop();
    expect(f.deps.closedFault).toHaveBeenCalledExactlyOnceWith(closedOff, 'song-0');
    expect(f.deps.notice.mock.calls.filter(([message]) => String(message).includes('灯光没能完全关闭'))).toEqual([]);
    expect(f.state().notice ?? '').not.toContain('灯光没能完全关闭');
    f.player.setWatched(true); await f.player.play('song-0');
    f.lighting.stop.mockResolvedValueOnce(refused());
    await f.player.stop();
    expect(f.state().notice).toContain(closedOff);
    expect(f.deps.closedFault).toHaveBeenCalledOnce();
    await f.player.dispose();
  });

  // 修复前：原因取的是整句日常说法，超时的那句自己带着“请检查目标程序……”，红字里出现两个“怎么办”；认不出的英文报错前面
  // 还多一个“操作未能完成：”。
  it('原因只写原因：不带日常说法自己的下一步，也不带“操作未能完成：”；原因自己带句号时不出现“。。”；不知道是哪首歌时写“这首歌”', async () => {
    const f = lit(); f.player.setWatched(false);
    // The ledger itself could not be reached: the player names the song it stopped and only the reason.
    for (const cause of ['MA2 telnet timeout', 'connect ECONNREFUSED 192.0.2.1:30000', 'socket hang up']) {
      f.lighting.stop.mockRejectedValueOnce(new Error(cause));
      await f.player.play('song-0'); await f.player.stop();
    }
    f.lighting.stop.mockResolvedValueOnce({ failed: [{ song: null, reason: '控台正忙。' }] });
    await f.player.play('song-0'); await f.player.stop();
    expect(f.deps.closedFault.mock.calls).toEqual([
      ['「音频 0」的灯光没能完全关闭，控台上可能还亮着。原因：操作超时了。请在控台上关掉这首歌的执行器。', 'song-0'],
      ['「音频 0」的灯光没能完全关闭，控台上可能还亮着。原因：连不上目标设备。请在控台上关掉这首歌的执行器。', 'song-0'],
      ['「音频 0」的灯光没能完全关闭，控台上可能还亮着。原因：socket hang up。请在控台上关掉这首歌的执行器。', 'song-0'],
      ['这首歌的灯光没能完全关闭，控台上可能还亮着。原因：控台正忙。请在控台上关掉这首歌的执行器。', null]
    ]);
    await f.player.dispose();
  });
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
  it.each(['pause', 'next'] as const)('曲尾不发灯光指令，原定的 %s 照常进行；暂停的停止时才关执行器，接着放下一首按换歌关', async endAction => {
    const f = fixture();
    f.project.rundown[0]!.lighting = createLightingDocument();
    f.project.rundown[0]!.playback!.endAction = endAction;
    await f.player.play('song-0');
    expect(f.lighting.change).toHaveBeenCalledOnce();
    f.emit({ status: 'ended', positionMs: 9500 });
    await vi.waitFor(() => expect(f.state()).toMatchObject({
      status: endAction === 'pause' ? 'paused' : 'playing',
      itemId: endAction === 'pause' ? 'song-0' : 'song-1', error: null
    }));
    expect(f.state().playedItemIds).toContain('song-0');
    expect(f.lighting.stop).not.toHaveBeenCalled();
    // 第 4 题：接着放下一首就是换歌，只关上一首独有的执行器（不带灯光的下一首用不上任何一个）。
    const song0 = { document: f.project.rundown[0]!.lighting, song: { itemId: 'song-0', title: '音频 0' } };
    expect(f.lighting.change.mock.calls).toEqual(endAction === 'pause' ? [[null, song0]] : [[null, song0], [song0, null]]);
    await f.player.stop();
    expect(f.lighting.stop).toHaveBeenCalledExactlyOnceWith(endAction === 'pause' ? song0 : null, 'stop');
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
  it('声卡断一下、时间码一条没发出去：接着播并标红，次数在红字里，不停歌（2026-11-10 第 2 题）', async () => {
    const f = fixture(); await f.player.play('song-0'); f.deps.stop.mockClear();
    f.emit({ underruns: 1, outputFault: '声卡断了一下，音乐接着放（这首歌第 1 次）' });
    expect(f.state()).toMatchObject({ status: 'playing', error: null, fault: '声卡断了一下，音乐接着放（这首歌第 1 次）' });
    f.player.clearFault('声卡断了一下，音乐接着放（这首歌第 1 次）');
    f.emit({ positionMs: 1200 });
    expect(f.state().fault).toBeNull();
    f.emit({ outputFault: '有一条时间码没发出去，已从当前位置接着发（这首歌第 1 次）' });
    expect(f.state()).toMatchObject({ status: 'playing', fault: '有一条时间码没发出去，已从当前位置接着发（这首歌第 1 次）' });
    expect(f.deps.stop).not.toHaveBeenCalled();
    await f.player.dispose();
  });
  // 这一处也给停止的关灯提示用（reportNotice）。
  it('同一句提示还显示着时再报一次：不重复显示，也不重复记日志', async () => {
    const f = fixture(); await f.player.play('song-0'); f.deps.notice.mockClear();
    f.player.reportUnavailable('下一个节目无法提前准备：素材不见了'); f.player.reportUnavailable('下一个节目无法提前准备：素材不见了');
    expect(f.state().notice).toBe('下一个节目无法提前准备：素材不见了');
    expect(f.deps.notice.mock.calls).toEqual([['下一个节目无法提前准备：素材不见了', 'song-0']]);
    await f.player.dispose();
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
  expect(f.lighting.change).toHaveBeenCalledOnce();
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

describe('上一首的画面没有清理干净（2026-11-09）', () => {
  /** As the picture host hands it to the program's own stop, once; the host has logged it already. */
  const leftover = (itemId: string): ObsPictureLeftover => new ObsPictureLeftover(itemId, new Error('画面没有清理干净：Error: OBS 无响应'));
  const reason = 'OBS 无响应。请检查 OBS 节目画面上是否还留着刚才的素材';

  it('换下一首时收到：在下一首上标红，照常播，不另外提示也不再记一次；重播同一首写“上一次”', async () => {
    const f = fixture();
    await f.player.play('song-0');
    f.api.stopNativeObs.mockRejectedValueOnce(leftover('song-0')); f.deps.notice.mockClear();
    await f.player.play('song-1');
    expect(f.state()).toMatchObject({ status: 'playing', itemId: 'song-1', fault: `上一首的画面没有清理干净，这一首照常播。原因：${reason}` });
    expect(f.state().notice ?? '').not.toContain('清理');
    expect(f.deps.notice.mock.calls.filter(([message]) => String(message).includes('清理'))).toEqual([]);
    f.api.stopNativeObs.mockRejectedValueOnce(leftover('song-1'));
    await f.player.play('song-1');
    expect(f.state()).toMatchObject({ status: 'playing', itemId: 'song-1', fault: `上一次的画面没有清理干净，这一首照常播。原因：${reason}` });
    await f.player.dispose();
  });

  it('开下一首途中按了停止：停下的播放器马上提示一次，不标红，也不再记一次', async () => {
    const f = fixture();
    await f.player.play('song-0');
    let refuse: (error: Error) => void = () => { throw new Error('还没开始停上一首的画面'); };
    f.api.stopNativeObs.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { refuse = reject; }));
    f.deps.notice.mockClear();
    const playing = f.player.play('song-1');
    await vi.waitFor(() => expect(f.api.stopNativeObs).toHaveBeenCalledOnce());
    const stopping = f.player.stop();
    refuse(leftover('song-0')); await playing; await stopping;
    expect(f.state()).toMatchObject({ status: 'stopped', fault: null, notice: `画面清理失败：${reason}` });
    expect(f.deps.notice.mock.calls.filter(([message]) => String(message).includes('清理'))).toEqual([]);
    await f.player.dispose();
  });

  it('停不掉上一首的画面另有原因：照旧提示并记录，不当成没清理干净', async () => {
    const f = fixture();
    await f.player.play('song-0');
    f.api.stopNativeObs.mockRejectedValueOnce(new Error('这是上一次准备的停止请求，已忽略'));
    await f.player.play('song-1');
    expect(f.state()).toMatchObject({ status: 'playing', fault: null, notice: '上一次的画面没清理干净：这是上一次准备的停止请求，已忽略' });
    expect(f.deps.notice).toHaveBeenCalledWith('上一次的画面没清理干净：这是上一次准备的停止请求，已忽略', 'song-1');
    await f.player.dispose();
  });

  it('关闭节目时才收到：交还给画面那边，由之后开播的歌显示；关闭照常完成，不挡住之后再开节目', async () => {
    const f = fixture();
    await f.player.play('song-0');
    const handedBack = vi.fn();
    f.api.stopNativeObs.mockRejectedValueOnce(new ObsPictureLeftover('song-0', new Error('画面没有清理干净：Error: OBS 无响应'), handedBack));
    await expect(f.player.dispose()).resolves.toBeUndefined();
    expect(handedBack).toHaveBeenCalledOnce();
  });

  // 修复前：关闭节目时画面停不掉另有原因（画面那边把它当成上一次的停止请求，或请求没有送达），或者提前准备的画面
  // 清理失败，整个关闭就算失败：主进程之后再也开不了节目，也退不出软件。
  it('关闭节目时画面停不掉另有原因、提前准备的画面也没清理干净：各记一次，关闭照常完成；只有音频停不掉时关闭才算失败', async () => {
    const f = fixture();
    await f.player.play('song-0'); f.deps.notice.mockClear();
    f.api.stopNativeObs.mockRejectedValueOnce(new Error('这是上一次准备的停止请求，已忽略，当前节目不受影响'));
    await expect(f.player.dispose()).resolves.toBeUndefined();
    expect(f.deps.notice.mock.calls).toEqual([['关闭节目时画面清理失败：这是上一次准备的停止请求，已忽略，当前节目不受影响', 'song-0']]);
    const g = fixture();
    await g.player.play('song-0'); await g.player.stop(); g.player.preloadSelected('song-1'); g.deps.notice.mockClear();
    g.api.cancelNativeObsPreload.mockRejectedValueOnce(new Error('OBS 请求超时（2000 ms）'));
    await expect(g.player.dispose()).resolves.toBeUndefined();
    expect(g.deps.notice.mock.calls).toEqual([['关闭节目时提前准备的画面没清理干净：OBS 请求超时（2000 ms）', 'song-0']]);
    const h = fixture();
    await h.player.play('song-0');
    h.api.controlNativePlayback.mockRejectedValueOnce(new Error('音频引擎没有响应'));
    await expect(h.player.dispose()).rejects.toThrow('音频引擎没有响应');
  });

  // 修复前：节目在动作 MIDI 还开着时关掉（播放中跟着改了声卡、换了工程），MIDI 驱动服务之前又异常退出过：动作 MIDI 关不掉，
  // 整个关闭就算失败，之后每次打开节目都失败，退出时也弹“退出流程失败”，要重启软件才行。
  it('关闭节目时动作 MIDI 没能关掉：记一次、在窗口里说一次，关闭照常完成，不挡住之后再开节目', async () => {
    const f = fixture();
    await f.player.play('song-0'); f.deps.notice.mockClear();
    f.deps.stop.mockRejectedValueOnce(new AggregateError([new Error('MIDI 驱动服务异常退出：3')], 'MIDI 驱动服务异常退出：3'));
    await expect(f.player.dispose()).resolves.toBeUndefined();
    expect(f.deps.closedFault.mock.calls).toEqual([
      ['关闭节目时动作 MIDI 没有正常关掉，之后的歌照常播放。原因：MIDI 驱动服务异常退出：3。如果之后的歌没有发出动作 MIDI，请检查 MIDI 接口和线。', 'song-0', 'leftOpen']]);
    expect(f.deps.notice).not.toHaveBeenCalled();
  });

  it('按停止时收到：停下的播放器提示一次，不标红，也不再记一次；停不掉另有原因时照旧提示并记录', async () => {
    const f = fixture();
    await f.player.play('song-0');
    f.api.stopNativeObs.mockRejectedValueOnce(leftover('song-0')); f.deps.notice.mockClear();
    await f.player.stop();
    expect(f.state()).toMatchObject({ status: 'stopped', fault: null, notice: `画面清理失败：${reason}` });
    expect(f.deps.notice.mock.calls.filter(([message]) => String(message).includes('清理'))).toEqual([]);
    await f.player.play('song-1');
    f.api.stopNativeObs.mockRejectedValueOnce(new Error('OBS 停止请求没有送达'));
    await f.player.stop();
    expect(f.state()).toMatchObject({ status: 'stopped', notice: '画面清理失败：OBS 停止请求没有送达' });
    expect(f.deps.notice).toHaveBeenCalledWith('画面清理失败：OBS 停止请求没有送达', 'song-1');
    await f.player.dispose();
  });

  it('拖动定位时收到：在这首歌上标红，不另外提示也不再记一次；新位置的画面照常准备，再定位时不再带上它', async () => {
    const f = fixture(), ready = f.api.prepareNativeObs.getMockImplementation()!, taken = '提前准备的画面没能用上，已改为重新准备。原因：OBS 无响应';
    await f.player.play('song-0'); await f.player.pause();
    f.api.stopNativeObs.mockRejectedValueOnce(leftover('song-0')); f.deps.notice.mockClear();
    await f.player.scrub('song-0', 2000);
    expect(f.state()).toMatchObject({ status: 'paused', positionMs: 2000, fault: `上一次的画面没有清理干净，这一首照常播。原因：${reason}` });
    expect(f.state().notice ?? '').not.toContain('清理');
    expect(f.deps.notice.mock.calls.filter(([message]) => String(message).includes('清理'))).toEqual([]);
    expect(f.api.prepareNativeObs).toHaveBeenCalledTimes(2);
    f.api.prepareNativeObs.mockImplementationOnce(async request => ({ ...await ready(request), fault: taken }));
    await f.player.scrub('song-0', 3000);
    expect(f.state()).toMatchObject({ status: 'paused', positionMs: 3000, fault: taken });
    await f.player.dispose();
  });

  it('拖动定位还没完时连按两次继续：定位好了只接着播一次，画面不停，MIDI Cue 也只准备一次', async () => {
    const f = fixture(), ready = f.api.prepareNativeObs.getMockImplementation()!;
    await f.player.play('song-0'); await f.player.pause();
    let finish: () => void = () => { throw new Error('还没开始准备画面'); };
    f.api.prepareNativeObs.mockImplementationOnce(request => new Promise(resolve => { finish = () => resolve(ready(request)); }));
    f.deps.prepare.mockClear(); f.api.controlNativePlayback.mockClear();
    const scrubbing = f.player.scrub('song-0', 2000);
    await vi.waitFor(() => expect(f.api.prepareNativeObs).toHaveBeenCalledTimes(2));
    const first = f.player.resume(), second = f.player.resume();
    finish(); await scrubbing; await first; await second;
    expect(f.state()).toMatchObject({ status: 'playing', positionMs: 2000, fault: null });
    expect(f.deps.prepare).toHaveBeenCalledOnce();
    expect(f.api.controlNativePlayback.mock.calls.map(([command]) => command.kind)).toEqual(['seek', 'play']);
    // Only the scrub's stop of the picture before it; the picture at the new position stays.
    expect(f.api.stopNativeObs).toHaveBeenCalledOnce();
    await f.player.dispose();
  });

  it('取消的画面准备在新开的歌那边已经标红之后才报没清理干净：两条一起显示', async () => {
    const f = fixture(), ready = f.api.prepareNativeObs.getMockImplementation()!, taken = '提前准备的画面没能用上，已改为重新准备。原因：OBS 无响应';
    let finish: () => void = () => { throw new Error('还没开始准备画面'); };
    let refuse: (error: Error) => void = () => { throw new Error('还没开始停画面'); };
    f.api.prepareNativeObs.mockImplementationOnce(request => new Promise(resolve => { finish = () => resolve(ready(request)); }))
      .mockImplementationOnce(async request => ({ ...await ready(request), fault: taken }));
    f.api.stopNativeObs.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { refuse = reject; }));
    const first = f.player.play('song-0');
    await vi.waitFor(() => expect(f.api.prepareNativeObs).toHaveBeenCalledOnce());
    const second = f.player.play('song-1');
    finish(); await first; await second;
    expect(f.state()).toMatchObject({ status: 'playing', itemId: 'song-1', fault: taken });
    refuse(leftover('song-0'));
    await vi.waitFor(() => expect(f.state().fault).toBe(`上一首的画面没有清理干净，这一首照常播。原因：${reason}；${taken}`));
    await f.player.dispose();
  });

  it('关闭节目以后，取消的画面准备才报没清理干净：同样交还给画面那边', async () => {
    const f = fixture(), ready = f.api.prepareNativeObs.getMockImplementation()!, handedBack = vi.fn();
    let finish: () => void = () => { throw new Error('还没开始准备画面'); };
    let refuse: (error: Error) => void = () => { throw new Error('还没开始停画面'); };
    f.api.prepareNativeObs.mockImplementationOnce(request => new Promise(resolve => { finish = () => resolve(ready(request)); }));
    f.api.stopNativeObs.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { refuse = reject; }));
    const playing = f.player.play('song-0');
    await vi.waitFor(() => expect(f.api.prepareNativeObs).toHaveBeenCalledOnce());
    const stopping = f.player.stop(), closing = f.player.dispose();
    refuse(new ObsPictureLeftover('song-0', new Error('画面没有清理干净：OBS 无响应'), handedBack)); finish();
    await expect(closing).resolves.toBeUndefined(); await playing; await stopping;
    expect(handedBack).toHaveBeenCalledOnce(); expect(f.api.stopNativeObs).toHaveBeenCalledOnce();
  });

  it('画面刚准备好的同时关闭节目、这首歌的画面没清理干净：同样交还给画面那边，关闭照常完成', async () => {
    const f = fixture(), handedBack = vi.fn(); f.project.obsOutputMode = 'scenes';
    f.project.rundown[0]!.cues = [linkCueSchema.parse({ id: 'cue', name: '机位', timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 },
      actions: [{ id: 'scene', label: '机位', kind: 'obs.setProgramScene', sceneName: '场景' }] })];
    let finish: () => void = () => { throw new Error('还没开始准备画面'); };
    // The answer comes in the same moment as the close: the song, which waits for its picture, stops it before the close does.
    f.api.prepareNativeObs.mockImplementationOnce(request => new Promise(resolve => { finish = () => resolve({ version: 1, sessionId: request.sessionId,
      generation: request.generation, itemId: request.snapshot.item.id, revision: request.snapshot.revision, state: 'ready', reason: null,
      currentCueId: null, nextCueId: null, pendingCount: 0, positionMs: 0 }); }));
    f.api.stopNativeObs.mockRejectedValueOnce(new ObsPictureLeftover('song-0', new Error('画面没有清理干净：OBS 无响应'), handedBack));
    const playing = f.player.play('song-0');
    await vi.waitFor(() => expect(f.api.prepareNativeObs).toHaveBeenCalledOnce());
    finish(); const closing = f.player.dispose();
    await expect(closing).resolves.toBeUndefined(); await playing;
    expect(handedBack).toHaveBeenCalledOnce(); expect(f.api.stopNativeObs).toHaveBeenCalledOnce();
  });

  it('画面还在准备时换歌、取消的画面没清理干净：在新开的歌上标红，不另外提示也不再记一次', async () => {
    const f = fixture(), ready = f.api.prepareNativeObs.getMockImplementation()!;
    let finish: () => void = () => { throw new Error('还没开始准备画面'); };
    f.api.prepareNativeObs.mockImplementationOnce(request => new Promise(resolve => { finish = () => resolve(ready(request)); }));
    f.api.stopNativeObs.mockRejectedValueOnce(leftover('song-0'));
    const first = f.player.play('song-0');
    await vi.waitFor(() => expect(f.api.prepareNativeObs).toHaveBeenCalledOnce());
    const second = f.player.play('song-1');
    finish(); await first; await second;
    expect(f.state()).toMatchObject({ status: 'playing', itemId: 'song-1', fault: `上一首的画面没有清理干净，这一首照常播。原因：${reason}` });
    expect(f.state().notice ?? '').not.toContain('清理');
    expect(f.deps.notice.mock.calls.filter(([message]) => String(message).includes('清理'))).toEqual([]);
    await f.player.dispose();
  });

  it('画面一秒没准备好、取消时没清理干净：在这首歌上标红，说的是取消的画面准备，不是“上一次”；不另外提示也不再记一次', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.api.prepareNativeObs.mockImplementationOnce(() => new Promise<NativeObsStatus>(() => undefined));
      f.api.stopNativeObs.mockRejectedValueOnce(leftover('song-0'));
      const playing = f.player.play('song-0');
      await vi.advanceTimersByTimeAsync(1500); await playing;
      expect(f.state()).toMatchObject({ status: 'playing', itemId: 'song-0', fault: `取消的画面准备没有清理干净，不影响播放。原因：${reason}` });
      expect(f.deps.notice.mock.calls.filter(([message]) => String(message).includes('清理'))).toEqual([]);
      await f.player.dispose();
    } finally { vi.useRealTimers(); }
  });

  // 修复前：这首歌开播时播放器自己报的红字（画面准备失败、停止时关灯的准备失败）整句顶掉“上一首的画面没有清理干净”，
  // 提醒去看 OBS 节目画面上有没有留着素材的那句只剩在日志里。
  it('上一首的画面没清理干净、这一首的画面也准备失败（OBS 卡住）：两条一起标红，不互相顶掉', async () => {
    const f = fixture(); f.project.obsOutputMode = 'scenes';
    // The second song has picture work, so it waits for its picture and its failure is red.
    f.project.rundown[1]!.cues = [linkCueSchema.parse({ id: 'cue', name: '机位', timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 },
      actions: [{ id: 'scene', label: '机位', kind: 'obs.setProgramScene', sceneName: '场景' }] })];
    await f.player.play('song-0');
    f.api.stopNativeObs.mockRejectedValueOnce(leftover('song-0'));
    f.api.prepareNativeObs.mockRejectedValueOnce(new Error('OBS 请求超时（2000 ms）'));
    await f.player.play('song-1');
    expect(f.state()).toMatchObject({ status: 'playing', itemId: 'song-1',
      fault: `上一首的画面没有清理干净，这一首照常播。原因：${reason}；画面准备失败，音乐和时间码照常播放：OBS 请求超时（2000 ms）` });
    await f.player.dispose();
  });

  // 修复前：开播时时间码没发出的红字整句顶掉“上一首的画面没有清理干净”。
  it('上一首的画面没清理干净、这一首开播时时间码也没发出：两条一起标红；同一接口回来后只清掉时间码那条', async () => {
    const f = fixture();
    await f.player.play('song-0');
    f.api.stopNativeObs.mockRejectedValueOnce(leftover('song-0'));
    const lost = 'Windows MIDI 输出失败（TEST）：接口已断开（错误码 6）；同一接口重新连接后自动恢复时间码';
    // The engine reports the timecode lost while the song still prepares its picture.
    const ready = f.api.prepareNativeObs.getMockImplementation()!;
    f.api.prepareNativeObs.mockImplementationOnce(request => { f.emit({ mtcError: lost }); return ready(request); });
    await f.player.play('song-1');
    const cleanup = `上一首的画面没有清理干净，这一首照常播。原因：${reason}`;
    expect(f.state()).toMatchObject({ status: 'playing', itemId: 'song-1', fault: `${cleanup}；时间码没有发出，音频照常播放。原因：${lost}` });
    f.emit({ mtcError: null, mtcPortName: 'TEST', mtcRecovered: { portName: 'TEST', interruptedAt: '2026-11-09T08:00:00.000Z', recoveredAt: '2026-11-09T08:00:02.400Z', durationMs: 2400 } });
    expect(f.state()).toMatchObject({ status: 'playing', fault: cleanup });
    expect(f.state().notice).toContain('时间码中断 2.4 秒后已恢复（TEST）');
    await f.player.dispose();
  });

  it('上一首的画面没清理干净、这一首开播时动作 MIDI 也断了：两条一起标红；接口回来后只清掉动作 MIDI 那条', async () => {
    const f = fixture();
    await f.player.play('song-0');
    f.api.stopNativeObs.mockRejectedValueOnce(leftover('song-0'));
    const midi = '动作 MIDI 没有发出，音频照常播放。原因：接口已断开';
    const ready = f.api.prepareNativeObs.getMockImplementation()!;
    f.api.prepareNativeObs.mockImplementationOnce(request => { f.player.reportFault(midi); return ready(request); });
    await f.player.play('song-1');
    const cleanup = `上一首的画面没有清理干净，这一首照常播。原因：${reason}`;
    expect(f.state()).toMatchObject({ status: 'playing', itemId: 'song-1', fault: `${cleanup}；${midi}` });
    f.player.clearFault(midi);
    expect(f.state()).toMatchObject({ status: 'playing', fault: cleanup });
    await f.player.dispose();
  });

  // 修复前：拖动定位让开播的记录重新开始，红字却还是两条一起的那句：时间码或动作 MIDI 之后恢复了，也清不掉自己那条。
  for (const output of ['时间码', '动作 MIDI'] as const) it(`两条一起标红后拖动定位：${output}之后恢复，照样只清掉自己那条`, async () => {
    const f = fixture();
    await f.player.play('song-0');
    f.api.stopNativeObs.mockRejectedValueOnce(leftover('song-0'));
    const lost = 'Windows MIDI 输出失败（TEST）：接口已断开（错误码 6）；同一接口重新连接后自动恢复时间码';
    const midi = '动作 MIDI 没有发出，音频照常播放。原因：接口已断开';
    const ready = f.api.prepareNativeObs.getMockImplementation()!;
    f.api.prepareNativeObs.mockImplementationOnce(request => {
      if (output === '时间码') f.emit({ mtcError: lost }); else f.player.reportFault(midi);
      return ready(request);
    });
    await f.player.play('song-1');
    const cleanup = `上一首的画面没有清理干净，这一首照常播。原因：${reason}`;
    const red = output === '时间码' ? `时间码没有发出，音频照常播放。原因：${lost}` : midi;
    expect(f.state().fault).toBe(`${cleanup}；${red}`);
    await f.player.pause(); await f.player.scrub('song-1', 3000); await f.player.scrub('song-1', 3500);
    expect(f.state()).toMatchObject({ status: 'paused', positionMs: 3500, fault: `${cleanup}；${red}` });
    if (output === '时间码') f.emit({ mtcError: null, mtcPortName: 'TEST', mtcRecovered: { portName: 'TEST', interruptedAt: '2026-11-10T08:00:00.000Z', recoveredAt: '2026-11-10T08:00:02.400Z', durationMs: 2400 } });
    else f.player.clearFault(midi);
    expect(f.state()).toMatchObject({ status: 'paused', fault: cleanup });
    await f.player.dispose();
  });

  it('同一首开播时画面那边也标了红：两条一起显示，画面那边重复发来也不变；之后播放中的新故障照常替换', async () => {
    const f = fixture();
    let receive: ((value: NativeObsStatus) => void) | null = null;
    f.api.onNativeObsStatus.mockImplementation(listener => { receive = listener; return () => undefined; });
    const player = new NativeProgramPlayer(f.project, 'C:/test/project.tblink', 7, f.deps, f.api, f.lighting);
    await player.play('song-0');
    const ready = f.api.prepareNativeObs.getMockImplementation()!, taken = '提前准备的画面没能用上，已改为重新准备。原因：OBS 无响应';
    f.api.prepareNativeObs.mockImplementationOnce(async request => ({ ...await ready(request), fault: taken }));
    f.api.stopNativeObs.mockRejectedValueOnce(leftover('song-0'));
    await player.play('song-1');
    const red = `上一首的画面没有清理干净，这一首照常播。原因：${reason}；${taken}`;
    expect(f.state()).toMatchObject({ status: 'playing', itemId: 'song-1', fault: red });
    const request = f.api.prepareNativeObs.mock.calls.at(-1)![0];
    const running: NativeObsStatus = { version: 1, sessionId: request.sessionId, generation: request.generation, itemId: 'song-1', revision: 7,
      state: 'running', reason: null, currentCueId: null, nextCueId: null, pendingCount: 0, positionMs: 1000, fault: taken };
    receive!(running);
    expect(f.state().fault).toBe(red);
    receive!({ ...running, fault: '画面动作失败：机位 · OBS 无响应' });
    expect(f.state().fault).toBe('画面动作失败：机位 · OBS 无响应');
    // The next start is its own: the earlier failed cleanup does not come back with it.
    f.api.prepareNativeObs.mockImplementationOnce(async request => ({ ...await ready(request), fault: taken }));
    await player.play('song-0');
    expect(f.state()).toMatchObject({ status: 'playing', itemId: 'song-0', fault: taken });
    await player.play('song-1');
    expect(f.state().fault).toBeNull();
    await player.dispose();
  });
});

describe('准备中、拖动定位还没完时按播放键（2026-11-09）', () => {
  const playKey = Uint8Array.from([0x90, 1, 100]);
  /** The next picture preparation answers only when the test says so. */
  function holdPicture(f: ReturnType<typeof fixture>): () => void {
    const ready = f.api.prepareNativeObs.getMockImplementation()!;
    let finish: () => void = () => { throw new Error('还没开始准备画面'); };
    f.api.prepareNativeObs.mockImplementationOnce(request => new Promise(resolve => { finish = () => resolve(ready(request)); }));
    return () => finish();
  }

  // 修复前：准备中按 MIDI 播放键（note 1）会从歌头重新准备并开播，刚点到的位置丢了，音乐、时间码和灯光都跳回歌头。
  // 播放按钮和空格在准备中本来就不动。
  it('暂停时点波形换位置、新位置还在准备时按 MIDI 播放键：不从歌头重新准备，停在新位置', async () => {
    const f = fixture();
    await f.player.play('song-0'); await f.player.pause();
    const finish = holdPicture(f);
    const seeking = f.player.seek(3000);
    await vi.waitFor(() => expect(f.api.prepareNativeObs).toHaveBeenCalledTimes(2));
    expect(f.state().status).toBe('preparing');
    f.player.receiveMidi(playKey);
    finish(); await seeking;
    expect(f.state()).toMatchObject({ status: 'paused', positionMs: 3000 });
    await f.player.dispose();
    // The first play and the seek: the key started nothing over from the head of the song.
    expect(f.api.prepareNativePlayback.mock.calls.map(([request]) => request.snapshot.positionMs)).toEqual([500, 3000]);
  });

  it('播放中点波形换位置、新位置还在准备时按 MIDI 播放键：不从歌头重新准备，从新位置照常播', async () => {
    const f = fixture();
    await f.player.play('song-0');
    const finish = holdPicture(f);
    const seeking = f.player.seek(3000);
    await vi.waitFor(() => expect(f.api.prepareNativeObs).toHaveBeenCalledTimes(2));
    f.player.receiveMidi(playKey);
    finish(); await seeking;
    expect(f.state()).toMatchObject({ status: 'playing', positionMs: 3000 });
    await f.player.dispose();
    expect(f.api.prepareNativePlayback.mock.calls.map(([request]) => request.snapshot.positionMs)).toEqual([500, 3000]);
  });

  // 修复前：歌停在曲尾时，继续播放按的是定位之前的位置，判断成“已经播完”，从歌头重播，拖到的位置丢了。
  it('停在曲尾时把播放头拖回前面、定位指令还没回来就按继续：从拖到的位置接着播，不从歌头重播', async () => {
    const f = fixture();
    await f.player.play('song-0');
    f.emit({ status: 'ended', positionMs: 9500 });
    await vi.waitFor(() => expect(f.state().status).toBe('paused'));
    const reply = f.api.controlNativePlayback.getMockImplementation()!;
    let answer: () => void = () => { throw new Error('定位指令还没发出'); };
    f.api.controlNativePlayback.mockImplementationOnce(command => new Promise(resolve => { answer = () => resolve(reply(command)); }));
    const scrubbing = f.player.scrub('song-0', 2000);
    await vi.waitFor(() => expect(f.api.controlNativePlayback.mock.calls.at(-1)?.[0].kind).toBe('seek'));
    const resuming = f.player.resume();
    answer(); await scrubbing; await resuming;
    expect(f.state()).toMatchObject({ status: 'playing', positionMs: 2000 });
    expect(f.api.prepareNativePlayback).toHaveBeenCalledOnce();
    await f.player.dispose();
  });

  // 修复前：拖动定位还没完时只有第一下算数：判断用的是定位完成前的状态，后按的那一下被丢掉，要再按一次。
  it('暂停时拖动定位还没完，先按继续又按暂停：以最后按的为准，停在新位置', async () => {
    const f = fixture();
    await f.player.play('song-0'); await f.player.pause();
    const finish = holdPicture(f); f.api.controlNativePlayback.mockClear();
    const scrubbing = f.player.scrub('song-0', 2000);
    await vi.waitFor(() => expect(f.api.prepareNativeObs).toHaveBeenCalledTimes(2));
    const resuming = f.player.resume(), pausing = f.player.pause();
    finish(); await scrubbing; await resuming; await pausing;
    expect(f.state()).toMatchObject({ status: 'paused', positionMs: 2000 });
    expect(f.api.controlNativePlayback.mock.calls.map(([command]) => command.kind)).toEqual(['seek']);
    await f.player.dispose();
  });

  it('播放中拖动定位还没完，按两次 MIDI 播放键（暂停、再继续）：以最后按的为准，定位好了从新位置接着播，新位置的画面不停', async () => {
    const f = fixture();
    await f.player.play('song-0');
    const finish = holdPicture(f); f.api.controlNativePlayback.mockClear();
    const scrubbing = f.player.scrub('song-0', 2000);
    await vi.waitFor(() => expect(f.api.prepareNativeObs).toHaveBeenCalledTimes(2));
    f.player.receiveMidi(playKey); f.player.receiveMidi(playKey);
    finish(); await scrubbing;
    expect(f.state()).toMatchObject({ status: 'playing', positionMs: 2000 });
    expect(f.api.controlNativePlayback.mock.calls.map(([command]) => command.kind)).toEqual(['seek', 'play']);
    // Only the picture before the scrub was stopped; the one prepared at the new position stays.
    expect(f.api.stopNativeObs).toHaveBeenCalledOnce();
    await f.player.dispose();
  });
});

