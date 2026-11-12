import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { clockFromNativeStatus, emptyInternalPlayerState, NativeProgramPlayer, type InternalPlayerState, type LinkDesktopApi } from '@tb/core/link';
import { createEmptyLinkProject, parseLinkProject, type LinkAction, type NativeObsStatus, type NativePlayerStatus, type NativeProgramOpen } from '@tb/schema';
import { NativeObsHost } from './native-obs-host';
import { NativeObsRequests } from './native-obs-requests';
import { NativeProgramService } from './native-program-service';
import { closedProgramFaultReporter } from './main-process-errors';
import { NativeObsPreloadPool } from './native-obs-preload';
import type { NativeObsOutputs } from './native-obs-outputs';

const path = 'C:/shows/picture.tblink';
const project = parseLinkProject({ ...createEmptyLinkProject('画面故障'), playbackSource: 'internal', obsOutputMode: 'scenes',
  rundown: [{ id: 'song', title: '开场', referenceAudio: { assetId: 'a', relativePath: 'a.wav', sha256: 'a'.repeat(64), durationMs: 20000 },
    playback: { startMs: 0, endMs: 20000, mtcOffsetMs: 480000, volume: 80, endAction: 'pause', shortcut: '' },
    cues: [0, 1].map(seconds => ({ id: `cue-${seconds}`, name: '机位', timecode: { hours: 0, minutes: 0, seconds, frames: 0 },
      actions: [{ id: `scene-${seconds}`, kind: 'obs.setProgramScene', label: '切机位', sceneName: `机位${seconds}` }] })) }] });

/** The program on the picture host as link-main wires them: the program's OBS requests go through NativeObsRequests to the
 * real NativeObsHost, whose statuses reach the program (programObsListeners); each engine status reaches the picture
 * before the program. `admit`: whether the picture host takes the next preparation (it refuses one for audio it does
 * not see playing this song). `pool`: where the program preselects a song's picture (link-main's NativeObsPreloadPool). */
function rig(execute: (action: LinkAction) => Promise<void>, admit: () => boolean = () => true, pool: NativeObsPreloadPool | null = null) {
  let audio: NativePlayerStatus | null = null, now = 0, state: InternalPlayerState = { ...emptyInternalPlayerState };
  const audioListeners = new Set<(value: NativePlayerStatus) => void>(), obsListeners = new Set<(value: NativeObsStatus) => void>();
  const errors: string[] = [], notices: string[] = [];
  const host: NativeObsHost = new NativeObsHost({ audio: () => admit() ? audio : null, error: message => errors.push(message),
    changed: value => { for (const listener of obsListeners) listener(value); },
    outputs: () => ({ executor: { id: 'obs', supports: () => true, execute },
      guardOutput: <T>(_canSend: () => boolean, operation: () => Promise<T>) => operation(),
      prepareOutputs: () => Promise.resolve(), releaseOutputs: () => Promise.resolve(), now: () => now,
      seekMedia: () => Promise.resolve(), executeManagedMediaEvent: () => Promise.resolve(),
      recordLog: (entry: Parameters<LinkDesktopApi['recordLog']>[0]) => Promise.resolve({ ...entry, id: 'log', sessionId: 'test', timestamp: '2026-11-10T00:00:00Z', monotonicMs: now }) }) });
  const requests = new NativeObsRequests(host, () => Promise.resolve());
  const emit = (patch: Partial<NativePlayerStatus>): NativePlayerStatus => {
    if (!audio) throw new Error('没有准备音频');
    const status: NativePlayerStatus = { ...audio, ...patch }; audio = status;
    host.observe(clockFromNativeStatus(status, (process.hrtime.bigint() / 100n).toString()));
    for (const listener of audioListeners) listener(status);
    return status;
  };
  const open = (): NativeProgramPlayer => new NativeProgramPlayer(project, path, 4, {
    prepare: () => Promise.resolve(), ingest: () => Promise.resolve(), pause: () => Promise.resolve(), stop: () => Promise.resolve(),
    resolveAudio: () => Promise.reject(new Error('原生播放不用音源地址')),
    configuration: () => ({ outputDeviceId: 'default', mtcPortName: 'TEST', audioSampleRate: 48000 }),
    changed: next => { state = next; }, notice: message => { notices.push(message); }, closedFault: message => { errors.push(message); }
  }, {
    prepareNativePlayback: request => {
      const { snapshot } = request;
      audio = { version: 1, sessionId: request.sessionId, generation: request.generation, itemId: snapshot.itemId, status: 'ready', positionMs: snapshot.positionMs,
        offsetMs: snapshot.offsetMs, sampleRate: snapshot.sampleRate, enginePid: 1, engineTitle: '测试', mtcPortName: request.midiPortName, mtcSent: 0,
        audioError: null, mtcError: null, underruns: 0, mtcInterruptions: 0, gain: snapshot.volume, analysis: null };
      return Promise.resolve(emit({}));
    },
    controlNativePlayback: command => {
      host.interrupt(command);
      const patch: Partial<NativePlayerStatus> = { generation: command.generation };
      if (command.kind === 'play') patch.status = 'playing'; else if (command.kind === 'pause') patch.status = 'paused'; else if (command.kind === 'stop') patch.status = 'stopped';
      return Promise.resolve(emit(patch));
    },
    getNativePlaybackDevices: () => Promise.resolve({ protocol: 4, audio: [], midiOutputs: [], midiInputs: [] }),
    onNativePlaybackStatus: listener => { audioListeners.add(listener); return () => { audioListeners.delete(listener); }; },
    prepareNativeObs: request => requests.prepare(request), stopNativeObs: request => requests.stop(request),
    onNativeObsStatus: listener => { obsListeners.add(listener); return () => { obsListeners.delete(listener); }; },
    preloadNativeObs: request => pool?.preload(request) ?? Promise.resolve(), cancelNativeObsPreload: request => pool?.cancel(request) ?? Promise.resolve()
  }, { change: () => Promise.resolve({ failed: [] }), stop: () => Promise.resolve({ failed: [] }), widen: () => undefined });
  /** The music plays on from `from` to `to` ms, one engine status every 20 ms. */
  const playTo = async (from: number, to: number): Promise<void> => {
    for (let at = from; at <= to; at += 20) { now = at; emit({ positionMs: at }); await new Promise(resolve => setTimeout(resolve, 0)); }
  };
  return { open, emit, playTo, errors, notices, state: () => state };
}

// 修复前：画面那边每次发状态都带着它的旧故障（节流后约每 50 毫秒一次），播放器每次都重新报一遍：之后动作 MIDI 断开、
// 时间码没发出的红字一闪就被顶回去，操作员看到的一直是画面那条。
it('画面动作失败后动作 MIDI 断开或时间码没发出：红字换成新的那条并一直显示，画面那边接着发状态也不顶回去', async () => {
  const t = rig(action => 'sceneName' in action && action.sceneName === '机位1' ? Promise.reject(new Error('OBS 无响应')) : Promise.resolve());
  const player = t.open();
  await player.play('song');
  expect(t.state().status).toBe('playing');
  await t.playTo(0, 1400);
  // 2026-11-10 第 2 题（R5）：OBS 拒绝的切换补一次；补了还不行，红字是到上限的那条。
  expect(t.state().fault).toBe('切换节目画面：这一项画面补发了一次还是没成功，到下一段会按时间线照常切换。请检查 OBS 里的这个场景或来源');
  // NativeProgramHost: the action MIDI port went away (NativeMidiHost fault → controller.reportFault).
  const midi = '动作 MIDI 接口「MA2」断开了，灯光动作没有发出';
  player.reportFault(midi);
  await t.playTo(1420, 1600);
  expect(t.state().fault).toBe(midi);
  const lost = 'Windows MIDI 输出失败（TEST）：接口已断开（错误码 6）；同一接口重新连接后自动恢复时间码';
  t.emit({ mtcError: lost });
  await t.playTo(1620, 1800);
  expect(t.state().fault).toBe(`时间码没有发出，音频照常播放。原因：${lost}`);
  await player.dispose();
});

// 2026-11-10 第 2 题（R5）：OBS 拒绝的切换按当时应有的画面补一次；补成了，这首歌上的红字和这一项一起收回。
it('画面切换被拒绝一次：补一次成功后，这首歌上的红字收回，画面按项的列表也清空；播放照常', async () => {
  let switches = 0;
  const t = rig(action => {
    if (!('sceneName' in action) || action.sceneName !== '机位1') return Promise.resolve();
    return ++switches === 1 ? Promise.reject(new Error('OBS 无响应')) : Promise.resolve();
  });
  const player = t.open();
  await player.play('song');
  const seen = new Set<string>();
  for (let at = 0; at <= 1400; at += 20) { await t.playTo(at, at); for (const item of t.state().pictureItems ?? []) seen.add(`${item.id}:${item.state}`); }
  expect(switches).toBe(2);
  // Listed in red while it waits for its repair; the repair that went through takes it off (the host's status may skip the moment between).
  expect(seen.has('program:failed')).toBe(true);
  expect(t.state()).toMatchObject({ status: 'playing', fault: null, pictureItems: [] });
  await player.dispose();
});

const open = (): NativeProgramOpen => ({ version: 1, ownerId: randomUUID(), projectPath: path, revision: 4, sessionId: randomUUID(), document: JSON.stringify(project),
  configuration: { outputDeviceId: 'default', mtcPortName: null, preciseSeeking: false } });

// 修复前：画面那边没收下这首歌的画面准备（它没看到这首歌的音频），节目关闭时停画面的请求就被它当成“上一次准备的”
// 拒绝，整个关闭算失败：之后再也开不了节目，也退不出软件。
it('画面那边没收下这首歌的画面准备：关闭节目时停画面被拒绝只记一次，关闭照常完成，之后照常开节目', async () => {
  let admit = false;
  const t = rig(() => Promise.resolve(), () => admit);
  const create = vi.fn(() => { const player = t.open(); return { controller: player, close: () => player.dispose() }; });
  const service = new NativeProgramService(create, vi.fn(), () => Promise.resolve(), () => undefined, closedProgramFaultReporter(() => Promise.resolve(), vi.fn()));
  const first = open();
  await service.open(first);
  await service.control({ version: 1, ownerId: first.ownerId, operation: { kind: 'play', itemId: 'song' } });
  expect(t.state()).toMatchObject({ status: 'playing', itemId: 'song' });
  await expect(service.control({ version: 1, ownerId: first.ownerId, operation: { kind: 'close' } })).resolves.toBeUndefined();
  expect(t.notices.filter(message => message.startsWith('关闭节目时'))).toEqual(['关闭节目时画面清理失败：这是上一次准备的停止请求，已忽略，当前节目不受影响']);
  admit = true;
  expect(await service.open(open())).toBe('opened');
  expect(await service.open(open())).toBe('opened');
  await expect(service.close()).resolves.toBeUndefined();
  expect(create).toHaveBeenCalledTimes(3);
});

// 修复前：节目关闭时清理选中歌曲提前准备的画面失败（OBS 卡住，批量请求 2 秒超时），整个关闭算失败：之后再也开不了
// 节目，也退不出软件。
it('关闭节目时提前准备的画面没清理干净（OBS 卡住）：报一次“不影响播放”，关闭照常完成，之后照常开节目、退出', async () => {
  const reported: string[] = [];
  const outputs = { guardOutput: <T>(_canSend: () => boolean, operation: () => Promise<T>) => operation(), preloadResources: () => Promise.resolve(),
    releaseOutputs: () => {
      // The stop batch times out (2 s): the OBS connection reports an error, and link-main closes the pool at once.
      void pool.close();
      return Promise.reject(new Error('画面没有清理干净：清理准备好的素材失败：OBS 素材场景批量控制 请求超时（2000 ms）；不确定是否已执行，请检查 OBS 后重新连接'));
    } } as Partial<NativeObsOutputs> as NativeObsOutputs;
  const pool: NativeObsPreloadPool = new NativeObsPreloadPool({ authorize: () => Promise.resolve(), create: () => outputs, report: failure => reported.push(failure.shown) });
  const t = rig(() => Promise.resolve(), () => true, pool);
  const create = vi.fn(() => { const player = t.open(); return { controller: player, close: () => player.dispose() }; });
  const service = new NativeProgramService(create, vi.fn(), () => Promise.resolve(), () => undefined, closedProgramFaultReporter(() => Promise.resolve(), vi.fn()));
  const first = open();
  await service.open(first);
  await service.control({ version: 1, ownerId: first.ownerId, operation: { kind: 'preload', itemId: 'song' } });
  // The preselected picture is ready.
  await new Promise(resolve => setTimeout(resolve, 10));
  await expect(service.control({ version: 1, ownerId: first.ownerId, operation: { kind: 'close' } })).resolves.toBeUndefined();
  expect(reported).toEqual(['提前准备的画面没有清理干净，不影响播放。原因：清理准备好的素材失败：OBS 素材场景批量控制 请求超时（2000 ms）；不确定是否已执行，请检查 OBS 后重新连接']);
  expect(await service.open(open())).toBe('opened');
  expect(await service.open(open())).toBe('opened');
  await expect(service.close()).resolves.toBeUndefined();
  expect(create).toHaveBeenCalledTimes(3); expect(reported).toHaveLength(1);
});
