import { expect, it, vi } from 'vitest';
import { clockFromNativeStatus, createObsProgramSnapshot, SceneOutputTimeline, type LinkDesktopApi, type ManagedMediaEvent } from '@tb/core/link';
import { createEmptyLinkProject, parseLinkProject, type LinkAction, type LinkProject, type NativeObsPrepare, type NativeObsStatus, type NativePlayerStatus } from '@tb/schema';
import { NativeObsHost } from './native-obs-host';
import { pictureMusicScenes, type NativeObsOutputs } from './native-obs-outputs';
import { ObsMediaPreload } from './obs-media-preload';
import type { ObsMediaScenes } from './obs-media-scenes';

/* 0.5.9 R9: a newer version of the held song's picture plan, taken by the main process at the current position. */

/** The song's cameras: one per second, named `${prefix}机位${second}`. */
function cameras(prefix = '', frameRate: '25' | '30' = '30'): LinkProject {
  return parseLinkProject({ ...createEmptyLinkProject('后台测试'), projectId: '0f2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5e', playbackSource: 'internal', obsOutputMode: 'scenes', timebase: { frameRate, mode: 'per-item-reset' },
    rundown: [{ id: 'song', title: 'song', cues: [0, 1].map(seconds => ({ id: `cue-${seconds}`, name: '机位',
      timecode: { hours: 0, minutes: 0, seconds, frames: 0 }, actions: [{ id: `scene-${seconds}`, kind: 'obs.setProgramScene', label: '切机位', sceneName: `${prefix}机位${seconds}` }] })) }] });
}

function setup(extra: Partial<NativeObsOutputs> = {}) {
  let audio: NativePlayerStatus = { version: 1, sessionId: '64f37673-7a65-4c81-b5b4-09c1b9f94cb3', generation: 1, itemId: 'song', status: 'ready',
    positionMs: 0, offsetMs: 480000, sampleRate: 48000, enginePid: 1, engineTitle: '测试', mtcPortName: null, mtcSent: 0,
    audioError: null, mtcError: null, underruns: 0, mtcInterruptions: 0, gain: 1, analysis: null };
  let now = 0;
  const execute = vi.fn<(action: LinkAction) => Promise<void>>(() => Promise.resolve()), failures: string[] = [], states: NativeObsStatus[] = [];
  const retargetOutputs = vi.fn<(project: LinkProject, frame: number) => Promise<void>>(() => Promise.resolve());
  const request: NativeObsPrepare = { version: 1, sessionId: audio.sessionId, generation: 1, preciseSeeking: false, projectPath: 'C:/shows/test.tblink', snapshot: createObsProgramSnapshot(cameras(), 'song', 4) };
  const host = new NativeObsHost({ audio: () => audio, changed: state => states.push(state), error: message => failures.push(message),
    outputs: () => ({ executor: { id: 'test', supports: () => true, execute },
      guardOutput: <T>(_canSend: () => boolean, operation: () => Promise<T>) => operation(),
      prepareOutputs: () => Promise.resolve(), holdOutputs: () => Promise.resolve(), releaseOutputs: () => Promise.resolve(),
      now: () => now, seekMedia: () => Promise.resolve(), executeManagedMediaEvent: () => Promise.resolve(), retargetOutputs,
      recordLog: (entry: Parameters<LinkDesktopApi['recordLog']>[0]) => Promise.resolve({ ...entry, id: 'log', sessionId: 'test', timestamp: '2026-11-12T00:00:00Z', monotonicMs: now }), ...extra }) });
  const observe = (patch: Partial<NativePlayerStatus>, time: number) => { now = time; audio = { ...audio, ...patch }; host.observe(clockFromNativeStatus(audio, (process.hrtime.bigint() / 100n).toString())); };
  const version = (project: LinkProject, revision: number) => ({ version: 1 as const, sessionId: audio.sessionId, revision, snapshot: createObsProgramSnapshot(project, 'song', revision) });
  const scenes = (): string[] => execute.mock.calls.flatMap(([action]) => action.kind === 'obs.setProgramScene' ? [action.sceneName] : []);
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  return { host, request, execute, retargetOutputs, failures, states, observe, version, scenes, settle, status: () => host.status };
}

it('播放中送来新的一版：画面会话按当前位置换成它，这一遍就用上；那一遍发出去才报“用上了”', async () => {
  const test = setup();
  await test.host.prepare(test.request);
  test.observe({ status: 'playing', generation: 2, positionMs: 0 }, 0);
  test.observe({ positionMs: 500 }, 500); await test.settle();
  expect(test.scenes()).toEqual(['机位0']);
  test.host.retarget(test.version(cameras('新'), 5));
  await vi.waitFor(() => expect(test.status()?.appliedRevision).toBe(5));
  expect(test.scenes()).toEqual(['机位0', '新机位0']);
  expect(test.retargetOutputs).toHaveBeenCalledOnce();
  expect(test.retargetOutputs.mock.calls[0]![1]).toBe(15);
  test.observe({ positionMs: 1500 }, 1500); await test.settle();
  expect(test.scenes()).toEqual(['机位0', '新机位0', '新机位1']);
  // An older version than the one taken is not taken.
  test.host.retarget(test.version(cameras('旧'), 4)); await test.settle();
  expect(test.scenes()).toEqual(['机位0', '新机位0', '新机位1']);
});

it('接不了的一版（改了帧率）：画面标红停在这里，写明原因，音乐照常；之后再送来的一版都不用', async () => {
  const test = setup();
  await test.host.prepare(test.request);
  test.observe({ status: 'playing', generation: 2, positionMs: 500 }, 500); await test.settle();
  test.host.retarget(test.version(cameras('新', '25'), 5));
  expect(test.status()).toMatchObject({ state: 'failed', reason: '这次修改的画面用不上：这次修改改了工程的帧率，正在播的歌不能中途换过去。音乐和时间码照常，这首歌停下重播时按新的样子放' });
  test.host.retarget(test.version(cameras('再新'), 6)); await test.settle();
  expect(test.scenes()).toEqual(['机位0']);
  expect(test.retargetOutputs).not.toHaveBeenCalled();
});

it('不是正在放的这首歌的一版：拒绝，说清楚；画面照旧', async () => {
  const test = setup();
  await test.host.prepare(test.request);
  expect(() => test.host.retarget({ ...test.version(cameras('新'), 5), sessionId: crypto.randomUUID() })).toThrow('不是正在放的这首歌的');
  expect(test.status()?.appliedRevision).toBeUndefined();
});

it('还没开始放：新的一版马上算用上，音乐一开始就按它切', async () => {
  const test = setup();
  await test.host.prepare(test.request);
  test.host.retarget(test.version(cameras('新'), 5));
  await vi.waitFor(() => expect(test.status()?.appliedRevision).toBe(5));
  test.observe({ status: 'playing', generation: 2, positionMs: 0 }, 0); await test.settle();
  expect(test.scenes()).toEqual(['新机位0']);
});

/* Our music item in the scenes a newer plan brings (coordinator's answer (a), narrow). */

function musicSetup(add: (sceneName: string, tier: 'program' | 'background') => Promise<boolean>) {
  const order: string[] = [], notices: string[] = [], logs: Array<{ level: string; message: string }> = [];
  const addMusicToScene = vi.fn<(sceneName: string, tier: 'program' | 'background') => Promise<boolean>>(async (sceneName, tier) => {
    order.push(`加 ${sceneName}（${tier}）`); return add(sceneName, tier);
  });
  const carried = new Set(['机位0']);
  const music = pictureMusicScenes({ addMusicToScene }, { record: entry => { logs.push({ level: entry.level, message: entry.message }); return Promise.resolve({ ...entry, id: 'log', sessionId: 'test', timestamp: '2026-11-12T00:00:00Z', monotonicMs: 0 }); },
    projectId: 'project', itemId: 'song' }, carried, notice => { notices.push(notice); });
  return { music, order, notices, logs, addMusicToScene, carried };
}

it('新的一版用到新场景：现在要切的那个先加好音乐（切画面那一档）再切；以后才用的在后台加；歌已经有的场景不碰；加好记一行', async () => {
  let finish: () => void = () => { throw new Error('还没开始加'); };
  const test = musicSetup((sceneName, tier) => tier === 'program' ? new Promise<boolean>(resolve => { finish = () => resolve(true); }) : Promise.resolve(sceneName !== '开着的'));
  let done = false;
  const adding = test.music(['机位0', '后来的', '现在的', '开着的'], '现在的').then(() => { done = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(test.order).toEqual(['加 后来的（background）', '加 开着的（background）', '加 现在的（program）']);
  // The switch waits for the scene due now.
  expect(done).toBe(false);
  finish(); await adding;
  expect(test.logs).toEqual([{ level: 'info', message: '这次修改用到的场景「后来的」加上了联动台的音乐' }, { level: 'info', message: '这次修改用到的场景「现在的」加上了联动台的音乐' }]);
  // Once each: the next version asks for none of them again.
  await test.music(['机位0', '后来的', '现在的', '开着的'], '后来的');
  expect(test.addMusicToScene).toHaveBeenCalledTimes(3);
  expect(test.notices).toEqual([]);
});

it('场景加不上音乐：照常往下切，记一行、给一条提醒（先说怎么了再说怎么办），不重试；音乐走桌面音频时什么都不记', async () => {
  const test = musicSetup(() => Promise.reject(new Error('OBS 拒绝了')));
  await expect(test.music(['现在的'], '现在的')).resolves.toBeUndefined();
  const text = 'OBS 场景「现在的」没能加上联动台的音乐：OBS 拒绝了。画面照常切过去，切到这个场景时观众可能听不到歌，请在 OBS 里把「团播联动台·内部正式音频」加进这个场景。';
  expect(test.notices).toEqual([text]);
  expect(test.logs).toEqual([{ level: 'warning', message: text }]);
  await test.music(['现在的'], '现在的');
  expect(test.addMusicToScene).toHaveBeenCalledOnce();
  const desktop = musicSetup(() => Promise.resolve(false));
  await desktop.music(['新的'], '新的');
  expect(desktop.logs).toEqual([]); expect(desktop.notices).toEqual([]);
});

/* The preload's part: a decoder the edit does not concern stays prepared; a new material's clips wait until it is. */

function videos(clips: ReadonlyArray<readonly [string, number, string]>): LinkProject {
  return parseLinkProject({ ...createEmptyLinkProject('预备'), projectId: '0f2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', playbackSource: 'internal', obsOutputMode: 'scenes',
    mediaAssets: ['video', 'other'].map(id => ({ id, name: id, kind: 'video' as const, relativePath: `assets/${id}.mp4`, sha256: (id === 'video' ? 'a' : 'b').repeat(64), byteLength: 1, durationMs: 60000, width: 1920, height: 1080 })),
    rundown: [{ id: 'song', title: '歌曲', visualLayers: [{ id: 'video-layer', name: '视频' }],
      referenceMediaClips: clips.map(([id, seconds, assetId]) => ({ id, assetId, layerId: 'video-layer', label: id,
        startTimecode: { hours: 0, minutes: 0, seconds, frames: 0 }, durationMs: 5000, sourceOffsetMs: 0 })) }] });
}
function mockScenes() {
  return { prepareStandby: vi.fn<ObsMediaScenes['prepareStandby']>(name => Promise.resolve(`${name}·预备`)),
    copyPresentation: vi.fn<ObsMediaScenes['copyPresentation']>(() => Promise.resolve()),
    prime: vi.fn<ObsMediaScenes['prime']>(async (_event, _path, run) => { await run(); }),
    execute: vi.fn<ObsMediaScenes['execute']>(() => Promise.resolve()), seek: vi.fn<ObsMediaScenes['seek']>(() => Promise.resolve(null)),
    isActive: vi.fn<ObsMediaScenes['isActive']>(() => false), continueClip: vi.fn<ObsMediaScenes['continueClip']>(() => false) };
}

it('改了别的片段：已经准备好的下一段不重新准备；换了素材的那段等新素材准备好，准备不了的算失败、不等', async () => {
  const before = videos([['a', 0, 'video'], ['b', 5, 'video']]), after = videos([['a', 0, 'video'], ['b', 5, 'video'], ['c', 10, 'other']]);
  const scenes = mockScenes(), native = { prime: vi.fn(() => Promise.resolve()), seek: vi.fn(() => Promise.resolve()) };
  const preload = new ObsMediaPreload(before, 'song', scenes, native), current = (): void => undefined;
  preload.register(before.projectId, before.mediaAssets[0]!, 'C:/shows/assets/video.mp4');
  const events = new SceneOutputTimeline(before, 'song').preloadEntries();
  await preload.prime(events[0]!, current); await preload.primeFollowing(events[0]!, current);
  const primed = scenes.prime.mock.calls.length;
  preload.retarget(after, 'song');
  const start = (clipId: string): ManagedMediaEvent => new SceneOutputTimeline(after, 'song').preloadEntries().find(event => event.clipId === clipId)!;
  expect(preload.clipState(start('a'))).toBe('ready');
  expect(preload.clipState(start('c'))).toBe('preparing');
  // The lookahead does not reach a material that is not registered yet.
  await preload.upcoming(Math.round(9 * 30), current);
  expect(scenes.prime.mock.calls.length).toBe(primed);
  preload.unavailableMaterial(start('c').sourceName, '素材文件读不了：other');
  expect(preload.clipState(start('c'))).toBe('failed');
});
