import { expect, it, vi } from 'vitest';
import { emptyInternalPlayerState, type InternalPlayerDependencies, type LinkDesktopApi } from '@tb/core/link';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject, type LinkProject, type NativeProgramAttachment, type NativeProgramEvent } from '@tb/schema';
import { RemoteNativeProgramPlayer } from './remote-native-program-player';
import type { ProgramDocument } from './program-document-feed';

const song = parseLinkProject({ ...createEmptyLinkProject('远程控制'), playbackSource: 'internal', rundown: [{ id: 'song', title: '歌曲' }] });
const SESSION = crypto.randomUUID();
function fixture(wait?: Promise<NativeProgramAttachment>, project: LinkProject = song) {
  const api = {
    openNativeProgram: vi.fn<LinkDesktopApi['openNativeProgram']>(() => wait ?? Promise.resolve('opened')),
    controlNativeProgram: vi.fn<LinkDesktopApi['controlNativeProgram']>(() => Promise.resolve()),
    documentNativeProgram: vi.fn<LinkDesktopApi['documentNativeProgram']>(request => Promise.resolve({ kind: 'applied', revision: request.revision, effect: 'stopped' })),
    onNativeProgramEvent: vi.fn<LinkDesktopApi['onNativeProgramEvent']>(() => vi.fn()),
    onNativeProgramClosed: vi.fn<LinkDesktopApi['onNativeProgramClosed']>(() => stopListening),
    onNativePlaybackStatus: vi.fn<LinkDesktopApi['onNativePlaybackStatus']>(() => vi.fn())
  };
  const stopListening = vi.fn();
  /** The window's project (the document store). */
  let document: ProgramDocument | null = { project, path: 'C:/test/show.tblink', sessionId: SESSION, revision: 1 };
  const dependencies = { prepare: vi.fn(() => Promise.resolve()), ingest: vi.fn(() => Promise.resolve()), pause: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()), resolveAudio: vi.fn(() => Promise.reject(new Error('不能在界面播放原声'))),
    configuration: () => ({ outputDeviceId: 'default', mtcPortName: null }), changed: vi.fn<InternalPlayerDependencies['changed']>(), notice: vi.fn(),
    document: () => document, attached: vi.fn(), encode: vi.fn((value: LinkProject) => Promise.resolve(JSON.stringify(value))) };
  const observed = vi.fn(), ownerId = crypto.randomUUID(), player = new RemoteNativeProgramPlayer(dependencies, api, observed, ownerId);
  let sequence = 1;
  const emit = (patch: Partial<NativeProgramEvent> = {}) => api.onNativeProgramEvent.mock.calls[0]![0]({ version: 1, ownerId, sequence: sequence++,
    state: { ...emptyInternalPlayerState, status: 'playing', itemId: 'song', positionMs: 1234 },
    clock: { positionMs: 1234, durationMs: 5000, ready: true, playing: true, seeking: false }, currentCueId: null,
    documentVersion: { sessionId: SESSION, revision: 1 }, pictureVersion: patch.documentVersion ?? { sessionId: SESSION, revision: 1 }, ...patch });
  /** Main tells the windows that the quit closed the program `ownerId` opened, and the operator went back to the app. */
  const closedByQuit = (id: string) => api.onNativeProgramClosed.mock.calls[0]![0]({ version: 1, ownerId: id });
  /** The operator edits: the document store has a newer version. */
  const edit = (next: Partial<ProgramDocument> = {}) => {
    document = document && { ...document, revision: document.revision + 1, ...next }; player.documentChanged();
  };
  const close = () => { document = null; player.documentChanged(); };
  return { api, dependencies, player, observed, emit, ownerId, closedByQuit, stopListening, edit, close, document: () => document };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

// 修复前：退出时关掉了窗口的节目，操作员选“返回软件”以后窗口不知道，按播放只得到“这个播放控制请求来自已关闭的界面”。
it('退出时这个窗口的节目被关掉、操作员回到软件：页面重新打开节目；别的窗口的节目、销毁以后都不算', async () => {
  const f = fixture(); await settle();
  f.closedByQuit(crypto.randomUUID());
  expect(f.api.openNativeProgram).toHaveBeenCalledOnce();
  f.closedByQuit(f.ownerId); await settle();
  expect(f.api.openNativeProgram).toHaveBeenCalledTimes(2);
  expect(f.api.openNativeProgram.mock.calls[1]![0]).toMatchObject({ ownerId: f.ownerId, revision: 1, sessionId: SESSION });
  expect(f.api.controlNativeProgram).not.toHaveBeenCalled();
  await f.player.dispose();
  expect(f.stopListening).toHaveBeenCalledOnce();
  f.closedByQuit(f.ownerId); await settle();
  expect(f.api.openNativeProgram).toHaveBeenCalledTimes(2);
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
  expect(f.dependencies.attached).not.toHaveBeenCalled();
});

it('后台控制拒绝明确显示并记录，不静默切回浏览器', async () => {
  const f = fixture(); f.api.controlNativeProgram.mockRejectedValue(new Error('输出关闭未完成'));
  await f.player.play('song');
  expect(f.dependencies.changed).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'error', error: '输出关闭未完成' }));
  expect(f.dependencies.notice).toHaveBeenCalledWith('输出关闭未完成', null); expect(f.dependencies.resolveAudio).not.toHaveBeenCalled();
});

it('节目在播哪一版按事件里的版本号认：是这一页送过的就知道是哪个工程，接回的另一页的版本不知道（null）', async () => {
  const f = fixture(); await settle();
  expect(f.player.attached).toBe(true);
  f.emit();
  expect(f.player.project).toBe(song);
  f.emit({ documentVersion: { sessionId: crypto.randomUUID(), revision: 7 } });
  expect(f.player.project).toBeNull();
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

// 0.5.9 S7：原来每次修改都关掉节目再打开一个。
it('同一个工程的修改只送新的一版，不重新打开；送的是改了的部分（0.5.9 S9）', async () => {
  const f = fixture(); await settle();
  f.edit(); await settle();
  expect(f.api.openNativeProgram).toHaveBeenCalledOnce();
  expect(f.api.controlNativeProgram).not.toHaveBeenCalled();
  expect(f.api.documentNativeProgram).toHaveBeenCalledOnce();
  expect(f.api.documentNativeProgram.mock.calls[0]![0]).toMatchObject({ ownerId: f.ownerId, revision: 2, base: 1,
    key: { sessionId: SESSION, projectId: song.projectId, projectPath: 'C:/test/show.tblink' }, change: { kind: 'items', items: [], removed: [] } });
});

it('上一版还在路上时，开始播放之前先把最新的一版送过去，播放跟在它后面', async () => {
  const f = fixture(); await settle();
  let answer!: () => void;
  f.api.documentNativeProgram.mockImplementationOnce(request => new Promise(resolve => { answer = () => resolve({ kind: 'applied', revision: request.revision, effect: 'stopped' }); }));
  f.edit(); f.edit();
  await vi.waitFor(() => expect(f.api.documentNativeProgram).toHaveBeenCalledOnce());
  await f.player.play('song');
  expect(f.api.documentNativeProgram.mock.calls.map(call => call[0].revision)).toEqual([2, 3]);
  const order = [...f.api.documentNativeProgram.mock.invocationCallOrder, ...f.api.controlNativeProgram.mock.invocationCallOrder];
  expect(order).toEqual([...order].sort((a, b) => a - b));
  answer(); await settle();
  expect(f.api.documentNativeProgram).toHaveBeenCalledTimes(2);
});

it('换了工程：拿着歌时不换，停下以后打开另一个；没有工程时不送也不报错', async () => {
  const f = fixture(); await settle();
  f.emit({ state: { ...emptyInternalPlayerState, status: 'playing', itemId: 'song' } });
  const other = { ...song, projectId: crypto.randomUUID() };
  f.edit({ project: other });
  expect(f.api.openNativeProgram).toHaveBeenCalledOnce();
  f.emit({ state: { ...emptyInternalPlayerState, status: 'stopped' } }); await settle();
  expect(f.api.openNativeProgram).toHaveBeenCalledTimes(2);
  expect(f.api.openNativeProgram.mock.calls[1]![0]).toMatchObject({ document: JSON.stringify(other), revision: 2 });
  await settle();
  f.close();
  expect(f.api.documentNativeProgram).not.toHaveBeenCalled(); expect(f.dependencies.notice).not.toHaveBeenCalled();
});

it('打开失败以后，下一次修改重新打开（原来每次修改都重建一次），不自己重试', async () => {
  const f = fixture(Promise.reject(new Error('授权没有通过')));
  await vi.waitFor(() => expect(f.dependencies.notice).toHaveBeenCalledOnce());
  await settle(); expect(f.api.openNativeProgram).toHaveBeenCalledOnce();
  f.api.openNativeProgram.mockResolvedValue('opened');
  f.edit(); await settle();
  expect(f.api.openNativeProgram).toHaveBeenCalledTimes(2);
  expect(f.player.attached).toBe(true);
});

it('改了设备设置：发 configure，带上现在的设置', async () => {
  const f = fixture(); await settle();
  f.player.configure(); await settle();
  expect(f.api.controlNativeProgram.mock.calls[0]![0].operation).toEqual({ kind: 'configure', configuration: { outputDeviceId: 'default', mtcPortName: null, preciseSeeking: false } });
});

// 0.5.9 S9：整份在 worker 里编码，开歌要等它；停止不等，等着的开歌就不发了（它本来也会被这次停止停掉）。
it('开歌在等最新一版编好时按了停止：停止马上发出去，等着的开歌不再发；其他控制照顺序跟在后面', async () => {
  const f = fixture(); await settle();
  f.api.documentNativeProgram.mockRejectedValueOnce(new Error('IPC 断了'));
  f.edit(); await settle();
  let finish!: () => void;
  const encoding = new Promise<void>(resolve => { finish = resolve; });
  f.dependencies.encode.mockImplementation(value => encoding.then(() => JSON.stringify(value)));
  const play = f.player.play('song');
  f.player.previewVolume(30);
  await f.player.stop();
  expect(f.api.controlNativeProgram.mock.calls.map(call => call[0].operation.kind)).toEqual(['stop']);
  finish(); await play; await settle();
  expect(f.api.controlNativeProgram.mock.calls.map(call => call[0].operation.kind)).toEqual(['stop', 'volume']);
  expect(f.api.documentNativeProgram.mock.calls.map(call => call[0].change.kind)).toEqual(['items', 'full']);
  await f.player.play('song');
  expect(f.api.controlNativeProgram.mock.calls.map(call => call[0].operation.kind)).toEqual(['stop', 'volume', 'play']);
});

it('开歌等最新一版编好、交给节目以后才发；打开时的整份也在 worker 里编', async () => {
  const f = fixture(); await settle();
  expect(f.dependencies.encode).toHaveBeenCalledExactlyOnceWith(song);
  f.api.documentNativeProgram.mockRejectedValueOnce(new Error('IPC 断了'));
  f.edit(); await settle();
  let finish!: () => void;
  const encoding = new Promise<void>(resolve => { finish = resolve; });
  f.dependencies.encode.mockImplementationOnce(value => encoding.then(() => JSON.stringify(value)));
  const play = f.player.play('song');
  await settle();
  expect(f.api.controlNativeProgram).not.toHaveBeenCalled();
  finish(); await play;
  expect(f.api.documentNativeProgram.mock.calls.map(call => call[0].change.kind)).toEqual(['items', 'full']);
  expect(f.api.documentNativeProgram.mock.invocationCallOrder[1]!).toBeLessThan(f.api.controlNativeProgram.mock.invocationCallOrder[0]!);
});
