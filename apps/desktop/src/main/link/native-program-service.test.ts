import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createEmptyLinkProject, type NativeProgramOpen, type NativeProgramOperation, type NativeProgramEvent } from '@tb/schema';
import { emptyInternalPlayerState, type InternalPlayerState, type PlaybackBoundary } from '@tb/core/link';
import { NativeProgramService } from './native-program-service';
import { closedProgramFaultReporter } from './main-process-errors';
import type { LinkLogInput } from './run-logger';

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
    setVolume: vi.fn(), setEndAction: vi.fn(), setPlaylist: vi.fn(), toggleMtc: vi.fn(), receiveMidi: vi.fn(), fade: vi.fn(),
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
  await expect(service.control(command(a, { kind: 'play', itemId: 'old' }))).rejects.toThrow('已关闭');
  await service.control(command(b, { kind: 'play', itemId: 'next' })); expect(next.controller.play).toHaveBeenCalledWith('next', undefined, undefined);
});

it('停止不排在未完成的播放准备之后', async () => {
  const output = host(), gate = deferred(); output.controller.play.mockReturnValue(gate.promise);
  const service = new NativeProgramService(() => output, vi.fn(), () => Promise.resolve(), unlicensed, quiet()), input = request();
  await service.open(input); const playing = service.control(command(input, { kind: 'play', itemId: 'song' }));
  await service.control(command(input, { kind: 'stop' })); expect(output.controller.stop).toHaveBeenCalledOnce(); gate.release(); await playing;
});

it('关闭失败阻止新宿主；授权失败未创建输出时允许重新打开', async () => {
  const output = host(), create = vi.fn(() => output), authorize = vi.fn(() => Promise.resolve());
  const service = new NativeProgramService(create, vi.fn(), authorize, unlicensed, quiet());
  authorize.mockRejectedValueOnce(new Error('授权失败'));
  await expect(service.open(request())).rejects.toThrow('授权失败'); expect(create).not.toHaveBeenCalled();
  await service.open(request()); expect(create).toHaveBeenCalledOnce(); output.close.mockRejectedValue(new Error('设备拒绝关闭'));
  await expect(service.open(request())).rejects.toThrow('设备拒绝关闭'); expect(create).toHaveBeenCalledOnce();
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

it('界面进程退出时播放中的节目不停；重新加载的同工程界面接管同一输出', async () => {
  const output = host(), events: NativeProgramEvent[] = [];
  const create = vi.fn<ConstructorParameters<typeof NativeProgramService>[0]>(() => output);
  const service = new NativeProgramService(create, event => events.push(event), () => Promise.resolve(), unlicensed, quiet()), a = request();
  expect(await service.open(a)).toBe('opened'); const callbacks = create.mock.calls[0]![2];
  callbacks.changed({ ...emptyInternalPlayerState, itemId: 'song', status: 'playing', positionMs: 5000 });
  expect(await service.release()).toMatchObject({ itemId: 'song', status: 'playing' }); expect(output.close).not.toHaveBeenCalled();
  const published = events.length; callbacks.changed({ ...emptyInternalPlayerState, itemId: 'song', status: 'playing', positionMs: 6000 });
  expect(events).toHaveLength(published);
  const other = request();
  await expect(service.open(other)).rejects.toThrow('请打开这个工程接回控制，或停止播放'); expect(output.close).not.toHaveBeenCalled();
  const reloaded = { ...a, ownerId: randomUUID(), revision: 0 };
  expect(await service.open(reloaded)).toBe('adopted'); expect(create).toHaveBeenCalledTimes(1);
  expect(events.at(-1)).toMatchObject({ ownerId: reloaded.ownerId, state: { positionMs: 6000, status: 'playing' } });
  await expect(service.control(command(a, { kind: 'stop' }))).rejects.toThrow('已关闭');
  await service.control(command(reloaded, { kind: 'pause' })); expect(output.controller.pause).toHaveBeenCalledTimes(1);
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
  await expect(service.open(request())).rejects.toThrow('请打开这个工程接回控制');
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
