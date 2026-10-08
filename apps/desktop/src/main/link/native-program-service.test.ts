import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createEmptyLinkProject, type NativeProgramOpen, type NativeProgramOperation, type NativeProgramEvent } from '@tb/schema';
import { emptyInternalPlayerState, type PlaybackBoundary } from '@tb/core/link';
import { NativeProgramService } from './native-program-service';

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
    preloadSelected: vi.fn(), freeze: vi.fn(), reportUnavailable: vi.fn(), runtimeUnavailable: vi.fn(), externalStop: vi.fn(),
    getAudioAnalysis: () => null, dispose: vi.fn(() => Promise.resolve()) } };
}
function command(input: NativeProgramOpen, operation: NativeProgramOperation) { return { version: 1, ownerId: input.ownerId, operation }; }

it('关闭等待授权的会话立即完成；迟到授权不创建播放器', async () => {
  const gate = deferred(), create = vi.fn(host), service = new NativeProgramService(create, vi.fn(), () => gate.promise), input = request();
  const opening = service.open(input);
  await service.control(command(input, { kind: 'close' })); await opening;
  expect(create).not.toHaveBeenCalled(); gate.release(); await Promise.resolve(); expect(create).not.toHaveBeenCalled();
});

it('替换等待旧输出关闭；旧界面的迟到关闭不停止新输出', async () => {
  const old = host(), next = host(), gate = deferred(), create = vi.fn().mockReturnValueOnce(old).mockReturnValueOnce(next);
  const service = new NativeProgramService(create, vi.fn(), () => Promise.resolve()), a = request(), b = request();
  await service.open(a); old.close.mockReturnValue(gate.promise);
  const replacing = service.open(b); await Promise.resolve(); expect(create).toHaveBeenCalledTimes(1);
  await service.control(command(a, { kind: 'close' })); expect(next.close).not.toHaveBeenCalled();
  gate.release(); await replacing; expect(create).toHaveBeenCalledTimes(2);
  await expect(service.control(command(a, { kind: 'play', itemId: 'old' }))).rejects.toThrow('已关闭');
  await service.control(command(b, { kind: 'play', itemId: 'next' })); expect(next.controller.play).toHaveBeenCalledWith('next', undefined, undefined);
});

it('停止不排在未完成的播放准备之后', async () => {
  const output = host(), gate = deferred(); output.controller.play.mockReturnValue(gate.promise);
  const service = new NativeProgramService(() => output, vi.fn(), () => Promise.resolve()), input = request();
  await service.open(input); const playing = service.control(command(input, { kind: 'play', itemId: 'song' }));
  await service.control(command(input, { kind: 'stop' })); expect(output.controller.stop).toHaveBeenCalledOnce(); gate.release(); await playing;
});

it('关闭失败阻止新宿主；授权失败未创建输出时允许重新打开', async () => {
  const output = host(), create = vi.fn(() => output), authorize = vi.fn(() => Promise.resolve());
  const service = new NativeProgramService(create, vi.fn(), authorize);
  authorize.mockRejectedValueOnce(new Error('授权失败'));
  await expect(service.open(request())).rejects.toThrow('授权失败'); expect(create).not.toHaveBeenCalled();
  await service.open(request()); expect(create).toHaveBeenCalledOnce(); output.close.mockRejectedValue(new Error('设备拒绝关闭'));
  await expect(service.open(request())).rejects.toThrow('设备拒绝关闭'); expect(create).toHaveBeenCalledOnce();
});

it('只发布当前会话的有序状态和边界；无效 DTO 不进入控制器', async () => {
  const events: NativeProgramEvent[] = [], output = host();
  const create = vi.fn<ConstructorParameters<typeof NativeProgramService>[0]>(() => output);
  const service = new NativeProgramService(create, event => events.push(event), () => Promise.resolve()), a = request(), b = request();
  await service.open(a); const oldCallbacks = create.mock.calls[0]![2];
  oldCallbacks.changed({ ...emptyInternalPlayerState, itemId: 'song', status: 'playing' });
  output.controller.clock.subscribeBoundary.mock.calls[0]![0]('seek');
  expect(events.map(event => event.sequence)).toEqual([1, 2, 3]); expect(events[2]?.boundary).toBe('seek');
  await service.open(b); const length = events.length; oldCallbacks.changed(emptyInternalPlayerState); expect(events).toHaveLength(length);
  await expect(service.control({ ...command(b, { kind: 'seek', positionMs: 100 }), extra: true })).rejects.toThrow();
  expect(output.controller.seek).not.toHaveBeenCalled();
});
