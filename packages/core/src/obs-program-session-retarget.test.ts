import { describe, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type LinkAction, type LinkProject } from '@tb/schema';
import { ObsProgramSession, type ObsProgramSessionDependencies } from './obs-program-session';
import type { ManagedMediaEvent } from './managed-media-timeline';
import type { LinkDesktopApi } from './link-desktop-contract';

/** 0.5.9 R9: a newer plan of the song on air takes effect in this pass (2026-11-10 decision 1, “这一遍立即生效”). */

const at = (seconds: number) => ({ hours: 0, minutes: 0, seconds, frames: 0 });
const camera = (seconds: number, scene = `场景 ${seconds}`) => ({ id: `cue-${seconds}`, name: `机位 ${seconds}`, timecode: at(seconds),
  actions: [{ id: `action-${seconds}`, kind: 'obs.setProgramScene' as const, label: '切机位', sceneName: scene }] });
const hide = (id: string, seconds: number) => ({ id, name: id, timecode: at(seconds),
  actions: [{ id: `${id}-action`, kind: 'obs.setSceneItemEnabled' as const, label: id, sceneName: '场景 0', sourceName: id, enabled: false }] });
function cameras(cues = [0, 1, 2, 3].map(seconds => camera(seconds))): LinkProject {
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
  return { session, actions, faults, applied, media, dependencies, advance, scenes, mediaSteps, offline: (value: boolean) => { online = !value; } };
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
    expect(() => test.session.retarget({ ...cameras(), timebase: { ...cameras().timebase, frameRate: 30 } }, 2)).toThrow('帧率');
    expect(test.applied).toEqual([]);
  });
});
