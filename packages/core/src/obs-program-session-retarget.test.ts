import { describe, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type LinkAction, type LinkProject } from '@tb/schema';
import { MediaPreparationFailed, ObsProgramSession, type ObsProgramSessionDependencies } from './obs-program-session';
import type { ManagedMediaEvent } from './managed-media-timeline';
import type { LinkDesktopApi } from './link-desktop-contract';
import type { PictureReading } from './picture-follow';

/** 0.5.9 R9: a newer plan of the song on air takes effect in this pass (2026-11-10 decision 1, “这一遍立即生效”). */

const at = (seconds: number) => ({ hours: 0, minutes: 0, seconds, frames: 0 });
type CueInput = { id: string; name: string; timecode: ReturnType<typeof at>; actions: LinkAction[]; layerId?: string; durationMs?: number };
const camera = (seconds: number, scene = `场景 ${seconds}`): CueInput => ({ id: `cue-${seconds}`, name: `机位 ${seconds}`, timecode: at(seconds),
  actions: [{ id: `action-${seconds}`, kind: 'obs.setProgramScene', label: '切机位', sceneName: scene }] });
const hide = (id: string, seconds: number): CueInput => ({ id, name: id, timecode: at(seconds),
  actions: [{ id: `${id}-action`, kind: 'obs.setSceneItemEnabled', label: id, sceneName: '场景 0', sourceName: id, enabled: false }] });
function cameras(cues: CueInput[] = [0, 1, 2, 3].map(seconds => camera(seconds))): LinkProject {
  return parseLinkProject({ ...createEmptyLinkProject('后台画面'), playbackSource: 'internal', obsOutputMode: 'scenes',
    rundown: [{ id: 'song', title: '歌曲', cues }] });
}
const asset = (id: string) => ({ id, name: id, kind: 'video' as const, relativePath: `assets/${id}.mp4`, sha256: (id === 'video' ? 'a' : 'b').repeat(64), byteLength: 1, durationMs: 20000, width: 1920, height: 1080 });
/** One project id for every version: the materials' OBS names come from it. */
const base = createEmptyLinkProject('视频');
function video(clip: { assetId?: string; startSeconds?: number; durationMs?: number } | null = {}): LinkProject {
  return parseLinkProject({ ...base, playbackSource: 'internal', obsOutputMode: 'scenes',
    mediaAssets: [asset('video'), asset('other')],
    rundown: [{ id: 'song', title: '歌曲', visualLayers: [{ id: 'video-layer', name: '视频' }], cues: [],
      referenceMediaClips: clip ? [{ id: 'clip', assetId: clip.assetId ?? 'video', layerId: 'video-layer', label: '视频',
        startTimecode: at(clip.startSeconds ?? 0), durationMs: clip.durationMs ?? 10000 }] : [] }] });
}

type ClipInput = { id: string; assetId: string; layerId: string; startSeconds: number; durationMs: number; startFrames?: number; sourceOffsetMs?: number };
/** Clips on two layers, `top` over `bottom` (visualLayers[0] is the top one). */
function layered(clips: ClipInput[]): LinkProject {
  return parseLinkProject({ ...base, playbackSource: 'internal', obsOutputMode: 'scenes',
    mediaAssets: [asset('video'), asset('other')],
    rundown: [{ id: 'song', title: '歌曲', visualLayers: [{ id: 'top', name: '上层' }, { id: 'bottom', name: '下层' }], cues: [],
      referenceMediaClips: clips.map(clip => ({ id: clip.id, assetId: clip.assetId, layerId: clip.layerId, label: clip.id,
        startTimecode: { ...at(clip.startSeconds), frames: clip.startFrames ?? 0 }, durationMs: clip.durationMs,
        ...clip.sourceOffsetMs === undefined ? {} : { sourceOffsetMs: clip.sourceOffsetMs } })) }] });
}
const isOther = (event: ManagedMediaEvent): boolean => event.sourceName.includes('other') || event.assetName === 'other';

function setup(project: LinkProject, extra: Partial<ObsProgramSessionDependencies> = {}, execute?: (action: LinkAction) => Promise<void>) {
  let now = 0, online = true;
  const actions: LinkAction[] = [], faults: string[] = [], applied: number[] = [];
  const media = vi.fn<LinkDesktopApi['executeManagedMediaEvent']>(() => Promise.resolve());
  const dependencies: ObsProgramSessionDependencies = { now: () => now, fault: message => { faults.push(message); },
    recordLog: vi.fn<LinkDesktopApi['recordLog']>(entry => Promise.resolve({ ...entry, id: 'log', sessionId: 'test', timestamp: '2026-11-12T00:00:00Z', monotonicMs: now })),
    executeManagedMediaEvent: media, guardOutput: (_canSend, operation) => operation(),
    prepareOutputs: () => Promise.resolve(), holdOutputs: () => Promise.resolve(), releaseOutputs: () => Promise.resolve(),
    seekMedia: vi.fn<ObsProgramSessionDependencies['seekMedia']>(() => Promise.resolve()), mediaReport: () => undefined, cueReport: () => undefined,
    state: () => undefined, connected: () => online, pictureApplied: revision => { applied.push(revision); },
    executor: { id: 'obs-test', supports: action => action.kind.startsWith('obs.'), execute: async action => { actions.push(action); await execute?.(action); } },
    ...extra };
  const session = new ObsProgramSession(project, 'C:/shows/test.tblink', 'song', dependencies);
  const advance = async (from: number, through: number) => {
    for (let time = from; time <= through; time += 100) { now = time; session.clock(time); await session.settled(); }
  };
  const scenes = () => actions.filter(action => action.kind === 'obs.setProgramScene').map(action => 'sceneName' in action ? action.sceneName : '');
  const mediaSteps = () => media.mock.calls.map(([payload]) => `${payload.event.phase}:${payload.event.sourceName.includes('other') ? 'other' : 'video'}`);
  const transports = () => actions.flatMap(action => action.kind === 'obs.mediaAction' ? [`${action.action}:${action.inputName.includes('other') ? 'other' : 'video'}`] : []);
  return { session, actions, faults, applied, media, dependencies, advance, scenes, mediaSteps, transports, offline: (value: boolean) => { online = !value; },
    at: (time: number) => { now = time; } };
}
const sameNow = (test: ReturnType<typeof setup>) => test.actions.length + test.media.mock.calls.length;

describe('R9 播放中改画面这一遍立即生效（2026-11-10 第 1 题）', () => {
  it('改了下一个机位：到点按新的切；改动不碰此刻的画面时一个请求也不发', async () => {
    const test = setup(cameras());
    await test.session.prepare(0); await test.advance(0, 500);
    const before = sameNow(test);
    test.session.retarget(cameras([camera(0), camera(1, '新机位'), camera(2), camera(3)]), 2); await test.session.settled();
    expect(sameNow(test)).toBe(before);
    expect(test.applied).toEqual([2]);
    await test.advance(600, 2100);
    expect(test.scenes()).toEqual(['场景 0', '新机位', '场景 2']);
  });

  it('改了此刻的机位：马上切过去，过去的切换不重放', async () => {
    const test = setup(cameras());
    await test.session.prepare(0); await test.advance(0, 1500);
    test.session.retarget(cameras([camera(0, '新机位 0'), camera(1, '新机位 1'), camera(2), camera(3)]), 2); await test.session.settled();
    expect(test.scenes()).toEqual(['场景 0', '场景 1', '新机位 1']);
  });

  it('正在播的素材被删掉：马上停；换成别的素材：旧的停、新的按当前位置开始', async () => {
    const deleted = setup(video());
    await deleted.session.prepare(0); await deleted.advance(0, 2000);
    deleted.session.retarget(video(null), 2); await deleted.session.settled();
    expect(deleted.mediaSteps()).toEqual(['start:video', 'stop:video']);
    expect(deleted.applied).toEqual([2]);

    const replaced = setup(video());
    await replaced.session.prepare(0); await replaced.advance(0, 2000);
    replaced.session.retarget(video({ assetId: 'other' }), 3); await replaced.session.settled();
    expect(replaced.mediaSteps()).toEqual(['start:video', 'stop:video', 'start:other']);
    expect(replaced.media.mock.calls[2]![0].event.sourceOffsetMs).toBeGreaterThanOrEqual(2000);
  });

  it('正在播的素材挪了位置：在原解码器上按新位置对齐，不重新开始；挪不到一帧不动', async () => {
    const moveMedia = vi.fn<NonNullable<ObsProgramSessionDependencies['moveMedia']>>(() => Promise.resolve());
    const test = setup(video(), { moveMedia });
    await test.session.prepare(0); await test.advance(0, 2000);
    test.session.retarget(video({ startSeconds: 1, durationMs: 10000 }), 2); await test.session.settled();
    expect(moveMedia).toHaveBeenCalledOnce();
    expect(moveMedia.mock.calls[0]![0]).toMatchObject({ clipId: 'clip', sourceOffsetMs: 1000 });
    expect(test.mediaSteps()).toEqual(['start:video']);
    // Trimmed at its end only: in the same place, nothing to move.
    test.session.retarget(video({ startSeconds: 1, durationMs: 8000 }), 3); await test.session.settled();
    expect(moveMedia).toHaveBeenCalledOnce();
    expect(test.applied).toEqual([2, 3]);
  });

  it('暂停时改：马上按新的对好，素材定位后保持暂停；继续以后按新的走', async () => {
    const test = setup(cameras());
    await test.session.prepare(0); await test.advance(0, 1500); await test.session.pause();
    test.session.retarget(cameras([camera(0), camera(1, '新机位 1'), camera(2, '新机位 2'), camera(3)]), 2); await test.session.settled();
    expect(test.scenes()).toEqual(['场景 0', '场景 1', '新机位 1']);
    expect(test.applied).toEqual([2]);
    await test.advance(1600, 2100);
    expect(test.scenes()).toEqual(['场景 0', '场景 1', '新机位 1', '新机位 2']);

    const clip = setup(video());
    await clip.session.prepare(0); await clip.advance(0, 2000); await clip.session.pause();
    clip.session.retarget(video({ startSeconds: 1 }), 2); await clip.session.settled();
    // Located at its new place and still paused: no start, no play.
    expect(clip.dependencies.seekMedia).toHaveBeenCalledOnce();
    expect(vi.mocked(clip.dependencies.seekMedia).mock.calls[0]![0]).toMatchObject({ clipId: 'clip', sourceOffsetMs: 1000 });
    expect(clip.mediaSteps()).toEqual(['start:video']);
    // Only the song's own pause went to the decoder: nothing played it.
    expect(clip.actions.filter(action => action.kind === 'obs.mediaAction').map(action => action.label)).toHaveLength(1);
  });

  it('点 Cue：挪到播放头前面的不补；还没发的挪到后面到点发；已经发过的挪到后面不再发（同动作 MIDI）', async () => {
    const hides = (sent: number, ahead: number, moved: number) => cameras([camera(0), hide('sent', sent), hide('ahead', ahead), hide('moved', moved)]);
    const test = setup(hides(1, 3, 4));
    await test.session.prepare(0); await test.advance(0, 2000);
    const sent = () => test.actions.filter(action => action.kind === 'obs.setSceneItemEnabled').map(action => action.label);
    expect(sent()).toEqual(['sent']);
    test.session.retarget(hides(3, 1, 5), 2); await test.session.settled();
    await test.advance(2100, 6000);
    expect(sent()).toEqual(['sent', 'moved']);
  });

  it('新素材在准备：这一部分等着，画面照旧；准备好了按当前位置换上', async () => {
    let ready: 'ready' | 'preparing' = 'preparing';
    const prepareUpcoming = vi.fn<NonNullable<ObsProgramSessionDependencies['prepareUpcoming']>>(() => Promise.resolve(null));
    const test = setup(video(), { clipReady: () => ready, prepareUpcoming });
    await test.session.prepare(0); await test.advance(0, 2000);
    test.session.retarget(video({ assetId: 'other' }), 2); await test.session.settled();
    expect(test.mediaSteps()).toEqual(['start:video']);
    expect(test.applied).toEqual([2]);
    ready = 'ready';
    prepareUpcoming.mockImplementationOnce(() => Promise.resolve({ clipId: 'clip' } as ManagedMediaEvent));
    await test.advance(2100, 2300);
    await vi.waitFor(() => expect(test.mediaSteps()).toEqual(['start:video', 'stop:video', 'start:other']));
  });

  it('OBS 回应很慢时连改十次：同一时间最多一遍在路上，最后一次的赢', async () => {
    let release: () => void = () => undefined;
    let slow = false;
    const test = setup(cameras(), {}, action => slow && action.kind === 'obs.setProgramScene' ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve());
    await test.session.prepare(0); await test.advance(0, 500);
    slow = true;
    test.session.retarget(cameras([camera(0, '改 1'), camera(1), camera(2), camera(3)]), 2);
    await vi.waitFor(() => expect(test.scenes()).toEqual(['场景 0', '改 1']));
    for (let edit = 2; edit <= 10; edit++) test.session.retarget(cameras([camera(0, `改 ${edit}`), camera(1), camera(2), camera(3)]), edit + 1);
    slow = false; release(); await test.session.settled();
    expect(test.scenes()).toEqual(['场景 0', '改 1', '改 10']);
    expect(test.applied).toEqual([2, 11]);
  });

  it('OBS 断着时改：换了计划、什么都不发；重新连上恢复画面时按最新的', async () => {
    const test = setup(cameras());
    await test.session.prepare(0); await test.advance(0, 500);
    test.offline(true);
    test.session.retarget(cameras([camera(0, '新机位'), camera(1), camera(2), camera(3)]), 2); await test.session.settled();
    expect(test.scenes()).toEqual(['场景 0']);
    expect(test.applied).toEqual([]);
    test.offline(false);
    await test.session.recover(() => Promise.resolve());
    expect(test.scenes()).toEqual(['场景 0', '新机位']);
    expect(test.applied).toEqual([2]);
  });

  it('被手动接管时：播放头上要的场景没变就保持接管；变了就切过去、接管结束', async () => {
    const test = setup(cameras());
    await test.session.prepare(0); await test.advance(0, 500);
    test.session.programSceneChanged('手动场景');
    test.session.retarget(cameras([camera(0), camera(1), camera(2, '新机位 2'), camera(3)]), 2); await test.session.settled();
    expect(test.scenes()).toEqual(['场景 0']);
    test.session.retarget(cameras([camera(0, '新机位 0'), camera(1), camera(2, '新机位 2'), camera(3)]), 3); await test.session.settled();
    expect(test.scenes()).toEqual(['场景 0', '新机位 0']);
    test.session.programSceneChanged('新机位 0');
    await test.advance(600, 1100);
    expect(test.scenes()).toEqual(['场景 0', '新机位 0', '场景 1']);
  });

  it('接不了的一版：说明原因、什么都不换；帧率变了也一样', () => {
    const test = setup(cameras());
    const midi = cameras([{ ...camera(0), actions: [{ id: 'midi', kind: 'midi.programChange', label: 'PC', portProfileId: 'out', channel: 1, program: 1 }] }]);
    expect(() => test.session.retarget(midi, 2)).toThrow('后台画面快照含非 OBS 动作');
    expect(() => test.session.retarget({ ...cameras(), timebase: { ...cameras().timebase, frameRate: '25' } }, 2)).toThrow('帧率');
    expect(test.applied).toEqual([]);
  });

  it('改之前发出、改之后才回来的读回不按新的一版判断；下一次读回照常', async () => {
    const answers: Array<(reading: PictureReading) => void> = [], follows: string[] = [];
    const test = setup(cameras(), {
      readPicture: () => new Promise<PictureReading>(resolve => { answers.push(resolve); }),
      pictureFollow: follow => { follows.push(follow.state); } });
    await test.session.prepare(0); await test.advance(0, 1500);
    expect(answers.length).toBeGreaterThan(0);
    test.session.retarget(cameras([camera(0), camera(1), camera(2, '新机位'), camera(3)]), 2); await test.session.settled();
    for (const answer of answers.splice(0)) answer({ kind: 'unreadable', reason: 'OBS 没有回应' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(follows).toEqual([]);
    await test.advance(1600, 3000);
    for (const answer of answers.splice(0)) answer({ kind: 'unreadable', reason: 'OBS 没有回应' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(follows).toEqual(['unknown']);
  });
});

describe('R9 第二轮：没在走的时候改、改到一半被打断、改不了的一版', () => {
  it('在某个位置准备好、还没开始播（拖动或暂停时定位）：改此刻的机位马上切，第一次走时间照常往下', async () => {
    const test = setup(cameras());
    await test.session.prepare(1500);
    expect(test.scenes()).toEqual(['场景 1']);
    test.session.retarget(cameras([camera(0), camera(1, '新机位 1'), camera(2), camera(3)]), 2); await test.session.settled();
    expect(test.scenes()).toEqual(['场景 1', '新机位 1']);
    expect(test.applied).toEqual([2]);
    await test.advance(1600, 2100);
    expect(test.scenes()).toEqual(['场景 1', '新机位 1', '场景 2']);
  });

  it('从头准备好、还没开始播：新的一版先交给输出（新素材、新场景的音乐），再算用上', async () => {
    const retargetOutputs = vi.fn<NonNullable<ObsProgramSessionDependencies['retargetOutputs']>>(() => Promise.resolve());
    const test = setup(cameras(), { retargetOutputs });
    await test.session.prepare(0);
    test.session.retarget(cameras([camera(0, '新机位 0'), camera(1), camera(2), camera(3)]), 2); await test.session.settled();
    expect(retargetOutputs).toHaveBeenCalledOnce();
    expect(retargetOutputs.mock.calls[0]![1]).toBe(0);
    expect(test.applied).toEqual([2]);
    expect(test.scenes()).toEqual([]);
  });

  it('在某个位置准备好、还没开始播：在画面上的素材挪了马上重新定位，删了马上停；第一次走时间不重开，之后暂停每个解码器都停', async () => {
    const moved = setup(video());
    await moved.session.prepare(1500);
    expect(moved.dependencies.seekMedia).toHaveBeenCalledOnce();
    moved.session.retarget(video({ startSeconds: 1 }), 2); await moved.session.settled();
    expect(moved.dependencies.seekMedia).toHaveBeenCalledTimes(2);
    expect(vi.mocked(moved.dependencies.seekMedia).mock.calls[1]![0]).toMatchObject({ clipId: 'clip', sourceOffsetMs: 500 });
    expect(moved.applied).toEqual([2]);
    await moved.advance(1600, 2000);
    expect(moved.mediaSteps()).toEqual([]);
    await moved.session.pause();
    expect(moved.transports()).toEqual(['pause:video']);

    const deleted = setup(video());
    await deleted.session.prepare(1500);
    deleted.session.retarget(video(null), 2); await deleted.session.settled();
    expect(deleted.mediaSteps()).toEqual(['stop:video']);
    expect(deleted.applied).toEqual([2]);
  });

  it('暂停时换上新素材：马上开始准备，准备好了就按当前位置放上、保持暂停，不等走时间；继续以后跟着放', async () => {
    let other: 'ready' | 'preparing' = 'preparing';
    const prepareUpcoming = vi.fn<NonNullable<ObsProgramSessionDependencies['prepareUpcoming']>>(() => Promise.resolve(null));
    const test = setup(video(), { clipReady: event => isOther(event) ? other : 'ready', prepareUpcoming });
    await test.session.prepare(0); await test.advance(0, 2000); await test.session.pause();
    const before = prepareUpcoming.mock.calls.length;
    prepareUpcoming.mockImplementationOnce(() => { other = 'ready'; return Promise.resolve({ clipId: 'clip', sourceName: 'other' } as ManagedMediaEvent); });
    test.session.retarget(video({ assetId: 'other' }), 2);
    await vi.waitFor(() => expect(test.mediaSteps()).toEqual(['start:video', 'stop:video']));
    await test.session.settled();
    // Prepared without a clock, without the spacing of a playing song.
    expect(prepareUpcoming.mock.calls.slice(before).map(call => call[2])).toEqual([false]);
    const seeks = vi.mocked(test.dependencies.seekMedia).mock.calls.map(call => call[0]);
    expect(seeks.filter(isOther)).toHaveLength(1);
    expect(test.transports()).toEqual(['pause:video']);
    await test.advance(2100, 2300);
    expect(test.transports()).toEqual(['pause:video', 'start:other']);
  });

  it('暂停时连改两次、第一次的素材还在准备：它准备完（这一段已经又改了）以后，接着准备第二次要的，不等走时间', async () => {
    let other: 'ready' | 'preparing' = 'preparing';
    let finish: (prepared: ManagedMediaEvent | null) => void = () => undefined;
    const prepareUpcoming = vi.fn<NonNullable<ObsProgramSessionDependencies['prepareUpcoming']>>(() => Promise.resolve(null));
    const test = setup(video(), { clipReady: event => isOther(event) ? other : 'ready', prepareUpcoming });
    await test.session.prepare(0); await test.advance(0, 2000); await test.session.pause();
    const before = prepareUpcoming.mock.calls.length;
    // The first edit's preparation stays in flight.
    prepareUpcoming.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    test.session.retarget(video({ assetId: 'other' }), 2);
    await vi.waitFor(() => expect(prepareUpcoming.mock.calls.length).toBe(before + 1));
    // The second edit puts the clip elsewhere in its file: what is in flight is no longer what the plan has there.
    test.session.retarget(video({ assetId: 'other', durationMs: 9000 }), 3);
    await test.session.settled();
    expect(prepareUpcoming.mock.calls.length).toBe(before + 1);
    // It ends with nothing prepared for this plan: the held song asks again, now for what the plan has.
    prepareUpcoming.mockImplementationOnce(() => { other = 'ready'; return Promise.resolve({ clipId: 'clip', sourceName: 'other' } as ManagedMediaEvent); });
    finish(null);
    await vi.waitFor(() => expect(prepareUpcoming.mock.calls.length).toBe(before + 2));
    expect(prepareUpcoming.mock.calls.slice(before).map(call => call[2])).toEqual([false, false]);
    await vi.waitFor(() => expect(vi.mocked(test.dependencies.seekMedia).mock.calls.map(call => call[0]).filter(isOther)).toHaveLength(1));
    // Nothing more to prepare: it does not keep asking.
    await test.session.settled();
    expect(prepareUpcoming.mock.calls.length).toBe(before + 2);
  });

  it('暂停时换上的新素材准备失败：这一部分标红', async () => {
    const prepareUpcoming = vi.fn<NonNullable<ObsProgramSessionDependencies['prepareUpcoming']>>(() => Promise.resolve(null));
    let other: 'failed' | 'preparing' = 'preparing';
    const test = setup(video(), { clipReady: event => isOther(event) ? other : 'ready', prepareUpcoming });
    await test.session.prepare(0); await test.advance(0, 2000); await test.session.pause();
    prepareUpcoming.mockImplementationOnce(() => { other = 'failed'; return Promise.reject(new MediaPreparationFailed({ clipId: 'clip', assetName: 'other', sourceName: 'other' } as ManagedMediaEvent, '解码不了')); });
    test.session.retarget(video({ assetId: 'other' }), 2);
    await vi.waitFor(() => expect(test.faults.some(fault => fault.includes('解码不了'))).toBe(true));
  });

  it('暂停时换了正在播的素材、新的还在准备时按继续：原来的画面跟着音乐继续，再暂停跟着停', async () => {
    const test = setup(video(), { clipReady: event => isOther(event) ? 'preparing' : 'ready', prepareUpcoming: () => Promise.resolve(null) });
    await test.session.prepare(0); await test.advance(0, 2000); await test.session.pause();
    test.session.retarget(video({ assetId: 'other' }), 2); await test.session.settled();
    expect(test.mediaSteps()).toEqual(['start:video']);
    await test.advance(2100, 2300);
    expect(test.transports()).toEqual(['pause:video', 'start:video']);
    await test.session.pause();
    expect(test.transports()).toEqual(['pause:video', 'start:video', 'pause:video']);
  });

  it('等新素材准备时，只留着这次修改拿掉的画面；按计划到点结束的照常停', async () => {
    const plan = layered([{ id: 'below', assetId: 'video', layerId: 'bottom', startSeconds: 0, durationMs: 3000 }]);
    const test = setup(plan, { clipReady: event => isOther(event) ? 'preparing' : 'ready', prepareUpcoming: () => Promise.resolve(null) });
    await test.session.prepare(0); await test.advance(0, 2000);
    test.session.retarget(layered([{ id: 'below', assetId: 'video', layerId: 'bottom', startSeconds: 0, durationMs: 3000 },
      { id: 'new', assetId: 'other', layerId: 'top', startSeconds: 0, durationMs: 10000 }]), 2); await test.session.settled();
    await test.advance(2100, 3500);
    expect(test.mediaSteps()).toEqual(['start:video', 'stop:video']);
  });

  it('在画面上的素材删了：下面那层露出来', async () => {
    const both = layered([{ id: 'clip', assetId: 'video', layerId: 'top', startSeconds: 0, durationMs: 10000 },
      { id: 'below', assetId: 'other', layerId: 'bottom', startSeconds: 0, durationMs: 10000 }]);
    const test = setup(both);
    await test.session.prepare(0); await test.advance(0, 2000);
    const before = test.mediaSteps().length;
    test.session.retarget(layered([{ id: 'below', assetId: 'other', layerId: 'bottom', startSeconds: 0, durationMs: 10000 }]), 2); await test.session.settled();
    expect(test.mediaSteps().slice(before)).toContain('stop:video');
    expect(test.mediaSteps()).not.toContain('stop:other');
    // The clip below is what the picture is now: its own scene is on program.
    expect(test.scenes().at(-1)).toContain(test.media.mock.calls.find(([payload]) => isOther(payload.event))![0].event.sceneName);
  });

  it('暂停时修剪在画面上的素材：开头剪掉（位置不变）不重新定位；挪了一帧就重新定位', async () => {
    const test = setup(video());
    await test.session.prepare(0); await test.advance(0, 2000); await test.session.pause();
    const seeks = () => vi.mocked(test.dependencies.seekMedia).mock.calls.length;
    test.session.retarget(layered([{ id: 'clip', assetId: 'video', layerId: 'top', startSeconds: 1, durationMs: 9000, sourceOffsetMs: 1000 }]), 2);
    await test.session.settled();
    expect(seeks()).toBe(0);
    test.session.retarget(layered([{ id: 'clip', assetId: 'video', layerId: 'top', startSeconds: 1, startFrames: 1, durationMs: 9000, sourceOffsetMs: 1000 }]), 3);
    await test.session.settled();
    expect(seeks()).toBe(1);
    expect(test.applied).toEqual([2, 3]);
  });

  it('改到一半按了暂停：挪动没做完的照样做，按暂停以后的样子重新来一遍', async () => {
    let release: () => void = () => undefined;
    const moveMedia = vi.fn<NonNullable<ObsProgramSessionDependencies['moveMedia']>>(() => new Promise<void>(resolve => { release = resolve; }));
    const test = setup(video(), { moveMedia });
    await test.session.prepare(0); await test.advance(0, 2000);
    test.session.retarget(video({ startSeconds: 1 }), 2);
    await vi.waitFor(() => expect(moveMedia).toHaveBeenCalledOnce());
    const pausing = test.session.pause();
    release(); await pausing; await test.session.settled();
    // Paused at its new place, by the pass that ran again for the pause.
    expect(vi.mocked(test.dependencies.seekMedia).mock.calls.map(call => call[0])).toMatchObject([{ clipId: 'clip', sourceOffsetMs: 1000 }]);
    expect(test.applied).toEqual([2]);
  });

  it('暂停时改到一半按了继续：没做完的挪动按继续以后的样子做', async () => {
    let release: () => void = () => undefined;
    const moveMedia = vi.fn<NonNullable<ObsProgramSessionDependencies['moveMedia']>>(() => Promise.resolve());
    const test = setup(video(), { moveMedia });
    await test.session.prepare(0); await test.advance(0, 2000); await test.session.pause();
    vi.mocked(test.dependencies.seekMedia).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    test.session.retarget(video({ startSeconds: 1 }), 2);
    await vi.waitFor(() => expect(test.dependencies.seekMedia).toHaveBeenCalledOnce());
    test.at(2100); test.session.clock(2100);
    release(); await test.session.settled();
    // Playing again: put in step where it plays, by the pass that ran again for the resume.
    expect(moveMedia.mock.calls.map(call => call[0])).toMatchObject([{ clipId: 'clip' }]);
    expect(test.applied).toEqual([2]);
  });

  it('等 OBS 的时候音乐往前走了：按等完以后的位置对齐', async () => {
    const moveMedia = vi.fn<NonNullable<ObsProgramSessionDependencies['moveMedia']>>(() => Promise.resolve());
    let test: ReturnType<typeof setup> | null = null;
    test = setup(video(), { moveMedia, retargetOutputs: () => { test!.at(3000); test!.session.clock(3000); return Promise.resolve(); } });
    await test.session.prepare(0); await test.advance(0, 2000);
    test.session.retarget(video({ startSeconds: 1 }), 2); await test.session.settled();
    expect(moveMedia.mock.calls[0]![0]).toMatchObject({ clipId: 'clip', sourceOffsetMs: 2000 });
  });

  it('队列里才发现建不起来的一版：画面停下并写明原因，原来的计划不再半新半旧地跑', async () => {
    const states: string[] = [];
    const test = setup(video(), { state: update => { states.push(update.state); } });
    await test.session.prepare(0); await test.advance(0, 2000);
    const good = video({ startSeconds: 1 }), item = good.rundown[0]!;
    // The clip names no layer: checked before the queue, the item is fine; the plan cannot be built from it.
    const broken: LinkProject = { ...good, rundown: [{ ...item, referenceMediaClips: (item.referenceMediaClips ?? []).map(clip => ({ ...clip, layerId: undefined })) }] };
    expect(() => test.session.retarget(broken, 2)).not.toThrow();
    await test.session.settled();
    expect(test.session.error?.message).toMatch(/^这次修改的画面用不上：.+。音乐和时间码照常，这首歌停下重播时按新的样子放$/);
    expect(states.at(-1)).toBe('error');
    expect(test.applied).toEqual([]);
    const sent = test.mediaSteps().length + test.actions.length;
    await test.advance(2100, 3000);
    expect(test.mediaSteps().length + test.actions.length).toBe(sent);
  });
});


describe('P1 放音乐的歌也能接新的一版（0.5.9，P1 的画面）', () => {
  it('P1 的歌：会话打开和接新的一版都照联动台播放那样走，机位按新的切；视频自己的声音照片段自己的开关', async () => {
    const p1 = (project: LinkProject): LinkProject => parseLinkProject({ ...project, playbackSource: 'p1' });
    const test = setup(p1(cameras()));
    await test.session.prepare(0); await test.advance(0, 500);
    test.session.retarget(p1(cameras([camera(0), camera(1, '新机位'), camera(2), camera(3)])), 2); await test.session.settled();
    expect(test.faults).toEqual([]);
    expect(test.applied).toEqual([2]);
    await test.advance(600, 2100);
    expect(test.scenes()).toEqual(['场景 0', '新机位', '场景 2']);
    const clip = setup(p1(video()));
    await clip.session.prepare(0); await clip.advance(0, 500);
    clip.session.retarget(p1(video({ durationMs: 5000 })), 2); await clip.session.settled();
    expect(clip.faults).toEqual([]);
    expect(clip.applied).toEqual([2]);
    expect(clip.media.mock.calls.map(([payload]) => payload.event.embeddedAudioEnabled)).toEqual([true]);
    // A new version taken before P1's music is joined: the picture still joins where the music is then.
    const late = setup(p1(cameras()));
    await late.session.prepare(0);
    late.session.retarget(p1(cameras([camera(0), camera(1), camera(2, '新机位'), camera(3)])), 2); await late.session.settled();
    late.session.joinNextClock(); await late.advance(1500, 2100);
    expect(late.faults).toEqual([]);
    expect(late.scenes()).toEqual(['新机位']);
  });
});
