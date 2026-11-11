import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createEmptyLinkProject, type NativeProgramOpen, type NativeProgramOperation, type NativeProgramEvent } from '@tb/schema';
import { emptyInternalPlayerState, toUserErrorMessage, type InternalPlayerState, type PlaybackBoundary } from '@tb/core/link';
import { NativeProgramService } from './native-program-service';
import { closedProgramFaultReporter } from './main-process-errors';
import type { LinkLogInput } from './run-logger';
import { followWindowPage } from './window-page';
import { windowPageEvents } from './fixtures/window-page-events';
import { releaseGonePage } from './engine-shutdown';

function deferred() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function request(): NativeProgramOpen { return { version: 1, ownerId: randomUUID(), projectPath: 'C:/test/show.tblink', revision: 1,
  document: JSON.stringify({ ...createEmptyLinkProject('后台宿主测试'), playbackSource: 'internal' }),
  configuration: { outputDeviceId: 'default', mtcPortName: null, preciseSeeking: false } }; }
function host() {
  const clock = { read: () => ({ positionMs: 0, durationMs: 1000, ready: true, playing: false, seeking: false }),
    subscribeBoundary: vi.fn<(listener: (boundary: PlaybackBoundary) => void) => () => void>(() => () => undefined) };
  return { close: vi.fn(() => Promise.resolve()), controller: { clock,
    play: vi.fn(() => Promise.resolve()), pause: vi.fn(() => Promise.resolve()), resume: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()), reset: vi.fn(() => Promise.resolve()), toggle: vi.fn(() => Promise.resolve()),
    seek: vi.fn(() => Promise.resolve()), scrub: vi.fn(() => Promise.resolve()), skip: vi.fn(() => Promise.resolve()),
    setSongVolume: vi.fn(), previewVolume: vi.fn(), overrideVolume: vi.fn(), setEndAction: vi.fn(), setPlaylist: vi.fn(), toggleMtc: vi.fn(), receiveMidi: vi.fn(), fade: vi.fn(),
    preloadSelected: vi.fn(), freeze: vi.fn(), reportUnavailable: vi.fn(), runtimeUnavailable: vi.fn(), reportFault: vi.fn(), clearFault: vi.fn(), externalStop: vi.fn(),
    setWatched: vi.fn(), getAudioAnalysis: () => null, dispose: vi.fn(() => Promise.resolve()) } };
}
function command(input: NativeProgramOpen, operation: NativeProgramOperation) { return { version: 1, ownerId: input.ownerId, operation }; }
/** The program's running state goes nowhere in these tests; license-rules.test.ts follows it to LicenseAccess. */
const unlicensed = (): void => undefined;
/** Failures after close, as link-main reports them: logged, then shown in a window. */
function faults() {
  const record = vi.fn<(entry: LinkLogInput) => Promise<unknown>>(() => Promise.resolve());
  const toWindow = vi.fn<(channel: 'link:main-process-error', message: string) => void>();
  return { record, toWindow, reporter: closedProgramFaultReporter(record, toWindow) };
}
const quiet = () => faults().reporter;
const midiLeftOpen = '关闭节目时动作 MIDI 没有正常关掉，之后的歌照常播放。原因：MIDI 驱动服务异常退出：3。如果之后的歌没有发出动作 MIDI，请检查 MIDI 接口和线。';
/** What a control request from a window whose program is gone is refused with: what happened, and what to do. */
const goneProgram = '这个窗口的节目已经关了，这次操作没有执行。请重新打开工程，再开始播放';

it('关闭等待授权的会话立即完成；迟到授权不创建播放器', async () => {
  const gate = deferred(), create = vi.fn(host), service = new NativeProgramService(create, vi.fn(), () => gate.promise, unlicensed, quiet()), input = request();
  const opening = service.open(input);
  await service.control(command(input, { kind: 'close' })); await opening;
  expect(create).not.toHaveBeenCalled(); gate.release(); await Promise.resolve(); expect(create).not.toHaveBeenCalled();
});

it('替换等待旧输出关闭；旧界面的迟到关闭不停止新输出', async () => {
  const old = host(), next = host(), gate = deferred(), create = vi.fn().mockReturnValueOnce(old).mockReturnValueOnce(next);
  const service = new NativeProgramService(create, vi.fn(), () => Promise.resolve(), unlicensed, quiet()), a = request(), b = request();
  await service.open(a); old.close.mockReturnValue(gate.promise);
  const replacing = service.open(b); await Promise.resolve(); expect(create).toHaveBeenCalledTimes(1);
  await service.control(command(a, { kind: 'close' })); expect(next.close).not.toHaveBeenCalled();
  gate.release(); await replacing; expect(create).toHaveBeenCalledTimes(2);
  await expect(service.control(command(a, { kind: 'play', itemId: 'old' }))).rejects.toThrow(goneProgram);
  await service.control(command(b, { kind: 'play', itemId: 'next' })); expect(next.controller.play).toHaveBeenCalledWith('next', undefined, undefined);
});

it('停止不排在未完成的播放准备之后', async () => {
  const output = host(), gate = deferred(); output.controller.play.mockReturnValue(gate.promise);
  const service = new NativeProgramService(() => output, vi.fn(), () => Promise.resolve(), unlicensed, quiet()), input = request();
  await service.open(input); const playing = service.control(command(input, { kind: 'play', itemId: 'song' }));
  await service.control(command(input, { kind: 'stop' })); expect(output.controller.stop).toHaveBeenCalledOnce(); gate.release(); await playing;
});

// 0.5.9 S6：原来是一条“关闭失败阻止新宿主”。关闭失败一次以后，关闭链一直是失败状态，之后的打开都失败、之后的宿主也不再被关。
// 现在拆成两条：引擎还在响时打开得到等待文案；引擎已经停了时照常打开，之后的宿主照样被关。
it('上一个节目关闭失败、引擎还在响：打开得到“上一首还没停下”，不建新宿主；按停止再读一次引擎，停了才打开；授权失败未创建输出时允许重新打开', async () => {
  const first = host(), sounding = { now: true }, held = { ...first, engineStopped: vi.fn(() => !sounding.now) }, later: ReturnType<typeof host>[] = [];
  const create = vi.fn<ConstructorParameters<typeof NativeProgramService>[0]>().mockReturnValueOnce(held)
    .mockImplementation(() => { const made = host(); later.push(made); return made; });
  const authorize = vi.fn(() => Promise.resolve()), reporter = faults();
  const service = new NativeProgramService(create, vi.fn(), authorize, unlicensed, reporter.reporter);
  authorize.mockRejectedValueOnce(new Error('授权失败'));
  await expect(service.open(request())).rejects.toThrow('授权失败'); expect(create).not.toHaveBeenCalled();
  await service.open(request()); expect(create).toHaveBeenCalledOnce(); first.close.mockRejectedValue(new Error('设备拒绝关闭'));
  const next = request();
  const refused = await service.open(next).then(() => '打开了', (error: unknown) => error);
  expect(toUserErrorMessage(refused)).toBe('上一首还没停下：设备拒绝关闭。再按一次停止');
  expect(create).toHaveBeenCalledOnce();
  // The close nobody waited for is logged and shown once.
  expect(reporter.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ level: 'error', device: '播放器', message: '上一个节目没能正常关掉：设备拒绝关闭' }));
  // Stop pressed while it still sounds: read again, the same answer; nothing opens beside it.
  await expect(service.control(command(next, { kind: 'stop' }))).rejects.toThrow('上一首还没停下：设备拒绝关闭。再按一次停止');
  expect(create).toHaveBeenCalledOnce(); expect(held.engineStopped).toHaveBeenCalledTimes(2);
  // Stopped now: the next stop opens this window's program, and it plays.
  sounding.now = false;
  await service.control(command(next, { kind: 'stop' }));
  expect(create).toHaveBeenCalledTimes(2);
  await service.control(command(next, { kind: 'play', itemId: 'song' }));
  expect(later[0]!.controller.play).toHaveBeenCalledOnce();
});

it('上一个节目关闭失败、引擎已经停了：照常打开；这次失败以后，后面的节目照样被关，关闭的人看到失败', async () => {
  const first = host(), stopped = { ...first, engineStopped: vi.fn(() => true) }, later: ReturnType<typeof host>[] = [];
  const create = vi.fn<ConstructorParameters<typeof NativeProgramService>[0]>().mockReturnValueOnce(stopped)
    .mockImplementation(() => { const made = host(); later.push(made); return made; });
  const service = new NativeProgramService(create, vi.fn(), () => Promise.resolve(), unlicensed, quiet());
  await service.open(request()); first.close.mockRejectedValue(new Error('设备拒绝关闭'));
  const next = request();
  expect(await service.open(next)).toBe('opened'); expect(create).toHaveBeenCalledTimes(2);
  await service.control(command(next, { kind: 'close' }));
  expect(later[0]!.close).toHaveBeenCalledOnce();
  // A close that fails is returned to whoever closed: in red there, and the chain stays open for the next program.
  await service.open(request());
  later[1]!.close.mockRejectedValueOnce(new Error('音频引擎没有确认停止'));
  await expect(service.close()).rejects.toThrow('音频引擎没有确认停止');
  // That host cannot tell whether its engine stopped: taken as still sounding, the next open waits.
  await expect(service.open(request())).rejects.toThrow('上一首还没停下：音频引擎没有确认停止。再按一次停止');
});

it('只发布当前会话的有序状态和边界；无效 DTO 不进入控制器', async () => {
  const events: NativeProgramEvent[] = [], output = host();
  const create = vi.fn<ConstructorParameters<typeof NativeProgramService>[0]>(() => output);
  const service = new NativeProgramService(create, event => events.push(event), () => Promise.resolve(), unlicensed, quiet()), a = request(), b = request();
  await service.open(a); const oldCallbacks = create.mock.calls[0]![2];
  oldCallbacks.changed({ ...emptyInternalPlayerState, itemId: 'song', status: 'playing' });
  output.controller.clock.subscribeBoundary.mock.calls[0]![0]('seek');
  expect(events.map(event => event.sequence)).toEqual([1, 2, 3]); expect(events[2]?.boundary).toBe('seek');
  await service.open(b); const length = events.length; oldCallbacks.changed(emptyInternalPlayerState); expect(events).toHaveLength(length);
  await expect(service.control({ ...command(b, { kind: 'seek', positionMs: 100 }), extra: true })).rejects.toThrow();
  expect(output.controller.seek).not.toHaveBeenCalled();
});

// 评审变异 Ml：保留的节目也跑 teardown（关音频引擎、画面和 runtime），后台照常播的歌就停了。
it('界面进程退出时播放中的节目不停，音频引擎、画面和 runtime 也不关；重新加载的同工程界面接管同一输出', async () => {
  const output = host(), events: NativeProgramEvent[] = [], teardown = vi.fn(() => Promise.resolve());
  const create = vi.fn<ConstructorParameters<typeof NativeProgramService>[0]>(() => output);
  const service = new NativeProgramService(create, event => events.push(event), () => Promise.resolve(), unlicensed, quiet()), a = request();
  expect(await service.open(a)).toBe('opened'); const callbacks = create.mock.calls[0]![2];
  callbacks.changed({ ...emptyInternalPlayerState, itemId: 'song', status: 'playing', positionMs: 5000 });
  expect(await service.release(teardown)).toMatchObject({ itemId: 'song', status: 'playing' }); expect(output.close).not.toHaveBeenCalled();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(teardown).not.toHaveBeenCalled();
  const published = events.length; callbacks.changed({ ...emptyInternalPlayerState, itemId: 'song', status: 'playing', positionMs: 6000 });
  expect(events).toHaveLength(published);
  const other = request();
  // Nothing here controls the program playing in the background: the text names only the way back to it (2026-11-10).
  const refused = await service.open(other).then(() => '打开了', (error: unknown) => error);
  expect(refused).toBeInstanceOf(Error);
  expect(toUserErrorMessage(refused)).toBe(`界面重新加载前的节目还在后台播放，现在打开的工程不能播放。请打开工程「${a.projectPath}」接回控制，再在那里停止播放`);
  expect(output.close).not.toHaveBeenCalled();
  const reloaded = { ...a, ownerId: randomUUID(), revision: 0 };
  expect(await service.open(reloaded)).toBe('adopted'); expect(create).toHaveBeenCalledTimes(1);
  expect(events.at(-1)).toMatchObject({ ownerId: reloaded.ownerId, state: { positionMs: 6000, status: 'playing' } });
  await expect(service.control(command(a, { kind: 'stop' }))).rejects.toThrow(goneProgram);
  await service.control(command(reloaded, { kind: 'pause' })); expect(output.controller.pause).toHaveBeenCalledTimes(1);
  expect(teardown).not.toHaveBeenCalled();
});

// 修复前：说“这个播放控制请求来自已关闭的界面”，操作员看不懂，也不知道该怎么办。
it('窗口的节目已经关了还按播放：说节目关了、这次没执行，请重新打开工程再播放；关闭请求照常不算错', async () => {
  const service = new NativeProgramService(vi.fn(host), vi.fn(), () => Promise.resolve(), unlicensed, quiet()), a = request();
  await service.open(a); await service.close();
  const refused = await service.control(command(a, { kind: 'play', itemId: 'song' })).then(() => '播了', (error: unknown) => error);
  expect(refused).toBeInstanceOf(Error);
  expect(toUserErrorMessage(refused)).toBe(goneProgram);
  await expect(service.control(command(a, { kind: 'close' }))).resolves.toBeUndefined();
});

// 修复前：拒绝时说“请打开这个工程接回控制，或停止播放”，可这里没有能停后台节目的地方，操作员找不到“停止播放”。
it('后台在放别的工程时打开另一个工程：只说回到哪个工程接回控制、在那里停止；窗口照原样显示，工程名里的英文也不当成报错', async () => {
  const output = host(), create = vi.fn<ConstructorParameters<typeof NativeProgramService>[0]>(() => output);
  const service = new NativeProgramService(create, vi.fn(), () => Promise.resolve(), unlicensed, quiet());
  const live = { ...request(), projectPath: 'D:/直播/SHOW_FINAL.tblink' };
  await service.open(live); create.mock.calls[0]![2].changed({ ...emptyInternalPlayerState, itemId: 'song', status: 'paused' });
  await service.release();
  // As the window reads a refused open (RemoteNativeProgramPlayer): Electron's wrapper first.
  const refused = await service.open(request()).then(() => null, (error: unknown) => new Error(`Error invoking remote method 'link:native-program-open': ${String(error)}`));
  expect(toUserErrorMessage(refused)).toBe('界面重新加载前的节目还在后台播放，现在打开的工程不能播放。请打开工程「D:/直播/SHOW_FINAL.tblink」接回控制，再在那里停止播放');
  expect(output.close).not.toHaveBeenCalled();
});

it('接管的节目工程与界面不同时标记为过期；停止的节目在界面退出时关闭', async () => {
  const playing = host(), stopped = host(), create = vi.fn<ConstructorParameters<typeof NativeProgramService>[0]>()
    .mockReturnValueOnce(playing).mockReturnValueOnce(stopped);
  const service = new NativeProgramService(create, vi.fn(), () => Promise.resolve(), unlicensed, quiet()), a = request();
  await service.open(a); create.mock.calls[0]![2].changed({ ...emptyInternalPlayerState, itemId: 'song', status: 'paused' });
  await service.release();
  const edited = { ...JSON.parse(a.document) as Record<string, unknown>, name: '恢复副本中的修改' };
  const reloaded = { ...a, ownerId: randomUUID(), document: JSON.stringify(edited) };
  expect(await service.open(reloaded)).toBe('outdated');
  await service.control(command(reloaded, { kind: 'close' })); expect(playing.close).toHaveBeenCalledTimes(1);
  await service.open(request());
  expect(await service.release()).toBeNull(); expect(stopped.close).toHaveBeenCalledTimes(1);
});

it('窗口打开节目时工程检查拒绝则不创建宿主，之后可重新打开', async () => {
  const create = vi.fn(host), service = new NativeProgramService(create, vi.fn(), () => Promise.resolve(), unlicensed, quiet());
  await expect(service.open(request(), () => Promise.reject(new Error('只能访问当前打开的工程')))).rejects.toThrow('当前打开的工程');
  expect(create).not.toHaveBeenCalled();
  const checkProject = vi.fn(() => Promise.resolve()), input = request();
  await service.open(input, checkProject);
  expect(checkProject).toHaveBeenCalledWith(input.projectPath, expect.objectContaining({ name: '后台宿主测试' }));
  expect(create).toHaveBeenCalledOnce();
});

it('节目准备、播放、暂停时算在运行，界面退出和接管都不中断；停止、关闭或换成别的节目时算停下', async () => {
  const running: boolean[] = [], create = vi.fn<ConstructorParameters<typeof NativeProgramService>[0]>(host);
  const service = new NativeProgramService(create, vi.fn(), () => Promise.resolve(), value => running.push(value), quiet()), a = request();
  const song = (status: InternalPlayerState['status']) => create.mock.calls.at(-1)![2].changed({ ...emptyInternalPlayerState, itemId: 'song', status });
  await service.open(a); song('preparing'); song('playing'); song('paused'); song('playing');
  await service.release(); expect(await service.open({ ...a, ownerId: randomUUID() })).toBe('adopted');
  expect(running).toEqual([true]);
  song('stopped'); song('error'); expect(running).toEqual([true, false]);
  song('playing'); await service.open(request()); expect(running).toEqual([true, false, true, false]);
  song('preparing'); await service.close(); expect(running).toEqual([true, false, true, false, true, false]);
});

const lightsLeftOn = '「开场」的灯光没能完全关闭，控台上可能还亮着。原因：MA2 没有回应。请在控台上关掉这首歌的执行器。';
const projectOf = (input: NativeProgramOpen) => (JSON.parse(input.document) as { projectId: string }).projectId;

it('界面进程退出时告诉播放器没有窗口在看它的状态，重新加载的界面接回时再告诉它', async () => {
  const output = host(), create = vi.fn<ConstructorParameters<typeof NativeProgramService>[0]>(() => output);
  const service = new NativeProgramService(create, vi.fn(), () => Promise.resolve(), unlicensed, quiet()), a = request();
  await service.open(a); create.mock.calls[0]![2].changed({ ...emptyInternalPlayerState, itemId: 'song', status: 'playing' });
  expect(output.controller.setWatched).not.toHaveBeenCalled();
  await service.release(); expect(output.controller.setWatched.mock.calls).toEqual([[false]]);
  expect(await service.open({ ...a, ownerId: randomUUID() })).toBe('adopted');
  expect(output.controller.setWatched.mock.calls).toEqual([[false], [true]]);
});

it('窗口还在时，节目关闭时才失败的事（补发的关灯）马上按错误记录并标红', async () => {
  const output = host(), { record, toWindow, reporter } = faults();
  const create = vi.fn<ConstructorParameters<typeof NativeProgramService>[0]>(() => output);
  const service = new NativeProgramService(create, vi.fn(), () => Promise.resolve(), unlicensed, reporter), a = request();
  await service.open(a);
  output.close.mockImplementationOnce(() => { create.mock.calls[0]![2].closedFault(lightsLeftOn, 'song'); return Promise.resolve(); });
  await service.control(command(a, { kind: 'close' }));
  expect(record).toHaveBeenCalledExactlyOnceWith({ level: 'error', category: 'state', device: '播放器', projectId: projectOf(a), itemId: 'song',
    message: lightsLeftOn, result: 'failed' });
  expect(toWindow).toHaveBeenCalledExactlyOnceWith('link:main-process-error', lightsLeftOn);
});

// 修复前：界面进程退出后节目在后台接着放，这时停歌补发的关灯失败了，只进了播放器状态，而没有窗口在看，红字谁也看不到。
it('界面退出后节目在后台报的失败马上按错误记录，红字给下一个打开节目的界面（打开被拒绝也算），只显示一次', async () => {
  const output = host(), { record, toWindow, reporter } = faults();
  const create = vi.fn<ConstructorParameters<typeof NativeProgramService>[0]>(() => output);
  const service = new NativeProgramService(create, vi.fn(), () => Promise.resolve(), unlicensed, reporter), a = request();
  await service.open(a); const callbacks = create.mock.calls[0]![2];
  callbacks.changed({ ...emptyInternalPlayerState, itemId: 'song', status: 'playing' });
  await service.release();
  callbacks.closedFault(lightsLeftOn, 'song'); callbacks.changed({ ...emptyInternalPlayerState, itemId: 'next', status: 'playing' });
  expect(record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ level: 'error', projectId: projectOf(a), itemId: 'song', message: lightsLeftOn }));
  expect(toWindow).not.toHaveBeenCalled();
  await expect(service.open(request())).rejects.toThrow('接回控制，再在那里停止播放');
  expect(toWindow).toHaveBeenCalledExactlyOnceWith('link:main-process-error', lightsLeftOn);
  expect(await service.open({ ...a, ownerId: randomUUID() })).toBe('adopted');
  expect(toWindow).toHaveBeenCalledOnce(); expect(record).toHaveBeenCalledOnce();
});

it('界面退出时没在播的节目随即关闭，关闭时才失败的事按错误记录，红字留给下一个打开节目的界面', async () => {
  const output = host(), { record, toWindow, reporter } = faults();
  const create = vi.fn<ConstructorParameters<typeof NativeProgramService>[0]>(host).mockReturnValueOnce(output);
  const service = new NativeProgramService(create, vi.fn(), () => Promise.resolve(), unlicensed, reporter);
  await service.open(request());
  output.close.mockImplementationOnce(() => { create.mock.calls[0]![2].closedFault(lightsLeftOn, 'song'); return Promise.resolve(); });
  expect(await service.release()).toBeNull(); expect(output.close).toHaveBeenCalledOnce();
  expect(record).toHaveBeenCalledOnce(); expect(toWindow).not.toHaveBeenCalled();
  await service.open(request());
  expect(toWindow).toHaveBeenCalledExactlyOnceWith('link:main-process-error', lightsLeftOn);
});

// 修复前：退出时节目补发的关灯没发出去，红字在马上要关掉的窗口里闪一下，软件就退出了。link-main 的退出流程用
// collect 拿到这句话，像灯光试听停不掉时那样问操作员（programLightsQuitPrompt）。
it('退出时关节目，补发的关灯没发出去：退出流程拿到这首歌的那句话；照常按错误记录、标红', async () => {
  const output = host(), { record, toWindow, reporter } = faults();
  const create = vi.fn<ConstructorParameters<typeof NativeProgramService>[0]>(() => output);
  const service = new NativeProgramService(create, vi.fn(), () => Promise.resolve(), unlicensed, reporter), a = request();
  await service.open(a);
  output.close.mockImplementationOnce(() => { create.mock.calls[0]![2].closedFault(lightsLeftOn, 'song'); return Promise.resolve(); });
  expect(await reporter.collect(() => service.close())).toEqual([lightsLeftOn]);
  expect(record).toHaveBeenCalledExactlyOnceWith({ level: 'error', category: 'state', device: '播放器', projectId: projectOf(a), itemId: 'song',
    message: lightsLeftOn, result: 'failed' });
  expect(toWindow).toHaveBeenCalledExactlyOnceWith('link:main-process-error', lightsLeftOn);
});

// 修复前（R2 的半成品）：关节目时动作 MIDI 没关掉的那句话和关灯失败走同一条路，退出时被当成“灯光没能关闭”，弹出
// “返回软件 / 仍然退出”；只有 MIDI 没关掉时也这样问。
it('关节目时动作 MIDI 没关掉：按错误记一次、标红一次，退出时不当成灯光没关', async () => {
  const output = host(), { record, toWindow, reporter } = faults();
  const create = vi.fn<ConstructorParameters<typeof NativeProgramService>[0]>(() => output);
  const service = new NativeProgramService(create, vi.fn(), () => Promise.resolve(), unlicensed, reporter), a = request();
  await service.open(a);
  output.close.mockImplementationOnce(() => { create.mock.calls[0]![2].closedFault(midiLeftOpen, 'song', 'leftOpen'); return Promise.resolve(); });
  expect(await reporter.collect(() => service.close())).toEqual([]);
  expect(record).toHaveBeenCalledExactlyOnceWith({ level: 'error', category: 'device', device: '动作 MIDI', projectId: projectOf(a), itemId: 'song',
    message: midiLeftOpen, result: 'failed' });
  expect(toWindow).toHaveBeenCalledExactlyOnceWith('link:main-process-error', midiLeftOpen);
});

/** The main window's page as link-main follows it (window-page.ts), over this service, released by link-main's
 * releaseGonePage (engine-shutdown.ts). `teardown`: what it closes after the program (the audio engine, the picture,
 * the runtime the page held); `stopMonitor`: the editor's music monitor. */
function followedPage(service: NativeProgramService, teardown: () => Promise<void>, stopMonitor = vi.fn(() => Promise.resolve()),
  reporter: ReturnType<typeof faults> = faults()) {
  const page = windowPageEvents(), record = vi.fn<(entry: LinkLogInput) => Promise<unknown>>(() => Promise.resolve());
  const release = () => releaseGonePage(service, { teardown, stopMonitor }, reporter.reporter);
  followWindowPage(page.page, { releaseMidi: () => Promise.resolve(), failSaves: () => undefined, releaseProgram: release, record });
  return { page, record, releaseGonePage: release, stopMonitor };
}

// 修复前：上一页停着的节目还在慢慢关（停歌补发的关灯最多要 7 秒），新页面已经打开了工程的节目；上一页的清理随后又把
// 节目关一次，关掉的是新页面刚打开的那个，新页面按播放只得到“这个播放控制请求来自已关闭的界面”。
for (const path of ['界面自己重新加载', '界面进程退出后由主进程重新加载'] as const) {
  it(`${path}、上一页停着的节目还没关完时新页面就打开了节目：只关上一页的节目，新页面的节目照常播放，音频和画面不另外关`, async () => {
    const hosts: ReturnType<typeof host>[] = [];
    const create = vi.fn(() => { const made = host(); hosts.push(made); return made; });
    const service = new NativeProgramService(create, vi.fn(), () => Promise.resolve(), unlicensed, quiet());
    const teardown = vi.fn(() => Promise.resolve()), { page, releaseGonePage, stopMonitor } = followedPage(service, teardown);
    await service.open(request());
    const slow = deferred(); hosts[0]!.close.mockReturnValue(slow.promise);
    if (path === '界面自己重新加载') expect(page.reloadItself()).toBe(true);
    else { page.exit(); void releaseGonePage(); expect(page.reloadFromMain()).toBe(true); }
    const next = request(), opening = service.open(next);
    slow.release();
    expect(await opening).toBe('opened');
    await expect(service.control(command(next, { kind: 'play', itemId: 'song' }))).resolves.toBeUndefined();
    expect(hosts[1]!.controller.play).toHaveBeenCalledOnce();
    expect(hosts[0]!.close).toHaveBeenCalledOnce(); expect(hosts[1]!.close).not.toHaveBeenCalled();
    await new Promise(resolve => setTimeout(resolve, 0));
    // The new page's program plays with the audio engine and picture there are.
    expect(teardown).not.toHaveBeenCalled();
    // 修复前：teardown 跳过时独立监听也跟着不停，上一页开着的监听接着响。它只属于上一页：页面没了就停。
    expect(stopMonitor).toHaveBeenCalledOnce();
  });
}

it('界面重新加载、上一页的节目已经停了：关掉它，再关音频和画面；新页面之后打开节目照常播放', async () => {
  const hosts: ReturnType<typeof host>[] = [];
  const service = new NativeProgramService(() => { const made = host(); hosts.push(made); return made; }, vi.fn(), () => Promise.resolve(), unlicensed, quiet());
  const teardown = vi.fn(() => Promise.resolve()), { page, stopMonitor } = followedPage(service, teardown);
  await service.open(request());
  expect(page.reloadItself()).toBe(true);
  await vi.waitFor(() => expect(teardown).toHaveBeenCalledOnce());
  expect(hosts[0]!.close).toHaveBeenCalledOnce(); expect(stopMonitor).toHaveBeenCalledOnce();
  const next = request();
  expect(await service.open(next)).toBe('opened');
  await service.control(command(next, { kind: 'play', itemId: 'song' }));
  expect(hosts[1]!.controller.play).toHaveBeenCalledOnce(); expect(teardown).toHaveBeenCalledOnce(); expect(stopMonitor).toHaveBeenCalledOnce();
});

// 修复前：节目在后台接着放时，上一页编辑器里开着的独立监听也接着往监听设备放，新页面上却显示没在监听。
it('界面重新加载时节目在播：节目、音频引擎和画面照常，上一页的独立监听停掉；监听停不掉时记一次、在下一个窗口说一次', async () => {
  const output = host(), reporter = faults(), create = vi.fn<ConstructorParameters<typeof NativeProgramService>[0]>(() => output);
  const service = new NativeProgramService(create, vi.fn(), () => Promise.resolve(), unlicensed, reporter.reporter), a = request();
  const teardown = vi.fn(() => Promise.resolve()), stopMonitor = vi.fn(() => Promise.reject(new Error('监听进程没有退出')));
  const { page, record } = followedPage(service, teardown, stopMonitor, reporter);
  await service.open(a); create.mock.calls[0]![2].changed({ ...emptyInternalPlayerState, itemId: 'song', status: 'playing', positionMs: 5000 });
  expect(page.reloadItself()).toBe(true);
  await vi.waitFor(() => expect(record).toHaveBeenCalledOnce());
  expect(record).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning', message: '界面重新加载了，节目在后台继续播放（5 秒），打开同一个工程就能接回控制' }));
  expect(stopMonitor).toHaveBeenCalledOnce(); expect(teardown).not.toHaveBeenCalled(); expect(output.close).not.toHaveBeenCalled();
  // The monitor logged its failure itself (MusicMonitorService); the gone page is not shown it, the next window is.
  expect(reporter.record).not.toHaveBeenCalled(); expect(reporter.toWindow).not.toHaveBeenCalled();
  expect(await service.open({ ...a, ownerId: randomUUID() })).toBe('adopted');
  expect(reporter.toWindow).toHaveBeenCalledExactlyOnceWith('link:main-process-error', '独立监听没能完全关掉，不影响之后播放。原因：监听进程没有退出');
});

it('关音频和画面还没完时新页面打开节目：等它关完再建新节目；关不掉时记一次错误，不挡住之后打开节目', async () => {
  const create = vi.fn(host), service = new NativeProgramService(create, vi.fn(), () => Promise.resolve(), unlicensed, quiet());
  const closing = deferred(), teardown = vi.fn(() => closing.promise), { page, record } = followedPage(service, teardown);
  await service.open(request());
  expect(page.reloadItself()).toBe(true);
  await vi.waitFor(() => expect(teardown).toHaveBeenCalledOnce());
  const opening = service.open(request());
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(create).toHaveBeenCalledOnce();
  closing.release();
  expect(await opening).toBe('opened'); expect(create).toHaveBeenCalledTimes(2);
  teardown.mockRejectedValueOnce(new Error('音频引擎没有响应'));
  expect(page.reloadItself()).toBe(true);
  await vi.waitFor(() => expect(record).toHaveBeenCalledOnce());
  expect(record).toHaveBeenCalledWith(expect.objectContaining({ level: 'error', message: '界面重新加载了，上一页的节目、音频或画面没能关掉。原因：音频引擎没有响应' }));
  expect(await service.open(request())).toBe('opened'); expect(create).toHaveBeenCalledTimes(3);
});

it('播放条拖动只试听，保存的歌曲音量单独送到节目；没标明试听的音量请求不进入控制器（2026-11-09）', async () => {
  const output = host(), service = new NativeProgramService(vi.fn(() => output), vi.fn(), () => Promise.resolve(), unlicensed, quiet()), input = request();
  await service.open(input);
  await service.control(command(input, { kind: 'volume', volume: 40, preview: true }));
  expect(output.controller.previewVolume).toHaveBeenCalledWith(40);
  await service.control(command(input, { kind: 'songVolume', itemId: 'song', volume: 40 }));
  expect(output.controller.setSongVolume).toHaveBeenCalledWith('song', 40);
  await expect(service.control({ version: 1, ownerId: input.ownerId, operation: { kind: 'volume', volume: 40 } })).rejects.toThrow();
  expect(output.controller.overrideVolume).not.toHaveBeenCalled();
});
