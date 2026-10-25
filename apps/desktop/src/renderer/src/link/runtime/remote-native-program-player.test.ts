import { expect, it, vi } from 'vitest';
import { emptyInternalPlayerState, type InternalPlayerDependencies, type LinkDesktopApi } from '@tb/core/link';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject, type LinkProject, type NativeProgramAttachment, type NativeProgramEvent } from '@tb/schema';
import { RemoteNativeProgramPlayer } from './remote-native-program-player';

const song = parseLinkProject({ ...createEmptyLinkProject('远程控制'), playbackSource: 'internal', rundown: [{ id: 'song', title: '歌曲' }] });
function fixture(wait?: Promise<NativeProgramAttachment>, project: LinkProject = song, withoutLightingChoices: NonNullable<InternalPlayerDependencies['withoutLightingChoices']> = new Map()) {
  const api = {
    openNativeProgram: vi.fn<LinkDesktopApi['openNativeProgram']>(() => wait ?? Promise.resolve('opened')),
    controlNativeProgram: vi.fn<LinkDesktopApi['controlNativeProgram']>(() => Promise.resolve()),
    onNativeProgramEvent: vi.fn<LinkDesktopApi['onNativeProgramEvent']>(() => vi.fn()),
    onNativePlaybackStatus: vi.fn<LinkDesktopApi['onNativePlaybackStatus']>(() => vi.fn()),
    getNativePlaybackDevices: vi.fn<LinkDesktopApi['getNativePlaybackDevices']>(() => Promise.resolve({ protocol: 4, audio: [], midiOutputs: [] }))
  };
  const dependencies = { prepare: vi.fn(() => Promise.resolve()), ingest: vi.fn(() => Promise.resolve()), pause: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()), resolveAudio: vi.fn(() => Promise.reject(new Error('不能在界面播放原声'))),
    configuration: () => ({ outputDeviceId: 'default', mtcPortName: null }), changed: vi.fn<InternalPlayerDependencies['changed']>(), notice: vi.fn(),
    confirmWithoutLighting: vi.fn<NonNullable<InternalPlayerDependencies['confirmWithoutLighting']>>(() => Promise.resolve(true)), withoutLightingChoices };
  const observed = vi.fn(), player = new RemoteNativeProgramPlayer(project, 'C:/test/show.tblink', 1, dependencies, api, observed);
  const ownerId = api.openNativeProgram.mock.calls[0]![0].ownerId;
  const emit = (patch: Partial<NativeProgramEvent> = {}) => api.onNativeProgramEvent.mock.calls[0]![0]({ version: 1, ownerId, sequence: 1,
    state: { ...emptyInternalPlayerState, status: 'playing', itemId: 'song', positionMs: 1234 },
    clock: { positionMs: 1234, durationMs: 5000, ready: true, playing: true, seeking: false }, currentCueId: null, ...patch });
  return { api, dependencies, player, observed, emit, ownerId };
}

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

it('没有灯光工作的歌直接播放，不询问也不查询端口；灯光需要处理的歌先问，取消就不播放，选择后无灯光播放', async () => {
  const plain = fixture(); await plain.player.play('song');
  expect(plain.dependencies.confirmWithoutLighting).not.toHaveBeenCalled(); expect(plain.api.getNativePlaybackDevices).not.toHaveBeenCalled();
  expect(plain.api.controlNativeProgram.mock.calls[0]?.[0].operation).toEqual({ kind: 'play', itemId: 'song', paused: false });
  const lit = structuredClone(song), lighting = createLightingDocument();
  lighting.ma2Bindings = [{ id: 'binding', timecode: 2, name: '歌曲', readAt: '2026-10-22T00:00:00.000Z', sourceXml: '<MA/>', baselineTracks: [], mappings: [], playback: 'editable', timeOriginMs: 0 }];
  lit.rundown[0]!.lighting = lighting;
  const asked = fixture(undefined, lit); asked.dependencies.confirmWithoutLighting.mockResolvedValueOnce(false);
  await asked.player.play('song');
  expect(asked.dependencies.confirmWithoutLighting.mock.calls[0]?.[0]).toMatch(/^这首歌的灯光需要处理：控台 Timecode 2/);
  expect(asked.api.controlNativeProgram).not.toHaveBeenCalled();
  await asked.player.play('song');
  expect(asked.api.controlNativeProgram.mock.calls[0]?.[0].operation).toEqual({ kind: 'play', itemId: 'song', paused: false, withoutLighting: true });
});

it('开播检查同一首歌同一类问题只问一次：重建播放器后沿用选择；检查通过或换了问题类型后再问', async () => {
  const lit = structuredClone(song), lighting = createLightingDocument();
  lighting.ma2Bindings = [{ id: 'binding', timecode: 2, name: '歌曲', readAt: '2026-10-22T00:00:00.000Z', sourceXml: '<MA/>', baselineTracks: [], mappings: [], playback: 'editable', timeOriginMs: 0 }];
  lit.rundown[0]!.lighting = lighting;
  const choices: NonNullable<InternalPlayerDependencies['withoutLightingChoices']> = new Map();
  const withoutLighting = { kind: 'play', itemId: 'song', paused: false, withoutLighting: true };
  const first = fixture(undefined, lit, choices);
  await first.player.play('song'); await first.player.play('song');
  expect(first.dependencies.confirmWithoutLighting).toHaveBeenCalledOnce();
  expect(first.api.controlNativeProgram.mock.calls.map(call => call[0].operation)).toEqual([withoutLighting, withoutLighting]);
  const rebuilt = fixture(undefined, lit, choices); await rebuilt.player.play('song');
  expect(rebuilt.dependencies.confirmWithoutLighting).not.toHaveBeenCalled();
  expect(rebuilt.api.controlNativeProgram.mock.calls[0]?.[0].operation).toEqual(withoutLighting);
  expect(rebuilt.dependencies.notice).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^开播前检查：沿用操作员选择无灯光播放；这首歌的灯光需要处理/), 'song');
  const declined = fixture(undefined, structuredClone(lit), new Map(choices)); declined.dependencies.confirmWithoutLighting.mockResolvedValueOnce(false);
  declined.dependencies.withoutLightingChoices.set(`${lit.projectId}\nsong`, 'editing'); await declined.player.play('song');
  expect(declined.dependencies.confirmWithoutLighting).toHaveBeenCalledOnce(); expect(declined.api.controlNativeProgram).not.toHaveBeenCalled();
  expect(declined.dependencies.withoutLightingChoices.get(`${lit.projectId}\nsong`)).toBe('editing');
  const fixed = fixture(undefined, song, choices); await fixed.player.play('song');
  expect(fixed.dependencies.confirmWithoutLighting).not.toHaveBeenCalled(); expect(choices.size).toBe(0);
  const again = fixture(undefined, lit, choices); await again.player.play('song');
  expect(again.dependencies.confirmWithoutLighting).toHaveBeenCalledOnce();
});
