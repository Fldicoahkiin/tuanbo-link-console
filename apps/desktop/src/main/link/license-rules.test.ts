import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject, type LicenseStatus, type Ma2NetworkStatus, type Ma2PlaybackAction,
  type Ma2PlaybackRequest, type NativeObsPrepare, type NativePlayerControl, type NativePlayerPrepare, type NativePlayerStatus, type NativeProgramOpen } from '@tb/schema';
import { emptyInternalPlayerState, midiMessageNeedsLicense, type PlaybackBoundary } from '@tb/core/link';
import { LicenseAccess, needsProductLicense } from './license-access';
import { NativeProgramService } from './native-program-service';
import { NativeProgramHost } from './native-program-host';
import { programLicense } from './program-license';
import { closedProgramFaultReporter } from './main-process-errors';
import type { LinkLogInput } from './run-logger';

/**
 * 授权失效时的演出规则（2026-11-09 定，docs/LICENSE_IMPLEMENTATION.md）：停止、关灯、暂停、静音、隐藏一律不过授权；
 * 正在进行的演出跟后台节目走，不跟界面走；演出停下、界面这一场也结束后，新开一首要重新检查授权。本机授权提醒对用户
 * 承诺“到期时正在进行的演出不会中断”（license-reminders.ts）。改代码让这里失败，就是违反了这些规则。
 * 界面和后台节目对 MIDI 的判断一致，由 renderer/src/registry/midi-license-rule.test.ts 守着（界面的适配器要 DOM 类型）。
 */

const valid: LicenseStatus = {
  machineCode: `TB1-${'A'.repeat(64)}`, state: 'active', message: '本机授权有效', enforcement: 'required', onlineAvailable: true,
  claims: { version: 1, product: 'tuanbo-link-console', licenseId: '9d53530a-6712-423e-985e-e69beb9ec1c6', customer: '测试客户', machineCode: `TB1-${'A'.repeat(64)}`,
    kind: 'subscription', issuedAt: '2026-09-27T00:00:00Z', useUntil: '2026-11-09T12:00:00Z', updatesUntil: '2027-09-27T00:00:00Z' }
};
/** What LicenseService reports when the term ran out, the offline lease ended, or the clock went back more than five minutes. */
const lapsed: Record<string, LicenseStatus> = {
  到期: { ...valid, state: 'expired', message: '授权已到期；工程文件不受影响' },
  离线期到: { ...valid, state: 'renewal-required', message: '离线使用期已到，请联网验证一次授权（买断授权本身没有到期）' },
  时间回拨: { ...valid, state: 'invalid', claims: null, message: '读取或校验授权失败：检测到系统时间被调回过，请校正系统日期后联网验证' }
};
const network = { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' };
const cue = (action: Ma2PlaybackAction): Ma2PlaybackRequest => ({ network, action, sessionId: randomUUID(), deadlineAt: Date.now() + 7000 });
const off: Ma2PlaybackAction = { target: 'executor', executor: '1.101', action: 'off' };
const starts: Ma2PlaybackAction[] = [{ target: 'executor', executor: '1.101', cue: '1', action: 'goto' }, { target: 'sequence', sequence: 36, action: 'go' }];
const control = (kind: string) => ({ version: 1, sessionId: randomUUID(), generation: 1, kind });
const obs = (action: Record<string, unknown>) => ({ id: 'action', label: '动作', ...action });
const msc = (command: number) => [0xf0, 0x7f, 0x7f, 0x02, 0x01, command, 0x31, 0xf7];
const consoleStatus: Ma2NetworkStatus = { state: 'connected', settings: { ...network, autoConnect: false }, passwordSaved: false, version: '3.7.0.5', error: null };

describe('授权失效时停止、关灯照常发出', () => {
  for (const [reason, status] of Object.entries(lapsed)) it(`${reason}：关灯、停止、暂停、静音、隐藏和松开按下的音都不检查授权`, async () => {
    const access = new LicenseAccess(() => Promise.resolve(status));
    for (const action of [off, { target: 'sequence', sequence: 36, action: 'off' } as const]) {
      await expect(access.authorize('link:ma2-play-cue', cue(action))).resolves.toBeUndefined();
    }
    for (const kind of ['stop', 'pause', 'stop-mtc']) await expect(access.authorize('link:native-player-control', control(kind))).resolves.toBeUndefined();
    for (const action of [{ kind: 'obs.mediaAction', inputName: '素材', action: 'stop' }, { kind: 'obs.mediaAction', inputName: '素材', action: 'pause' },
      { kind: 'obs.setInputMute', inputName: '音乐', muted: true }, { kind: 'obs.setSceneItemEnabled', sceneName: '场景', sourceName: '素材', enabled: false }]) {
      await expect(access.authorize('link:obs-execute', obs(action))).resolves.toBeUndefined();
    }
    for (const channel of ['link:native-obs-stop', 'link:native-obs-preload-cancel', 'link:ma2-play-cancel', 'link:ma2-audition-control', 'link:beauty-stop']) {
      await expect(access.authorize(channel, undefined)).resolves.toBeUndefined();
    }
    await expect(access.setActive(false)).resolves.toBeUndefined();
    expect(midiMessageNeedsLicense([0x80, 60, 0])).toBe(false);
    expect(midiMessageNeedsLicense(msc(0x02))).toBe(false);
  });

  it('开灯和开始输出仍要授权：Go、Goto、开始播放、准备下一首、开始素材、Note On、MSC Go', async () => {
    const access = new LicenseAccess(() => Promise.resolve(lapsed.到期!));
    for (const action of starts) await expect(access.authorize('link:ma2-play-cue', cue(action))).rejects.toThrow('有效授权');
    await expect(access.authorize('link:native-player-control', control('play'))).rejects.toThrow('有效授权');
    await expect(access.authorize('link:native-player-prepare', undefined)).rejects.toThrow('有效授权');
    await expect(access.authorize('link:obs-execute', obs({ kind: 'obs.mediaAction', inputName: '素材', action: 'start' }))).rejects.toThrow('有效授权');
    await expect(access.authorize('link:ma2-audition-play', undefined)).rejects.toThrow('有效授权');
    for (const bytes of [[0x90, 60, 100], [0x90, 60, 0], [0xb0, 7, 100], [0xc0, 1], msc(0x01)]) expect(midiMessageNeedsLicense(bytes)).toBe(true);
    // An invalid request is refused before any license decision, as every other checked channel.
    expect(() => needsProductLicense('link:ma2-play-cue', { action: off })).toThrow();
  });
});

/** The console as the program reaches it through link-main's wiring (program-license.ts), on a real LicenseAccess. */
function programConsole(license: () => LicenseStatus, changing = () => false) {
  const access = new LicenseAccess(() => Promise.resolve(license()));
  const send = vi.fn<(request: Ma2PlaybackRequest) => Promise<void>>(() => Promise.resolve());
  const wiring = programLicense({ access, changing }, { ready: Promise.resolve(), status: () => consoleStatus, send });
  return { access, send, wiring };
}

describe('后台节目的关灯和运行状态，按 link-main 的接法（program-license.ts）', () => {
  for (const [reason, status] of Object.entries(lapsed)) it(`${reason}：节目停止时的执行器 Off 照发，Go 和 Goto 被拦下`, async () => {
    const f = programConsole(() => status);
    await expect(f.wiring.network.playMa2Cue(cue(off))).resolves.toBeUndefined();
    for (const action of starts) await expect(f.wiring.network.playMa2Cue(cue(action))).rejects.toThrow('有效授权');
    expect(f.send.mock.calls.map(([request]) => request.action)).toEqual([off]);
    await expect(f.wiring.network.getMa2NetworkStatus()).resolves.toEqual(consoleStatus);
  });

  it('正在更换授权时，节目的 Off 照发，Go 和 Goto 被拦下', async () => {
    const f = programConsole(() => valid, () => true);
    await expect(f.wiring.network.playMa2Cue(cue(off))).resolves.toBeUndefined();
    for (const action of starts) await expect(f.wiring.network.playMa2Cue(cue(action))).rejects.toThrow('授权操作还没完成');
    expect(f.send).toHaveBeenCalledOnce();
  });

  it('节目的运行状态传到 LicenseAccess：节目在跑时界面空闲不打断演出，节目停下就放手', async () => {
    let status = valid;
    const f = programConsole(() => status);
    f.wiring.runningChanged(true); await f.access.setActive(true);
    status = lapsed.到期!; await f.access.setActive(false);
    await expect(f.access.requireOutput()).resolves.toBeUndefined();
    f.wiring.runningChanged(false);
    await expect(f.access.requireOutput()).rejects.toThrow('有效授权');
  });
});

function program() {
  const clock = { read: () => ({ positionMs: 0, durationMs: 1000, ready: true, playing: true, seeking: false }),
    subscribeBoundary: vi.fn<(listener: (boundary: PlaybackBoundary) => void) => () => void>(() => () => undefined) };
  return { close: vi.fn(() => Promise.resolve()), controller: { clock,
    play: vi.fn(() => Promise.resolve()), pause: vi.fn(() => Promise.resolve()), resume: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()), reset: vi.fn(() => Promise.resolve()), toggle: vi.fn(() => Promise.resolve()),
    seek: vi.fn(() => Promise.resolve()), scrub: vi.fn(() => Promise.resolve()), skip: vi.fn(() => Promise.resolve()),
    setVolume: vi.fn(), setEndAction: vi.fn(), setPlaylist: vi.fn(), toggleMtc: vi.fn(), receiveMidi: vi.fn(), fade: vi.fn(),
    preloadSelected: vi.fn(), freeze: vi.fn(), reportUnavailable: vi.fn(), runtimeUnavailable: vi.fn(), reportFault: vi.fn(), clearFault: vi.fn(), externalStop: vi.fn(),
    getAudioAnalysis: () => null, dispose: vi.fn(() => Promise.resolve()) } };
}
function windowOpen(): NativeProgramOpen {
  return { version: 1, ownerId: randomUUID(), projectPath: 'C:/test/show.tblink', revision: 1,
    document: JSON.stringify({ ...createEmptyLinkProject('授权规则'), playbackSource: 'internal' }),
    configuration: { outputDeviceId: 'default', mtcPortName: null, preciseSeeking: false } };
}
/** The main process as link-main wires it: the program reports whether it runs (program-license.ts), the window whether its run is active. */
function show() {
  let status: LicenseStatus = valid;
  const { access, wiring } = programConsole(() => status);
  const create = vi.fn<ConstructorParameters<typeof NativeProgramService>[0]>(program);
  const service = new NativeProgramService(create, () => undefined, () => access.requireOutput(), wiring.runningChanged);
  const song = (state: 'preparing' | 'playing' | 'paused' | 'stopped' | 'error') => create.mock.calls.at(-1)![2].changed({ ...emptyInternalPlayerState, itemId: 'song', status: state });
  return { access, service, song, lapse: (next: LicenseStatus) => { status = next; } };
}

describe('正在进行的演出跟后台节目走，不跟界面走', () => {
  for (const [reason, status] of Object.entries(lapsed)) it(`${reason}：同一场演出继续，界面重新加载、短暂空闲都不打断，下一首照常开`, async () => {
    const f = show(), first = windowOpen();
    await f.service.open(first); f.song('preparing'); await f.access.setActive(true); f.song('playing');
    f.lapse(status);
    // The window exits while the song plays; the reloaded window starts idle before it takes the program over.
    expect(await f.service.release()).toMatchObject({ status: 'playing' });
    await f.access.setActive(false);
    await expect(f.access.requireOutput()).resolves.toBeUndefined();
    await expect(f.access.authorize('link:native-player-prepare', undefined)).resolves.toBeUndefined();
    expect(await f.service.open({ ...first, ownerId: randomUUID() })).toBe('adopted');
    await expect(f.access.setActive(true)).resolves.toBeUndefined();
    // Played on to the next song, paused at its end, idle for a moment: still the same show.
    f.song('preparing'); f.song('playing'); f.song('paused'); await f.access.setActive(false);
    await expect(f.access.authorize('link:native-player-control', control('play'))).resolves.toBeUndefined();
  });

  it('授权失效时开新的一首仍被拦：演出停下、界面也空闲后，开播和准备都要重新检查授权', async () => {
    const f = show();
    await f.service.open(windowOpen()); f.song('preparing'); await f.access.setActive(true); f.song('playing');
    f.lapse(lapsed.到期!);
    f.song('stopped'); await f.access.setActive(false);
    await expect(f.access.requireOutput()).rejects.toThrow('有效授权');
    await expect(f.access.setActive(true)).rejects.toThrow('有效授权');
    await expect(f.access.authorize('link:native-player-prepare', undefined)).rejects.toThrow('有效授权');
    // The Off of the song that stopped still goes out.
    await expect(f.access.authorize('link:ma2-play-cue', cue(off))).resolves.toBeUndefined();
  });

  // Only what this guarantees: the program does not carry the old grant over to the next song, and the window's idle ends
  // the old run once it reaches main. A preparation of the next song that reaches main before that idle still passes on
  // the window's run, as it did with the session grant before 0.5.9; nothing here closes that race (docs/LICENSE_IMPLEMENTATION.md).
  it('停止后马上开下一首：节目不替新的一首沿用上一场的授权；界面迟到的空闲一到，上一场就结束', async () => {
    const f = show();
    await f.service.open(windowOpen()); f.song('preparing'); await f.access.setActive(true); f.song('playing');
    f.lapse(lapsed.到期!);
    f.song('stopped'); f.song('preparing');
    await f.access.setActive(false);
    await expect(f.access.requireOutput()).rejects.toThrow('有效授权');
    await expect(f.access.setActive(true)).rejects.toThrow('有效授权');
  });

  it('后台节目自己拿不到授权；界面退出时节目已停或被关闭，授权随之结束', async () => {
    const alone = new LicenseAccess(() => Promise.resolve(lapsed.到期!));
    alone.setProgramRunning(true);
    await expect(alone.requireOutput()).rejects.toThrow('有效授权');
    const f = show();
    await f.service.open(windowOpen()); f.song('preparing'); await f.access.setActive(true); f.song('playing');
    f.lapse(lapsed.到期!);
    // releaseRendererRuntime: the program closes first, then the window's run ends.
    await f.service.close(); await f.access.setActive(false);
    await expect(f.access.requireOutput()).rejects.toThrow('有效授权');
  });
});

/** The main-process program as link-main builds it, with fake audio and OBS: the real NativeProgramHost with its player and
 * lighting release, the program's license wiring (program-license.ts) and the report of failures after it closed. */
function programHost() {
  let license = valid;
  const { send, wiring } = programConsole(() => license);
  // What reaches the window: link-main passes sendToRenderer here, and LinkApp shows link:main-process-error in red.
  const toWindow = vi.fn<(channel: 'link:main-process-error', message: string) => void>();
  const record = vi.fn<(entry: LinkLogInput) => Promise<unknown>>(() => Promise.resolve());
  const report = closedProgramFaultReporter(record, toWindow);
  const project = parseLinkProject({ ...createEmptyLinkProject('授权规则'), playbackSource: 'internal',
    rundown: [{ id: 'song', title: '开场', referenceAudio: { assetId: 'audio', relativePath: 'song.wav', sha256: 'a'.repeat(64), durationMs: 10000 },
      playback: { startMs: 0, endMs: 9000, mtcOffsetMs: 480000, volume: 100, endAction: 'pause', shortcut: '' } }] });
  project.rundown[0]!.lighting = { ...createLightingDocument(), consoleSong: { endpoint: 'console', show: '现场', layout: null, executor: '1.101', sequence: 36,
    name: '开场', baselineXml: '<MA/>', points: [] } };
  let audio: NativePlayerStatus | null = null;
  const prepareAudio = (request: NativePlayerPrepare): Promise<NativePlayerStatus> => {
    const s = request.snapshot;
    audio = { version: 1, sessionId: request.sessionId, generation: request.generation, itemId: s.itemId, status: 'ready', positionMs: s.positionMs,
      offsetMs: s.offsetMs, sampleRate: s.sampleRate, enginePid: 1, engineTitle: 'TBLINK Audio 1', mtcPortName: null, mtcSent: 0, audioError: null,
      mtcError: null, underruns: 0, mtcInterruptions: 0, gain: s.volume, analysis: null };
    return Promise.resolve(audio);
  };
  const controlAudio = (command: NativePlayerControl): Promise<NativePlayerStatus> => {
    if (!audio) return Promise.reject(new Error('没有准备音频'));
    const next: NativePlayerStatus = { ...audio, generation: command.generation };
    if (command.kind === 'play') next.status = 'playing';
    else if (command.kind === 'pause') next.status = 'paused';
    else if (command.kind === 'stop') next.status = 'stopped';
    audio = next; return Promise.resolve(next);
  };
  const host = new NativeProgramHost(project, 'C:/test/show.tblink', 1, {
    executable: 'tblink-playback.exe', audio: () => audio, midiOutputs: () => Promise.resolve([]), authorize: () => Promise.resolve(),
    configuration: () => ({ outputDeviceId: 'default', mtcPortName: null, audioSampleRate: 48000, preload: false }), preciseSeeking: () => false,
    changed: () => undefined, midiChanged: () => undefined, midiRecovered: () => undefined, notice: () => undefined,
    closedFault: (message, itemId) => report(message, { projectId: project.projectId, itemId }),
    network: wiring.network,
    api: { prepareNativePlayback: prepareAudio, controlNativePlayback: controlAudio,
      getNativePlaybackDevices: () => Promise.resolve({ protocol: 4, audio: [], midiOutputs: [], midiInputs: [] }),
      prepareNativeObs: (request: NativeObsPrepare) => Promise.resolve({ version: 1, sessionId: request.sessionId, generation: request.generation,
        itemId: request.snapshot.item.id, revision: request.snapshot.revision, state: 'ready', reason: null, currentCueId: null, nextCueId: null, pendingCount: 0, positionMs: 0 }),
      stopNativeObs: () => Promise.resolve(), onNativeObsStatus: () => () => undefined,
      preloadNativeObs: () => Promise.resolve(), cancelNativeObsPreload: () => Promise.resolve() }
  });
  return { host, send, toWindow, record, lapse: (next: LicenseStatus) => { license = next; } };
}

describe('停止后马上关闭后台节目（改了片段、重建播放器），这首歌的执行器照样关', () => {
  for (const [reason, status] of Object.entries(lapsed)) it(`${reason}：节目宿主照发这首歌的执行器 Off，不检查授权`, async () => {
    const f = programHost();
    await f.host.controller.play('song');
    f.lapse(status);
    await Promise.all([f.host.controller.stop(), f.host.close()]);
    expect(f.send.mock.calls.map(([request]) => request.action)).toEqual([off]);
    expect(f.toWindow).not.toHaveBeenCalled();
  });

  it('Off 没发出去：窗口里标红、按错误记录，不重发，关闭节目照常完成', async () => {
    const f = programHost();
    await f.host.controller.play('song');
    f.send.mockRejectedValueOnce(new Error('MA2 没有回应'));
    await Promise.all([f.host.controller.stop(), f.host.close()]);
    const message = '「开场」的灯光没能完全关闭，控台上可能还亮着，请在控台上关掉这首歌的执行器。原因：MA2 没有回应';
    expect(f.toWindow).toHaveBeenCalledExactlyOnceWith('link:main-process-error', message);
    expect(f.record).toHaveBeenCalledWith(expect.objectContaining({ level: 'error', message, itemId: 'song', result: 'failed' }));
    expect(f.send).toHaveBeenCalledOnce();
  });
});
