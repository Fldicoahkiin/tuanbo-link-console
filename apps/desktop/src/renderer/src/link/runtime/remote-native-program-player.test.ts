import { expect, it, vi } from 'vitest';
import { emptyInternalPlayerState, type InternalPlayerDependencies, type LinkDesktopApi } from '@tb/core/link';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject, type LinkProject, type NativeProgramAttachment, type NativeProgramEvent } from '@tb/schema';
import { RemoteNativeProgramPlayer } from './remote-native-program-player';

const song = parseLinkProject({ ...createEmptyLinkProject('远程控制'), playbackSource: 'internal', rundown: [{ id: 'song', title: '歌曲' }] });
function fixture(wait?: Promise<NativeProgramAttachment>, project: LinkProject = song) {
  const api = {
    openNativeProgram: vi.fn<LinkDesktopApi['openNativeProgram']>(() => wait ?? Promise.resolve('opened')),
    controlNativeProgram: vi.fn<LinkDesktopApi['controlNativeProgram']>(() => Promise.resolve()),
    onNativeProgramEvent: vi.fn<LinkDesktopApi['onNativeProgramEvent']>(() => vi.fn()),
    onNativeProgramClosed: vi.fn<LinkDesktopApi['onNativeProgramClosed']>(() => stopListening),
    onNativePlaybackStatus: vi.fn<LinkDesktopApi['onNativePlaybackStatus']>(() => vi.fn())
  };
  const stopListening = vi.fn();
  /** What `outdated` said each time the window was told the open was answered. */
  const answered: boolean[] = [];
  const dependencies = { prepare: vi.fn(() => Promise.resolve()), ingest: vi.fn(() => Promise.resolve()), pause: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()), resolveAudio: vi.fn(() => Promise.reject(new Error('不能在界面播放原声'))),
    configuration: () => ({ outputDeviceId: 'default', mtcPortName: null }), changed: vi.fn<InternalPlayerDependencies['changed']>(), notice: vi.fn(),
    attached: vi.fn(() => { answered.push(player.outdated); }), closed: vi.fn() };
  const observed = vi.fn(), player: RemoteNativeProgramPlayer = new RemoteNativeProgramPlayer(project, 'C:/test/show.tblink', 1, dependencies, api, observed);
  const ownerId = api.openNativeProgram.mock.calls[0]![0].ownerId;
  const emit = (patch: Partial<NativeProgramEvent> = {}) => api.onNativeProgramEvent.mock.calls[0]![0]({ version: 1, ownerId, sequence: 1,
    state: { ...emptyInternalPlayerState, status: 'playing', itemId: 'song', positionMs: 1234 },
    clock: { positionMs: 1234, durationMs: 5000, ready: true, playing: true, seeking: false }, currentCueId: null, ...patch });
  /** Main tells the windows that the quit closed the program `ownerId` opened, and the operator went back to the app. */
  const closedByQuit = (id: string) => api.onNativeProgramClosed.mock.calls[0]![0]({ version: 1, ownerId: id });
  return { api, dependencies, player, observed, emit, ownerId, answered, closedByQuit, stopListening };
}

// 修复前：退出时关掉了窗口的节目，操作员选“返回软件”以后窗口不知道，按播放只得到“这个播放控制请求来自已关闭的界面”。
it('退出时这个窗口的节目被关掉、操作员回到软件：告诉窗口重新打开节目；别的窗口的节目、销毁以后都不算', async () => {
  const f = fixture();
  f.closedByQuit(crypto.randomUUID());
  expect(f.dependencies.closed).not.toHaveBeenCalled();
  f.closedByQuit(f.ownerId);
  expect(f.dependencies.closed).toHaveBeenCalledOnce();
  expect(f.api.controlNativeProgram).not.toHaveBeenCalled();
  await f.player.dispose();
  expect(f.stopListening).toHaveBeenCalledOnce();
  f.closedByQuit(f.ownerId);
  expect(f.dependencies.closed).toHaveBeenCalledOnce();
});

it('只显示当前会话递增序号；时钟与状态同步，旧界面事件不回写', async () => {
  const f = fixture(), boundary = vi.fn(); f.player.clock.subscribeBoundary(boundary);
  f.emit({ sequence: 2, boundary: 'seek' });
  expect(f.player.clock.read().positionMs).toBe(1234); expect(boundary).toHaveBeenCalledExactlyOnceWith('seek');
  const first = f.dependencies.changed.mock.calls[0]![0]; f.emit({ sequence: 3 });
  expect(f.dependencies.changed.mock.calls[1]![0].playedItemIds).toBe(first.playedItemIds);
  f.emit({ sequence: 1 }); f.emit({ ownerId: crypto.randomUUID(), sequence: 100 });
  expect(f.dependencies.changed).toHaveBeenCalledTimes(2);
  await f.player.dispose(); f.emit({ sequence: 4 }); expect(f.dependencies.changed).toHaveBeenCalledTimes(2);
});

it('播放和停止发送给后台，不触发界面计时、MIDI 或第二音源', async () => {
  const f = fixture(); await f.player.play('song', 2500, true); await f.player.stop();
  expect(f.api.controlNativeProgram.mock.calls.map(call => call[0].operation)).toEqual([
    { kind: 'play', itemId: 'song', positionMs: 2500, paused: true }, { kind: 'stop' }
  ]);
  expect(f.dependencies.prepare).not.toHaveBeenCalled(); expect(f.dependencies.ingest).not.toHaveBeenCalled();
  expect(f.dependencies.resolveAudio).not.toHaveBeenCalled(); expect(f.player.clock.read().positionMs).toBe(0);
});

it('尚在打开时销毁立即发送关闭，不等待许可，也不发送迟到播放', async () => {
  let release!: () => void; const wait = new Promise<NativeProgramAttachment>(resolve => { release = () => resolve('opened'); }), f = fixture(wait);
  const play = f.player.play('song'); await f.player.dispose();
  expect(f.api.controlNativeProgram.mock.calls.map(call => call[0].operation.kind)).toEqual(['close']);
  release(); await play; expect(f.api.controlNativeProgram).toHaveBeenCalledOnce();
});

it('后台控制拒绝明确显示并记录，不静默切回浏览器', async () => {
  const f = fixture(); f.api.controlNativeProgram.mockRejectedValue(new Error('输出关闭未完成'));
  await f.player.play('song');
  expect(f.dependencies.changed).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'error', error: '输出关闭未完成' }));
  expect(f.dependencies.notice).toHaveBeenCalledWith('输出关闭未完成', null); expect(f.dependencies.resolveAudio).not.toHaveBeenCalled();
});

it('接管到与界面不同版本的节目时标记为过期，其余打开不标记', async () => {
  const outdated = fixture(Promise.resolve('outdated')), adopted = fixture(Promise.resolve('adopted'));
  await outdated.player.play('song'); await adopted.player.play('song');
  expect(outdated.player.outdated).toBe(true); expect(adopted.player.outdated).toBe(false); expect(fixture().player.outdated).toBe(false);
});

it('后台答复打开以后告诉界面，这时已经知道是不是过期的节目；销毁以后答复不再告诉界面', async () => {
  // The program sends its state before it answers the open: the editor learns it is outdated only from this call.
  const outdated = fixture(Promise.resolve('outdated')), adopted = fixture(Promise.resolve('adopted'));
  outdated.emit({ sequence: 2, state: { ...emptyInternalPlayerState, status: 'paused', itemId: 'song' } });
  expect(outdated.answered).toEqual([]);
  await outdated.player.play('song'); await adopted.player.play('song');
  expect(outdated.answered).toEqual([true]); expect(adopted.answered).toEqual([false]);
  let release!: () => void; const wait = new Promise<NativeProgramAttachment>(resolve => { release = () => resolve('outdated'); }), late = fixture(wait);
  await late.player.dispose(); release(); await wait;
  expect(late.dependencies.attached).not.toHaveBeenCalled();
});

it('随时可播放：灯光需要处理的歌也直接发给后台播放，不弹窗、不拦，由后台显示提示（2026-10-26）', async () => {
  const lit = structuredClone(song), lighting = createLightingDocument();
  lighting.ma2Bindings = [{ id: 'binding', timecode: 2, name: '歌曲', readAt: '2026-10-22T00:00:00.000Z', sourceXml: '<MA/>', baselineTracks: [], mappings: [], playback: 'editable', timeOriginMs: 0 }];
  lit.rundown[0]!.lighting = lighting;
  for (const project of [song, lit]) {
    const f = fixture(undefined, project); await f.player.play('song'); await f.player.play('song');
    expect(f.api.controlNativeProgram.mock.calls.map(call => call[0].operation)).toEqual([{ kind: 'play', itemId: 'song', paused: false }, { kind: 'play', itemId: 'song', paused: false }]);
    expect(f.dependencies.notice).not.toHaveBeenCalled();
  }
});

// 0.5.9 S6：上一首没停下时打开被拒绝。原来界面之后什么都不发，按停止也到不了后台，只能等换工程。
it('打开被拒绝、因为上一首还没停下：按停止照样发给后台，后台打开了以后播放照常发；别的原因被拒绝时停止不发', async () => {
  const f = fixture(Promise.reject(new Error("Error invoking remote method 'link:native-program-open': Error: 上一首还没停下：设备拒绝关闭。再按一次停止")));
  await vi.waitFor(() => expect(f.dependencies.notice).toHaveBeenCalledOnce());
  await f.player.play('song');
  expect(f.api.controlNativeProgram).not.toHaveBeenCalled();
  await f.player.stop();
  expect(f.api.controlNativeProgram.mock.calls.map(call => call[0].operation)).toEqual([{ kind: 'stop' }]);
  expect(f.dependencies.attached).toHaveBeenCalledOnce();
  await f.player.play('song');
  expect(f.api.controlNativeProgram.mock.calls.map(call => call[0].operation)).toEqual([{ kind: 'stop' }, { kind: 'play', itemId: 'song', paused: false }]);

  const other = fixture(Promise.reject(new Error('只能访问当前打开的工程')));
  await vi.waitFor(() => expect(other.dependencies.notice).toHaveBeenCalledOnce());
  await other.player.stop();
  expect(other.api.controlNativeProgram).not.toHaveBeenCalled();
});
