import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject, type LicenseStatus, type Ma2NetworkStatus, type Ma2PlaybackAction,
  type Ma2PlaybackRequest, type NativeObsPrepare, type NativePlayerControl, type NativePlayerPrepare, type NativePlayerStatus, type NativeProgramOpen } from '@tb/schema';
import { clockFromNativeStatus, emptyInternalPlayerState, midiMessageNeedsLicense, type PlaybackBoundary } from '@tb/core/link';
import { LicenseAccess, needsProductLicense } from './license-access';
import { NativeProgramService } from './native-program-service';
import { NativeProgramHost } from './native-program-host';
import { LightingOffService } from './lighting-off-service';
import { programLicense } from './program-license';
import { closedProgramFaultReporter } from './main-process-errors';
import { followWindowPage } from './window-page';
import { windowPageEvents } from './fixtures/window-page-events';
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

  it('主进程的 P1 跟随也拿着授权（0.5.9 P3f）：跟随和节目哪个还在跑都不放手，两个都停了才放手', async () => {
    let status = valid;
    const f = programConsole(() => status);
    f.wiring.followRunningChanged(true); await f.access.setActive(true);
    status = lapsed.到期!; await f.access.setActive(false);
    await expect(f.access.requireOutput()).resolves.toBeUndefined();
    f.wiring.runningChanged(true); f.wiring.runningChanged(false);
    await expect(f.access.requireOutput()).resolves.toBeUndefined();
    f.wiring.runningChanged(true); f.wiring.followRunningChanged(false);
    await expect(f.access.requireOutput()).resolves.toBeUndefined();
    f.wiring.runningChanged(false);
    await expect(f.access.requireOutput()).rejects.toThrow('有效授权');
  });
});

function program() {
  const clock = { read: () => ({ positionMs: 0, durationMs: 1000, ready: true, playing: true, seeking: false }),
    subscribeBoundary: vi.fn<(listener: (boundary: PlaybackBoundary) => void) => () => void>(() => () => undefined) };
  return { close: vi.fn(() => Promise.resolve()), controller: { clock, sessionId: 'session',
    play: vi.fn(() => Promise.resolve()), pause: vi.fn(() => Promise.resolve()), resume: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()), reset: vi.fn(() => Promise.resolve()), toggle: vi.fn(() => Promise.resolve()),
    seek: vi.fn(() => Promise.resolve()), scrub: vi.fn(() => Promise.resolve()), skip: vi.fn(() => Promise.resolve()),
    previewVolume: vi.fn(), overrideVolume: vi.fn(), setEndAction: vi.fn(), setPlaylist: vi.fn(), toggleMtc: vi.fn(), receiveMidi: vi.fn(), fade: vi.fn(),
    preloadSelected: vi.fn(), obsReconnected: vi.fn(), freeze: vi.fn(), reportUnavailable: vi.fn(), runtimeUnavailable: vi.fn(), reportFault: vi.fn(), clearFault: vi.fn(), externalStop: vi.fn(),
    setWatched: vi.fn(), updateProject: vi.fn(), currentProject: vi.fn(), actionsProject: vi.fn(), getAudioAnalysis: () => null, dispose: vi.fn(() => Promise.resolve()) } };
}
function windowOpen(): NativeProgramOpen {
  return { version: 1, ownerId: randomUUID(), projectPath: 'C:/test/show.tblink', revision: 1, sessionId: randomUUID(),
    document: JSON.stringify({ ...createEmptyLinkProject('授权规则'), playbackSource: 'internal' }),
    configuration: { outputDeviceId: 'default', mtcPortName: null, preciseSeeking: false } };
}
/** The main process as link-main wires it: the program reports whether it runs (program-license.ts), the window whether its run is active. */
function show() {
  let status: LicenseStatus = valid;
  const { access, wiring } = programConsole(() => status);
  const create = vi.fn<ConstructorParameters<typeof NativeProgramService>[0]>(program);
  const service = new NativeProgramService(create, () => undefined, () => access.requireOutput(), wiring.runningChanged,
    closedProgramFaultReporter(() => Promise.resolve(), () => undefined));
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

/** The main-process program as link-main builds it, with fake audio and OBS: NativeProgramService creating the real
 * NativeProgramHost with its player and lighting release, the program's license wiring (program-license.ts) and the report of
 * failures no player shows (closedProgramFaultReporter). The window has opened the program. 「串场」 has no lighting. */
async function programHost(endAction: 'pause' | 'stop' = 'pause') {
  let license = valid;
  const { access, send, wiring } = programConsole(() => license);
  // What reaches the window: link-main passes sendToRenderer here, and LinkApp shows link:main-process-error in red as it is.
  const toWindow = vi.fn<(channel: 'link:main-process-error', message: string) => void>();
  const record = vi.fn<(entry: LinkLogInput) => Promise<unknown>>(() => Promise.resolve());
  // link-main's notice: the run log only (a warning the first time, then info), under the song it names.
  const notices: { message: string; itemId: string | null }[] = [];
  const referenceAudio = { assetId: 'audio', relativePath: 'song.wav', sha256: 'a'.repeat(64), durationMs: 10000 };
  const playback = { startMs: 0, endMs: 9000, mtcOffsetMs: 480000, volume: 100, endAction, shortcut: '' };
  const project = parseLinkProject({ ...createEmptyLinkProject('授权规则'), schemaVersion: 2, playbackSource: 'internal',
    rundown: [{ id: 'song', title: '开场', referenceAudio, playback }, { id: 'interlude', title: '串场', referenceAudio, playback }] });
  project.rundown[0]!.lighting = { ...createLightingDocument(), consoleSong: { endpoint: 'console', show: '现场', layout: null, executor: '1.101', sequence: 36,
    name: '开场', baselineXml: '<MA/>', points: [] } };
  let audio: NativePlayerStatus | null = null, held: Promise<void> | null = null;
  const prepareAudio = async (request: NativePlayerPrepare): Promise<NativePlayerStatus> => {
    if (held) await held;
    const s = request.snapshot;
    audio = { version: 1, sessionId: request.sessionId, generation: request.generation, itemId: s.itemId, status: 'ready', positionMs: s.positionMs,
      offsetMs: s.offsetMs, sampleRate: s.sampleRate, enginePid: 1, engineTitle: 'TBLINK Audio 1', mtcPortName: null, mtcSent: 0, audioError: null,
      mtcError: null, underruns: 0, mtcInterruptions: 0, gain: s.volume, analysis: null };
    return audio;
  };
  /** What the program told the playback engine, in order: a 'stop' stops the music and the timecode. */
  const controls: NativePlayerControl['kind'][] = [];
  const controlAudio = (command: NativePlayerControl): Promise<NativePlayerStatus> => {
    controls.push(command.kind);
    if (!audio) return Promise.reject(new Error('没有准备音频'));
    const next: NativePlayerStatus = { ...audio, generation: command.generation };
    if (command.kind === 'play') next.status = 'playing';
    else if (command.kind === 'pause') next.status = 'paused';
    else if (command.kind === 'stop') next.status = 'stopped';
    audio = next; return Promise.resolve(next);
  };
  const hosts: NativeProgramHost[] = [];
  // link-main's one lights-off ledger, on the program's console wiring (program-license.ts).
  const lightsOff = new LightingOffService({ console: wiring.network, resending: () => undefined, failed: () => undefined });
  const service = new NativeProgramService((opened, request, callbacks) => {
    const host = new NativeProgramHost(opened, request.projectPath, request.revision, {
      executable: 'tblink-playback.exe', audio: () => audio, midiOutputs: () => Promise.resolve([]), authorize: () => Promise.resolve(),
      configuration: () => ({ outputDeviceId: 'default', mtcPortName: null, audioSampleRate: 48000, preload: false }), preciseSeeking: () => false,
      changed: state => callbacks.changed(state), midiChanged: () => undefined, midiRecovered: () => undefined,
      notice: (message, itemId) => { notices.push({ message, itemId }); }, closedFault: (message, itemId) => callbacks.closedFault(message, itemId),
      lighting: lightsOff,
      api: { prepareNativePlayback: prepareAudio, controlNativePlayback: controlAudio,
        getNativePlaybackDevices: () => Promise.resolve({ protocol: 4, audio: [], midiOutputs: [], midiInputs: [] }),
        prepareNativeObs: (request: NativeObsPrepare) => Promise.resolve({ version: 1, sessionId: request.sessionId, generation: request.generation,
          itemId: request.snapshot.item.id, revision: request.snapshot.revision, state: 'ready', reason: null, currentCueId: null, nextCueId: null, pendingCount: 0, positionMs: 0 }),
        stopNativeObs: () => Promise.resolve(), onNativeObsStatus: () => () => undefined,
        preloadNativeObs: () => Promise.resolve(), prepareNextNativePlayback: () => Promise.resolve(), prepareNextNativeObs: () => Promise.resolve(), cancelNativeObsPreload: () => Promise.resolve() }
    });
    hosts.push(host);
    return { controller: host.controller, close: () => host.close() };
  }, () => undefined, () => access.requireOutput(), wiring.runningChanged, closedProgramFaultReporter(record, toWindow));
  /** What a window sends when it opens this project's program. */
  const opening = (): NativeProgramOpen => ({ version: 1, ownerId: randomUUID(), projectPath: 'C:/test/show.tblink', revision: 1, sessionId: randomUUID(),
    document: JSON.stringify(project), configuration: { outputDeviceId: 'default', mtcPortName: null, preciseSeeking: false } });
  const first = opening();
  await service.open(first);
  return { service, access, send, toWindow, record, notices, controls, projectId: project.projectId, project, first, opening, audio: () => audio,
    player: () => hosts.at(-1)!.controller,
    play: (itemId: string) => service.control({ version: 1, ownerId: first.ownerId, operation: { kind: 'play', itemId } }),
    /** The playback engine reports the end of the song. */
    ended: () => { const status: NativePlayerStatus = { ...audio!, status: 'ended', positionMs: 9000 }; hosts.at(-1)!.observe(status, clockFromNativeStatus(status, null)); },
    /** Audio preparation waits until the returned function is called. */
    hold: () => { let release!: () => void; held = new Promise<void>(resolve => { release = resolve; }); return () => { held = null; release(); }; },
    lapse: (next: LicenseStatus) => { license = next; } };
}
/** The red text in the window, as the operator reads it: what happened, why, what to do. */
const lightsLeftOn = (title: string) => `「${title}」的灯光没能完全关闭，控台上可能还亮着。原因：MA2 没有回应。请在控台上关掉这首歌的执行器。`;

describe('停止后马上关闭后台节目（改了片段、重建播放器），这首歌的执行器照样关', () => {
  for (const [reason, status] of Object.entries(lapsed)) it(`${reason}：节目宿主照发这首歌的执行器 Off，不检查授权`, async () => {
    const f = await programHost();
    await f.play('song');
    f.lapse(status);
    await Promise.all([f.player().stop(), f.service.close()]);
    expect(f.send.mock.calls.map(([request]) => request.action)).toEqual([off]);
    expect(f.toWindow).not.toHaveBeenCalled();
  });

  it('Off 没发出去：窗口里标红、按错误记录，不重发，关闭节目照常完成', async () => {
    const f = await programHost();
    await f.play('song');
    f.send.mockRejectedValueOnce(new Error('MA2 没有回应'));
    await Promise.all([f.player().stop(), f.service.close()]);
    expect(f.toWindow).toHaveBeenCalledExactlyOnceWith('link:main-process-error', lightsLeftOn('开场'));
    expect(f.record).toHaveBeenCalledExactlyOnceWith({ level: 'error', category: 'state', device: '播放器', projectId: f.projectId, itemId: 'song',
      message: lightsLeftOn('开场'), result: 'failed' });
    expect(f.send).toHaveBeenCalledOnce();
  });

  // 修复前：红字里的歌名取自关闭那一刻在放的「串场」，操作员会去找一首根本没有执行器的歌。
  // 第 4 题（R13）：上一首的 Off 在换到「串场」时就发（不带灯光的「串场」用不上它的执行器），不再等到关闭节目。
  it('换歌关的是上一首的灯：定位时按停止被跳过，接着放不带灯光的「串场」时就发「开场」的 Off，不检查授权；之后关闭节目不再补发', async () => {
    const f = await programHost();
    await f.play('song');
    const release = f.hold();
    const seeking = f.player().seek(2000), stopping = f.player().stop(), next = f.player().play('interlude');
    f.lapse(lapsed.到期!);
    release(); await Promise.all([seeking, stopping, next]);
    await vi.waitFor(() => expect(f.send.mock.calls.map(([request]) => request.action)).toEqual([off]));
    await f.service.close();
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.toWindow).not.toHaveBeenCalled();
  });
});

// 修复前：窗口开着时，播放器里只写“灯光没能完全关闭：原因”，日志记在正在放的「串场」上；操作员会去找一首没有执行器的歌。
describe('窗口开着时停止的关灯没发出去，播放器里的提示和日志写这份 Off 所属的歌', () => {
  // 第 4 题（R13）：「开场」的 Off 在换到「串场」时发；没发出去的留在清单里，再按一次停止时重发。
  it('换歌时上一首「开场」的 Off 没发出去：提示写「开场」和怎么办，日志记在「开场」上，不另外标红；再按停止重发一次', async () => {
    const f = await programHost();
    await f.play('song');
    const release = f.hold();
    f.send.mockRejectedValueOnce(new Error('MA2 没有回应'));
    const seeking = f.player().seek(2000), stopping = f.player().stop(), next = f.player().play('interlude');
    release(); await Promise.all([seeking, stopping, next]);
    await vi.waitFor(() => expect(f.notices.filter(({ message }) => message.includes('灯光'))).toEqual([{ message: lightsLeftOn('开场'), itemId: 'song' }]));
    await f.player().stop();
    expect(f.send.mock.calls.map(([request]) => request.action)).toEqual([off, off]);
    expect(f.notices.filter(({ message }) => message.includes('灯光'))).toEqual([{ message: lightsLeftOn('开场'), itemId: 'song' }]);
    expect(f.toWindow).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
  });
});

describe('界面进程退出后节目在后台自己停下，这首歌的执行器照样关；没关掉要让操作员看到', () => {
  for (const [reason, status] of Object.entries(lapsed)) it(`${reason}：界面退出后歌在后台放完停止，执行器 Off 照发，不检查授权`, async () => {
    const f = await programHost('stop');
    await f.play('song');
    expect(await f.service.release()).toMatchObject({ status: 'playing' });
    f.lapse(status);
    f.ended();
    await vi.waitFor(() => expect(f.send.mock.calls.map(([request]) => request.action)).toEqual([off]));
    expect(f.record).not.toHaveBeenCalled();
  });

  // 修复前：节目没被关闭，失败只进了没有窗口在看的播放器状态，日志里是提示级；重新加载的界面打开工程时，这个已停下的节目
  // 被替换掉，红字谁也看不到，控台停在最后一个 Cue。
  it('Off 没发出去：马上按错误记录一次；红字等重新加载的界面打开节目时显示，只显示一次', async () => {
    const f = await programHost('stop');
    await f.play('song');
    expect(await f.service.release()).toMatchObject({ status: 'playing' });
    f.send.mockRejectedValueOnce(new Error('MA2 没有回应'));
    f.ended();
    await vi.waitFor(() => expect(f.record).toHaveBeenCalledOnce());
    expect(f.record).toHaveBeenCalledWith({ level: 'error', category: 'state', device: '播放器', projectId: f.projectId, itemId: 'song',
      message: lightsLeftOn('开场'), result: 'failed' });
    expect(f.notices.filter(({ message }) => message.includes('灯光'))).toEqual([]);
    expect(f.toWindow).not.toHaveBeenCalled();
    // The song stopped while no window was there: the reloaded window replaces the program instead of taking it over.
    expect(await f.service.open(f.opening())).toBe('opened');
    expect(f.toWindow).toHaveBeenCalledExactlyOnceWith('link:main-process-error', lightsLeftOn('开场'));
    await f.service.open(f.opening());
    expect(f.toWindow).toHaveBeenCalledOnce(); expect(f.record).toHaveBeenCalledOnce(); expect(f.send).toHaveBeenCalledOnce();
  });
});

/** The main window's page as link-main follows it (window-page.ts), over this program. */
function reloadingPage(f: Awaited<ReturnType<typeof programHost>>) {
  const page = windowPageEvents();
  followWindowPage(page.page, { releaseMidi: () => Promise.resolve(), failSaves: () => undefined, releaseProgram: () => f.service.release(), record: f.record });
  return page;
}

// 修复前：主进程拦下了页面自己的 location.reload()，错误画面上的“重新进入工作区”按了没反应；只放行重新加载的话，节目没被
// 放开，新页面打开同一个工程时把正在放的节目换掉，音乐和时间码停下。
describe('界面自己重新加载（错误画面上的“重新进入工作区”），演出不中断', () => {
  for (const [reason, status] of Object.entries(lapsed)) it(`${reason}：歌在后台接着放，新页面打开同一个工程接回控制，不停歌、不检查授权`, async () => {
    const f = await programHost();
    const page = reloadingPage(f);
    // The window's run of this show was checked while the license was valid.
    await f.play('song'); await f.access.setActive(true);
    f.lapse(status);
    expect(page.reloadItself()).toBe(true);
    await vi.waitFor(() => expect(f.record).toHaveBeenCalledOnce());
    expect(f.record).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning', itemId: 'song' }));
    // The new page starts idle, then the operator opens the same project.
    await f.access.setActive(false);
    expect(await f.service.open(f.opening())).toBe('adopted');
    expect(f.controls).not.toContain('stop');
    expect(f.audio()?.status).toBe('playing');
    await expect(f.access.requireOutput()).resolves.toBeUndefined();
    expect(f.send).not.toHaveBeenCalled();
  });

  // 修复前：节目一直当作有窗口在看，后台停下时关灯失败只进了已经不在的那一页的播放器状态，谁也看不到。
  it('新页面接回之前歌在后台放完停下、Off 没发出去：马上按错误记录一次；红字等新页面打开节目时显示，只显示一次', async () => {
    const f = await programHost('stop');
    const page = reloadingPage(f);
    await f.play('song');
    expect(page.reloadItself()).toBe(true);
    await vi.waitFor(() => expect(f.record).toHaveBeenCalledOnce());
    f.send.mockRejectedValueOnce(new Error('MA2 没有回应'));
    f.ended();
    await vi.waitFor(() => expect(f.record).toHaveBeenCalledTimes(2));
    expect(f.record).toHaveBeenLastCalledWith({ level: 'error', category: 'state', device: '播放器', projectId: f.projectId, itemId: 'song',
      message: lightsLeftOn('开场'), result: 'failed' });
    expect(f.toWindow).not.toHaveBeenCalled();
    expect(await f.service.open(f.opening())).toBe('opened');
    expect(f.toWindow).toHaveBeenCalledExactlyOnceWith('link:main-process-error', lightsLeftOn('开场'));
    expect(f.send).toHaveBeenCalledOnce();
  });
});

// 0.5.9 S7（design 02 §3.3）：修改送进节目的只是新的一版工程，只改节目手里的工程，不是一次输出。
describe('修改送进后台节目不过授权，也不发出任何输出', () => {
  type Host = Awaited<ReturnType<typeof programHost>>;
  const version = (f: Host, revision: number, title: string) => ({ version: 1, ownerId: f.first.ownerId,
    key: { sessionId: f.first.sessionId, projectId: f.projectId, projectPath: f.first.projectPath }, revision, base: null,
    change: { kind: 'full', document: JSON.stringify({ ...f.project, rundown: f.project.rundown.map(item => item.id === 'song' ? { ...item, title } : item) }) } });

  for (const [reason, status] of Object.entries(lapsed)) it(`${reason}：停着时送来的新一版照样换上，不检查授权，不准备音频、不发灯光`, async () => {
    const f = await programHost();
    f.lapse(status);
    expect(await f.service.document(version(f, 2, '改名的开场'), () => Promise.resolve())).toEqual({ kind: 'applied', revision: 2, effect: 'stopped' });
    expect(f.player().currentProject().rundown[0]!.title).toBe('改名的开场');
    expect(f.audio()).toBeNull(); expect(f.controls).toEqual([]); expect(f.send).not.toHaveBeenCalled();
  });

  it('拿着歌时送来的新一版：当即收下（live），不出输出、不重新准备，这首歌照旧按开始的那一版；停下以后下一首用它', async () => {
    const f = await programHost();
    await f.play('song');
    const audio = f.audio(), controls = [...f.controls], sent = f.send.mock.calls.length;
    f.lapse(lapsed.到期!);
    expect(await f.service.document(version(f, 2, '改名的开场'), () => Promise.resolve())).toEqual({ kind: 'applied', revision: 2, effect: 'live' });
    expect(f.audio()).toBe(audio); expect(f.controls).toEqual(controls); expect(f.send).toHaveBeenCalledTimes(sent);
    expect(f.player().currentProject().rundown[0]!.title).toBe('开场');
    await f.player().stop();
    expect(f.player().currentProject().rundown[0]!.title).toBe('改名的开场');
  });
});
