import type { OBSWebSocket } from 'obs-websocket-js';
import { expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type LinkProject } from '@tb/schema';
import { ObsProgramSession, SceneOutputTimeline, type LinkDesktopApi } from '@tb/core/link';
import { ObsMediaPreload } from './obs-media-preload';
import { ObsMediaScenes } from './obs-media-scenes';

function mockScenes() {
  return { prepareStandby: vi.fn<ObsMediaScenes['prepareStandby']>(name => Promise.resolve(`${name}·预备`)),
    copyPresentation: vi.fn<ObsMediaScenes['copyPresentation']>(() => Promise.resolve()),
    prime: vi.fn<ObsMediaScenes['prime']>(async (_event, _path, run) => { await run(); }),
    execute: vi.fn<ObsMediaScenes['execute']>(() => Promise.resolve()), seek: vi.fn<ObsMediaScenes['seek']>(() => Promise.resolve()),
    isActive: vi.fn<ObsMediaScenes['isActive']>(() => false) };
}
function mockNative() {
  return { prime: vi.fn<(name: string, restartRetained: boolean, kind: 'audio' | 'video') => Promise<void>>(() => Promise.resolve()), seek: vi.fn<(name: string, position: number) => Promise<void>>(() => Promise.resolve()) };
}
function setup(camera = false, kind: 'audio' | 'video' = 'video') {
  const project = parseLinkProject({ ...createEmptyLinkProject('预备'), playbackSource: 'internal', obsOutputMode: 'scenes',
    mediaAssets: [{ id: 'video', name: '视频', kind, relativePath: 'assets/video.mp4', sha256: 'a'.repeat(64), byteLength: 1, durationMs: 60000, width: 1920, height: 1080 }],
    rundown: [{ id: 'song', title: '歌曲', visualLayers: [{ id: 'camera', name: '机位' }, { id: 'video-layer', name: '视频' }],
      referenceMediaClips: [0, 12, 24].map((seconds, index) => ({ id: `clip-${index}`, assetId: 'video', layerId: 'video-layer', label: '视频',
        startTimecode: { hours: 0, minutes: 0, seconds, frames: 0 }, durationMs: 12000, sourceOffsetMs: 100 })),
      cues: camera ? [{ id: 'camera-cue', name: '机位', layerId: 'camera', timecode: { hours: 0, minutes: 0, seconds: 4, frames: 0 }, durationMs: 2000,
        actions: [{ id: 'camera-action', kind: 'obs.setProgramScene', label: '机位', sceneName: '机位1' }] }] : [] }] });
  const scenes = mockScenes(), native = mockNative();
  const preload = new ObsMediaPreload(project, 'song', scenes, native), timeline = new SceneOutputTimeline(project, 'song');
  const events = timeline.preloadEntries(), path = 'C:/shows/assets/video.mp4';
  preload.register(project.projectId, project.mediaAssets[0]!, path);
  return { project, preload, scenes, native, timeline, events, path };
}
const current = (): void => undefined;
const path = 'C:/shows/assets/video.mp4';

/** One video on one track, `[start s, length ms]` per clip, and a camera `[start s, length s]` above it. */
function song(clips: ReadonlyArray<readonly [number, number]>, camera?: readonly [number, number], sourceOffsetMs = 0): LinkProject {
  return parseLinkProject({ ...createEmptyLinkProject('预备'), playbackSource: 'internal', obsOutputMode: 'scenes',
    mediaAssets: [{ id: 'video', name: '视频', kind: 'video', relativePath: 'assets/video.mp4', sha256: 'a'.repeat(64), byteLength: 1, durationMs: 60000, width: 1920, height: 1080 }],
    rundown: [{ id: 'song', title: '歌曲', visualLayers: [{ id: 'camera', name: '机位' }, { id: 'video-layer', name: '视频' }],
      referenceMediaClips: clips.map(([seconds, durationMs], index) => ({ id: `clip-${index}`, assetId: 'video', layerId: 'video-layer', label: '视频',
        startTimecode: { hours: 0, minutes: 0, seconds, frames: 0 }, durationMs, sourceOffsetMs })),
      cues: camera ? [{ id: 'camera-cue', name: '机位', layerId: 'camera', timecode: { hours: 0, minutes: 0, seconds: camera[0], frames: 0 }, durationMs: camera[1] * 1000,
        actions: [{ id: 'camera-action', kind: 'obs.setProgramScene', label: '机位', sceneName: '机位1' }] }] : [] }] });
}
function mocked(project: LinkProject) {
  const scenes = mockScenes(), native = mockNative(), preload = new ObsMediaPreload(project, 'song', scenes, native);
  preload.register(project.projectId, project.mediaAssets[0]!, path);
  return { preload, scenes, native, events: new SceneOutputTimeline(project, 'song').preloadEntries() };
}

type FakeInput = { scene: string; item: number; state: string; base: number; since: number; muted: boolean; enabled: boolean };
type OnAir = { decoder: string | null; state: string; cursor: number };
/** OBS keeping each input's own state, as on the field machine: which decoder the
 * audience sees on program, whether it plays and where. A paused cursor stays put;
 * a playing one runs with the clock. `sent` lists the writes OBS carried out. */
function fakeObs() {
  const inputs = new Map<string, FakeInput>(), sceneNames = new Set<string>();
  let nextItem = 1, program = '', seekDelayMs = 0, cancelled = false, cancelAfterSwitch = false;
  /** The next batch waits here: sent, but OBS has not carried it out yet. */
  let gate: Promise<void> | null = null, holding = false;
  const sent: string[] = [], onAir: OnAir[] = [];
  const landing = new Map<string, { at: number; to: number }>();
  /** OBS carries the request out with an error; a batch stops there. */
  const failures: Array<(type: string, data: Record<string, unknown>) => boolean> = [];
  /** Requests that never go out: a queue timeout, or the operator paused. */
  const refusals: Array<(label: string) => string | null> = [];
  const decoder = (name: string): string => name.endsWith('·预备') ? '预备' : '主';
  const input = (name: unknown): FakeInput => {
    const found = typeof name === 'string' ? inputs.get(name) : undefined;
    if (!found) throw new Error(`OBS 里没有这个来源：${String(name)}`);
    return found;
  };
  const cursor = (target: FakeInput): number => target.state === 'OBS_MEDIA_STATE_PLAYING' ? target.base + performance.now() - target.since : target.base;
  const freeze = (target: FakeInput): void => { target.base = cursor(target); target.since = performance.now(); };
  const handle = (type: string, data: Record<string, unknown>): unknown => {
    if (failures.some(failure => failure(type, data))) throw new Error(`OBS 没能执行 ${type}`);
    switch (type) {
      case 'GetSceneList': return { scenes: [...sceneNames].map(sceneName => ({ sceneName })) };
      case 'CreateScene': sceneNames.add(String(data.sceneName)); return {};
      case 'CreateInput': {
        const item = nextItem++;
        inputs.set(String(data.inputName), { scene: String(data.sceneName), item, state: 'OBS_MEDIA_STATE_STOPPED', base: 0, since: 0, muted: false, enabled: data.sceneItemEnabled === true });
        return { sceneItemId: item };
      }
      case 'GetVideoSettings': return { baseWidth: 1080, baseHeight: 1920 };
      case 'GetInputSettings': return { inputKind: 'ffmpeg_source', inputSettings: { local_file: path, hw_decode: true, restart_on_activate: false, close_when_inactive: false, looping: false } };
      case 'GetSceneItemList': return { sceneItems: [...inputs].filter(([, entry]) => entry.scene === data.sceneName).map(([sourceName, entry]) => ({ sourceName, sceneItemId: entry.item })) };
      case 'GetSceneItemTransform': return { sceneItemTransform: { sourceWidth: 1080, sourceHeight: 1920 } };
      case 'GetSourceFilterList': return { filters: [] };
      case 'GetSourceScreenshot': return { imageData: 'data:image/png;base64,x' };
      case 'SetSceneItemTransform': case 'SetInputSettings': return {};
      case 'SetInputMute': input(data.inputName).muted = data.inputMuted === true; sent.push(`${data.inputMuted === true ? '静音' : '出声'} ${decoder(String(data.inputName))}`); return {};
      case 'SetSceneItemEnabled': {
        const entry = [...inputs].find(([, candidate]) => candidate.scene === data.sceneName && candidate.item === data.sceneItemId);
        if (!entry) throw new Error('OBS 里没有这个场景项');
        entry[1].enabled = data.sceneItemEnabled === true; sent.push(`${entry[1].enabled ? '显示' : '隐藏'} ${decoder(entry[0])}`); return {};
      }
      case 'SetCurrentProgramScene': program = String(data.sceneName); sent.push('切场景'); return {};
      case 'GetMediaInputStatus': {
        const name = String(data.inputName), target = input(name), pending = landing.get(name);
        if (pending && performance.now() >= pending.at) { freeze(target); target.base = pending.to; landing.delete(name); }
        return { mediaState: target.state, mediaCursor: Math.round(cursor(target)), mediaDuration: 60000 };
      }
      case 'SetMediaInputCursor': {
        const name = String(data.inputName), to = Number(data.mediaCursor), target = input(name);
        sent.push(`定位 ${decoder(name)}`);
        if (seekDelayMs) landing.set(name, { at: performance.now() + seekDelayMs, to });
        else { freeze(target); target.base = to; }
        return {};
      }
      case 'TriggerMediaInputAction': {
        const name = String(data.inputName), target = input(name), action = String(data.mediaAction).replace('OBS_WEBSOCKET_MEDIA_INPUT_ACTION_', '');
        sent.push(`${action} ${decoder(name)}`); freeze(target);
        if (action === 'RESTART') { target.base = 0; target.state = 'OBS_MEDIA_STATE_PLAYING'; }
        else if (action === 'PLAY') target.state = 'OBS_MEDIA_STATE_PLAYING';
        else if (action === 'PAUSE') target.state = 'OBS_MEDIA_STATE_PAUSED';
        else if (action === 'STOP') { target.state = 'OBS_MEDIA_STATE_STOPPED'; target.base = 0; }
        return {};
      }
      default: throw new Error(`假 OBS 不认识 ${type}`);
    }
  };
  const look = (): void => {
    const top = [...inputs].filter(([, entry]) => entry.scene === program && entry.enabled).sort((a, b) => b[1].item - a[1].item)[0];
    const view = top ? { decoder: decoder(top[0]), state: top[1].state.replace('OBS_MEDIA_STATE_', ''), cursor: Math.round(cursor(top[1])) } : { decoder: null, state: '', cursor: 0 };
    const last = onAir.at(-1);
    if (!last || last.decoder !== view.decoder || last.state !== view.state || last.cursor !== view.cursor) onAir.push(view);
  };
  const client = {
    call: (type: string, data: Record<string, unknown> = {}) => {
      try { const result = handle(type, data); look(); return Promise.resolve(result); }
      catch (error) { return Promise.reject(error instanceof Error ? error : new Error(String(error))); }
    },
    callBatch: async (batch: Array<{ requestType: string; requestData?: Record<string, unknown> }>) => {
      if (gate) { const wait = gate; gate = null; holding = true; await wait; holding = false; }
      const results: Array<{ requestType: string; requestStatus: { result: boolean; code: number; comment?: string } }> = [];
      for (const entry of batch) {
        try { handle(entry.requestType, entry.requestData ?? {}); results.push({ requestType: entry.requestType, requestStatus: { result: true, code: 100 } }); }
        catch (error) { results.push({ requestType: entry.requestType, requestStatus: { result: false, code: 500, comment: error instanceof Error ? error.message : String(error) } }); break; }
      }
      look();
      if (cancelAfterSwitch && batch.some(entry => entry.requestType === 'SetCurrentProgramScene')) cancelled = true;
      return results;
    }
  };
  const once = <T extends unknown[]>(match: (...values: T) => boolean): ((...values: T) => boolean) => {
    let used = false;
    return (...values) => { if (used || !match(...values)) return false; used = true; return true; };
  };
  return {
    client: client as unknown as OBSWebSocket, sent, onAir, decoder: (name: string): FakeInput => input(name), position: (name: string): number => Math.round(cursor(input(name))),
    request: <T>(operation: () => Promise<T>, label: string): Promise<T> => {
      if (cancelled) return Promise.reject(new Error(`OBS 动作已取消或已过时，没有发送：${label}`));
      const refused = refusals.map(refusal => refusal(label)).find(reason => reason !== null);
      return refused ? Promise.reject(new Error(refused)) : operation();
    },
    native: {
      prime: (name: string, restartRetained: boolean): Promise<void> => {
        const target = input(name); sent.push(`预热 ${decoder(name)}${restartRetained ? ' 从已解码画面重启' : ''}`);
        target.state = 'OBS_MEDIA_STATE_PAUSED'; target.base = 0; target.since = performance.now(); return Promise.resolve();
      },
      seek: (name: string, positionMs: number): Promise<void> => { const target = input(name); freeze(target); target.base = positionMs; return Promise.resolve(); }
    },
    seekDelay: (ms: number): void => { seekDelayMs = ms; },
    /** The scheduler gives up on the first request with this label: it never reaches OBS. */
    refuseOnce: (label: string): void => {
      const match = once((candidate: string) => candidate === label);
      refusals.push(candidate => match(candidate) ? `OBS ${label} 请求排队超时（2000 ms）；还没发送` : null);
    },
    failOnce: (match: (type: string, data: Record<string, unknown>) => boolean): void => { failures.push(once(match)); },
    /** The operator pauses right after the next scene switch: nothing more is sent. */
    pauseAfterSwitch: (): void => { cancelAfterSwitch = true; },
    resume: (): void => { cancelled = false; cancelAfterSwitch = false; },
    /** OBS is slow to answer the next batch: it carries it out once released. */
    holdNextBatch: (): (() => void) => {
      let release = (): void => undefined;
      gate = new Promise<void>(resolve => { release = resolve; });
      return () => release();
    },
    /** Whether a held batch is waiting for OBS right now. */
    holding: (): boolean => holding
  };
}
/** Lets the promise chain run up to the batch OBS holds. */
async function untilHeld(obs: FakeObs): Promise<void> {
  for (let turn = 0; turn < 200 && !obs.holding(); turn++) await Promise.resolve();
  expect(obs.holding(), '没有等到 OBS 正在处理的那批请求').toBe(true);
}
type FakeObs = ReturnType<typeof fakeObs>;
/** Lets fake time run, as the music does, until the operation settles; its error message, or 完成. */
async function outcome(operation: Promise<unknown>): Promise<string> {
  let result: string | undefined;
  void operation.then(() => { result = '完成'; }, (error: unknown) => { result = error instanceof Error ? error.message : String(error); });
  for (let spent = 0; result === undefined && spent < 5000; spent += 20) await vi.advanceTimersByTimeAsync(20);
  return result ?? '没有结束';
}
/** Clips of 12 s back to back from the same video: each start hands over between its two decoders.
 * clip-0 plays on the first decoder and clip-1 waits primed on the second. */
async function handover(sourceOffsetMs = 100) {
  const project = song([[0, 12000], [12, 12000], [24, 12000], [36, 12000]], undefined, sourceOffsetMs), obs = fakeObs();
  const scenes = new ObsMediaScenes(obs.client, obs.request, operation => operation());
  const preload = new ObsMediaPreload(project, 'song', scenes, obs.native);
  const events = new SceneOutputTimeline(project, 'song').preloadEntries();
  await scenes.prepare(project.projectId, project.mediaAssets[0]!, path);
  preload.register(project.projectId, project.mediaAssets[0]!, path);
  await preload.prime(events[0]!, current); await preload.execute(events[0]!, path);
  expect(await preload.upcoming(60, current)).toMatchObject({ clipId: 'clip-1' });
  obs.sent.length = 0; obs.onAir.length = 0;
  const primary = events[0]!.sourceName;
  return { obs, scenes, preload, events, primary, standby: `${primary}·预备` };
}

it('正式播放前预热首段和接续段，播放中不重复创建或预热；再下一段仍复用原解码器', async () => {
  const t = setup(true);
  const unique = t.events.filter((event, index, events) => events.findIndex(candidate => candidate.clipId === event.clipId) === index);
  const first = unique[0]!, second = unique[1]!, third = unique[2]!;
  await t.preload.prime(first, current); await t.preload.primeFollowing(first, current);
  expect(t.native.prime).toHaveBeenCalledTimes(2);
  expect(t.scenes.execute).not.toHaveBeenCalled();
  await t.preload.execute(first, t.path); await t.preload.upcoming(60, current);
  expect(t.native.prime).toHaveBeenCalledTimes(2);
  await t.preload.execute(second, t.path);
  expect(t.preload.resolveSource(first.sourceName)).toBe(`${first.sourceName}·预备`);
  await t.preload.prime(third, current);
  expect(t.native.prime).toHaveBeenLastCalledWith(first.sourceName, true, 'video');
  await t.preload.close();
});

it('正式播放前取消时两份解码器都关闭，预备失败不进入时间线', async () => {
  const t = setup(), first = t.events[0]!;
  await t.preload.prime(first, current);
  t.native.prime.mockRejectedValueOnce(new Error('预备解码失败'));
  await expect(t.preload.primeFollowing(first, current)).rejects.toThrow('预备解码失败');
  await t.preload.close();
  expect(t.scenes.execute.mock.calls.map(([event]) => [event.sourceName, event.phase]))
    .toEqual([[first.sourceName, 'stop'], [`${first.sourceName}·预备`, 'stop']]);
});

it.each(['audio', 'video'] as const)('按 %s 类型预热初次和复用解码器，保留裁剪定位', async kind => {
  const t = setup(false, kind);
  for (const event of t.events) {
    await t.preload.prime(event, current); await t.preload.execute(event, t.path);
  }
  expect(t.native.prime.mock.calls.map(([, retained, mediaKind]) => [retained, mediaKind]))
    .toEqual([[false, kind], [false, kind], [true, kind]]);
  expect(t.native.seek.mock.calls.map(([, ms]) => ms)).toEqual([100, 100, 100]);
  await t.preload.close();
});

it('曲尾已成功停止的解码器不在关闭会话时再停一次，尚未播放的预备输入仍被清理', async () => {
  const t = setup(), first = t.events[0]!;
  await t.preload.prime(first, current); await t.preload.execute(first, t.path);
  await t.preload.upcoming(60, current);
  await t.preload.execute({ ...first, phase: 'stop', frameNumber: 1080 }, t.path);
  await t.preload.close(); await t.preload.close();
  expect(t.scenes.execute.mock.calls.filter(([event]) => event.phase === 'stop').map(([event]) => event.sourceName))
    .toEqual([first.sourceName, `${first.sourceName}·预备`]);
});

it('播放中的四路纹理预热分散到音频时钟周期，全部仍在原边界前就绪', async () => {
  const base = setup(), item = base.project.rundown[0]!;
  const assets = Array.from({ length: 4 }, (_, index) => ({ ...base.project.mediaAssets[0]!, id: `video-${index}` }));
  const project = parseLinkProject({ ...base.project, mediaAssets: assets, rundown: [{ ...item,
    visualLayers: assets.map(asset => ({ id: `${asset.id}-layer`, name: asset.id })),
    referenceMediaClips: assets.flatMap(asset => item.referenceMediaClips.map(clip => ({ ...clip,
      id: `${asset.id}-${clip.id}`, assetId: asset.id, layerId: `${asset.id}-layer` }))) }] });
  const preload = new ObsMediaPreload(project, item.id, base.scenes, base.native);
  for (const asset of assets) preload.register(project.projectId, asset, base.path);
  const events = new SceneOutputTimeline(project, item.id).preloadEntries();
  for (const event of events.filter(event => event.frameNumber === 0)) {
    await preload.prime(event, current); await preload.execute(event, base.path);
  }
  expect(base.native.prime).toHaveBeenCalledTimes(4);
  for (let frame = 60; frame <= 105; frame++) {
    await preload.upcoming(frame, current);
    expect(base.native.prime).toHaveBeenCalledTimes(5 + Math.floor((frame - 60) / 15));
  }
  for (const event of events.filter(event => event.frameNumber === 360)) await preload.execute(event, base.path);
  expect(base.scenes.execute).toHaveBeenCalledTimes(8);
});

it('当前边界仍排队时不覆盖开场预备槽，也不因更后面的片段误报失败', async () => {
  const t = setup(), first = t.events[0]!;
  await t.preload.prime(first, current);
  await t.preload.upcoming(60, current);
  expect(t.native.prime).toHaveBeenCalledTimes(1);
  await t.preload.execute(first, t.path); await t.preload.upcoming(75, current);
  expect(t.native.prime).toHaveBeenCalledTimes(2);
});

it('相邻三片段交替使用主、预备、主解码器；边界只切换已准备输入', async () => {
  const t = setup(), [first, second, third] = t.events;
  await t.preload.prime(first!, current); await t.preload.execute(first!, t.path);
  await t.preload.upcoming(30, current); expect(t.native.prime).toHaveBeenCalledTimes(1);
  await t.preload.upcoming(60, current); expect(t.native.prime).toHaveBeenCalledTimes(2);
  await t.preload.upcoming(90, current); expect(t.native.prime).toHaveBeenCalledTimes(2);
  const standby = `${first!.sourceName}·预备`;
  await t.preload.execute(second!, t.path);
  expect(t.preload.resolveSource(first!.sourceName)).toBe(standby);
  expect(t.scenes.execute).toHaveBeenLastCalledWith({ ...second!, sourceName: standby }, t.path, first!.sourceName, 'pause');
  await t.preload.upcoming(420, current); await t.preload.execute(third!, t.path);
  expect(t.scenes.copyPresentation).toHaveBeenCalledWith(standby, first!.sourceName);
  expect(t.native.prime).toHaveBeenCalledTimes(3);
  expect(t.native.prime.mock.calls.map(([, retained]) => retained)).toEqual([false, false, true]);
  expect(t.native.seek.mock.calls.map(call => call[1])).toEqual([100, 100, 100]);
  expect(t.preload.resolveSource(first!.sourceName)).toBe(first!.sourceName);
  await t.preload.close();
  expect(t.scenes.execute.mock.calls.filter(([event]) => event.phase === 'stop').map(([event]) => event.sourceName)).toEqual([first!.sourceName]);
});

it('机位结束恢复同一片段不抢占后续片段的预备位置', async () => {
  const t = setup(true), first = t.events[0]!;
  expect(t.events.map(event => [event.clipId, event.frameNumber, event.sourceOffsetMs])).toEqual([
    ['clip-0', 0, 100], ['clip-0', 180, 6100], ['clip-1', 360, 100], ['clip-2', 720, 100]
  ]);
  await t.preload.prime(first, current); await t.preload.execute(first, t.path);
  await t.preload.upcoming(90, current);
  expect(t.scenes.prime.mock.calls.map(([event]) => event.clipId)).toEqual(['clip-0', 'clip-1']);
});

it('预备未完成、失败、过期时均不能把下一片段显示为可播，也不能自动重发', async () => {
  const t = setup(), event = t.events[0]!;
  let release = (): void => { throw new Error('测试未初始化'); };
  t.native.prime.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  let valid = true;
  const preparing = t.preload.prime(event, () => { if (!valid) throw new Error('已取消'); });
  await expect(t.preload.execute(event, t.path)).rejects.toThrow('没能在切换前准备好');
  await expect(t.preload.prime(event, current)).rejects.toThrow('不能重复准备');
  valid = false; release(); await expect(preparing).rejects.toThrow('已取消');
  await t.preload.close();
  expect(t.native.prime).toHaveBeenCalledTimes(1);
  expect(t.scenes.execute.mock.calls.every(([event]) => event.phase === 'stop')).toBe(true);
  await expect(t.preload.seek(event, t.path)).rejects.toThrow('定位路径或状态已改变');
});

it('预备失败放回预备槽：同一输入后面的片段照常准备和播出，失败的这一段不自动重试', async () => {
  const t = setup(), [first, second, third] = t.events;
  await t.preload.prime(first!, current); await t.preload.execute(first!, t.path);
  t.native.prime.mockRejectedValueOnce(new Error('解码器无响应'));
  await expect(t.preload.upcoming(60, current)).rejects.toThrow('解码器无响应');
  expect(await t.preload.upcoming(400, current)).toBeNull();
  await expect(t.preload.execute(second!, t.path)).rejects.toThrow('没能在切换前准备好');
  expect(await t.preload.upcoming(450, current)).toMatchObject({ clipId: third!.clipId });
  await t.preload.execute(third!, t.path);
  expect(t.scenes.prime.mock.calls.map(([event]) => event.clipId)).toEqual(['clip-0', 'clip-1', 'clip-2']);
  expect(t.scenes.execute.mock.calls.map(([event]) => event.clipId)).toEqual(['clip-0', 'clip-2']);
  await t.preload.close();
});

it('OBS 断开时预备失败的片段，重新连上 OBS 后照常准备一次', async () => {
  const t = setup(), [first, second] = t.events;
  await t.preload.prime(first!, current); await t.preload.execute(first!, t.path);
  t.native.prime.mockRejectedValueOnce(new Error('OBS 未连接'));
  await expect(t.preload.upcoming(60, current)).rejects.toThrow('OBS 未连接');
  t.preload.register(t.project.projectId, t.project.mediaAssets[0]!, t.path);
  expect(await t.preload.upcoming(400, current)).toMatchObject({ clipId: second!.clipId });
  await t.preload.close();
});

it('错过播放边界的片段在当前位置仍应播出时先预备一次并交回，之后不再重复预备', async () => {
  const t = setup(), [first, second] = t.events;
  await t.preload.prime(first!, current); await t.preload.execute(first!, t.path);
  await expect(t.preload.execute(second!, t.path)).rejects.toThrow('没能在切换前准备好');
  expect(await t.preload.upcoming(390, current)).toMatchObject({ clipId: second!.clipId });
  await t.preload.execute({ ...second!, sourceOffsetMs: 1100 }, t.path);
  expect(t.native.prime).toHaveBeenCalledTimes(2);
  expect(await t.preload.upcoming(420, current)).toMatchObject({ clipId: 'clip-2' });
  expect(t.scenes.prime.mock.calls.map(([event]) => event.clipId)).toEqual(['clip-0', 'clip-1', 'clip-2']);
  await t.preload.close();
});

it('一个输入停止失败仍清理另一输入，错误返回上层', async () => {
  const t = setup(), first = t.events[0]!;
  await t.preload.prime(first, current); await t.preload.execute(first, t.path); await t.preload.upcoming(60, current);
  t.scenes.execute.mockRejectedValueOnce(new Error('主来源失去响应'));
  await expect(t.preload.close()).rejects.toThrow('主来源失去响应');
  await expect(t.preload.close()).rejects.toThrow('主来源失去响应');
  expect(t.scenes.execute.mock.calls.filter(([event]) => event.phase === 'stop')).toHaveLength(2);
});

it('OBS 重连后重新登记：解码槽重来但已用过的输入仍在停止时清理；用过的预备解码器重新准备', async () => {
  const t = setup(), [first, second] = t.events;
  await t.preload.prime(first!, current); await t.preload.execute(first!, t.path);
  await t.preload.upcoming(60, current); await t.preload.execute(second!, t.path);
  const standby = `${first!.sourceName}·预备`;
  expect(t.preload.resolveSource(first!.sourceName)).toBe(standby);
  t.preload.register(t.project.projectId, t.project.mediaAssets[0]!, t.path);
  expect(t.preload.resolveSource(first!.sourceName)).toBe(first!.sourceName);
  t.scenes.prepareStandby.mockClear();
  await t.preload.restoreStandby(current);
  expect(t.scenes.prepareStandby).toHaveBeenCalledExactlyOnceWith(first!.sourceName);
  await t.preload.close();
  expect(t.scenes.execute.mock.calls.filter(([event]) => event.phase === 'stop').map(([event]) => event.sourceName).sort()).toEqual([first!.sourceName, standby].sort());
});

it('预热好的片段到结束都没开播（OBS 忙时整段落在积压里）：到它真正结束那一帧让出预备位置，同一素材后面的片段照常预热和播出', async () => {
  // clip-0 [0,2) s, clip-1 [3,3.5) s, clip-2 [8,10) s, clip-3 [12,14) s.
  const t = mocked(song([[0, 2000], [3, 500], [8, 2000], [12, 2000]]));
  const [first, second, third, fourth] = t.events, primary = first!.sourceName;
  await t.preload.prime(first!, current); await t.preload.execute(first!, path);
  expect(await t.preload.upcoming(30, current)).toMatchObject({ clipId: 'clip-1' });
  await t.preload.execute({ ...first!, phase: 'stop', frameNumber: 60 }, path);
  // clip-1 never starts. While it is still on the timeline it keeps its slot and is not prepared again.
  expect(await t.preload.upcoming(104, current)).toBeNull();
  expect(await t.preload.upcoming(105, current)).toMatchObject({ clipId: 'clip-2' });
  await expect(t.preload.execute(second!, path)).rejects.toThrow('这一段素材没有播出：轮到它时已经过了它的结束时间');
  await t.preload.execute(third!, path);
  expect(await t.preload.upcoming(250, current)).toMatchObject({ clipId: 'clip-3' });
  await t.preload.execute(fourth!, path);
  expect(t.scenes.execute.mock.calls.filter(([event]) => event.phase === 'start').map(([event]) => event.clipId)).toEqual(['clip-0', 'clip-2', 'clip-3']);
  // Both decoders were decoded and paused before, so each is restarted from there.
  expect(t.native.prime.mock.calls.map(([name, retained]) => [name === primary ? '主' : '预备', retained]))
    .toEqual([['主', false], ['预备', false], ['主', true], ['预备', true]]);
  // clip-0's stop, then the end of the song: clip-3's handover already stopped the first decoder.
  await t.preload.close();
  expect(t.scenes.execute.mock.calls.filter(([event]) => event.phase === 'stop').map(([event]) => event.sourceName)).toEqual([primary, `${primary}·预备`]);
});

it('被机位盖住的片段等机位结束还要露出：真正结束前一直留着它的预备位置，露出时照常开播', async () => {
  // clip-0 [0,12) s and clip-1 [12,24) s back to back; a camera [10,14) s above covers the cut, so clip-1 first shows at 14 s.
  const t = mocked(song([[0, 12000], [12, 12000], [24, 12000]], [10, 4], 100));
  expect(t.events.map(event => [event.clipId, event.frameNumber, event.sourceOffsetMs])).toEqual([['clip-0', 0, 100], ['clip-1', 420, 2100], ['clip-2', 720, 100]]);
  const [first, second] = t.events, standby = `${first!.sourceName}·预备`;
  await t.preload.prime(first!, current); await t.preload.execute(first!, path);
  expect(await t.preload.upcoming(150, current)).toMatchObject({ clipId: 'clip-1', frameNumber: 420 });
  await t.preload.execute({ ...first!, phase: 'stop', frameNumber: 360 }, path);
  // Past clip-1's own start at 12 s, still under the camera.
  for (const frame of [360, 390, 419]) expect(await t.preload.upcoming(frame, current)).toBeNull();
  await t.preload.execute(second!, path);
  expect(t.scenes.prime.mock.calls.map(([event]) => event.clipId)).toEqual(['clip-0', 'clip-1']);
  expect(t.scenes.execute).toHaveBeenLastCalledWith({ ...second!, sourceName: standby }, path, undefined, 'pause');
  expect(t.preload.resolveSource(first!.sourceName)).toBe(standby);
});

it('按时交接：画面直接从正在播的解码器换到停在入点的预备解码器，旧解码器暂停、隐藏、静音，不从文件开头播', async () => {
  vi.useFakeTimers();
  try {
    const t = await handover();
    await t.preload.execute(t.events[1]!, path);
    expect(t.obs.sent).toEqual(['静音 主', '隐藏 主', 'PAUSE 主', '静音 预备', '显示 预备', '切场景', 'PLAY 预备']);
    expect(t.obs.onAir.map(view => `${view.decoder} ${view.state} @${view.cursor}`)).toEqual(['主 PLAYING @100', '预备 PLAYING @100']);
    expect(t.obs.decoder(t.primary)).toMatchObject({ state: 'OBS_MEDIA_STATE_PAUSED', enabled: false, muted: true });
    expect(t.preload.resolveSource(t.primary)).toBe(t.standby);
    expect(t.scenes.isActive(t.primary)).toBe(false);
    // The next clip goes back to the first decoder, restarted from its decoded frame.
    expect(await t.preload.upcoming(450, current)).toMatchObject({ clipId: 'clip-2' });
    expect(t.obs.sent).toContain('预热 主 从已解码画面重启');
    await t.preload.execute(t.events[2]!, path);
    expect(t.obs.onAir.at(-1)).toMatchObject({ decoder: '主', state: 'PLAYING', cursor: 100 });
  } finally { vi.useRealTimers(); }
});

it('晚到 600 ms 的预热交接（入点在文件 30 秒处）：旧解码器先退役，预备解码器停在入点画面上场，按音乐定位后才播放，画面上不出现文件开头', async () => {
  vi.useFakeTimers();
  try {
    const t = await handover(30000), late = { ...t.events[1]!, sourceOffsetMs: 30600 };
    const started = performance.now();
    expect(await outcome(t.preload.execute(late, path))).toBe('完成');
    expect(t.obs.sent.filter(entry => entry.startsWith('RESTART'))).toEqual([]);
    expect(t.obs.onAir.filter(view => view.decoder === '预备').every(view => view.cursor >= 30000)).toBe(true);
    expect(t.obs.sent.indexOf('隐藏 主')).toBeLessThan(t.obs.sent.indexOf('显示 预备'));
    expect(t.obs.sent.filter(entry => entry.startsWith('定位'))).toEqual(['定位 预备']);
    expect(t.obs.sent.lastIndexOf('PLAY 预备')).toBeGreaterThan(t.obs.sent.indexOf('定位 预备'));
    expect(t.obs.decoder(t.standby)).toMatchObject({ state: 'OBS_MEDIA_STATE_PLAYING', enabled: true });
    expect(Math.abs(t.obs.position(t.standby) - (late.sourceOffsetMs + performance.now() - started))).toBeLessThanOrEqual(100);
    expect(t.obs.decoder(t.primary)).toMatchObject({ state: 'OBS_MEDIA_STATE_PAUSED', enabled: false, muted: true });
  } finally { vi.useRealTimers(); }
});

it.each<[string, (obs: FakeObs) => void, string[], '主' | '预备']>([
  ['读取预热状态的请求没发出去', obs => obs.refuseOnce('检查预热素材'), [], '主'],
  ['OBS 隐藏旧解码器时出错', obs => obs.failOnce((type, data) => type === 'SetSceneItemEnabled' && data.sceneItemEnabled === false), ['静音 主'], '主'],
  ['定位请求没发出去', obs => obs.refuseOnce('定位素材'), ['静音 主', '隐藏 主', 'PAUSE 主', '静音 预备', '显示 预备', '切场景'], '预备'],
  ['切到素材后操作员按了暂停', obs => obs.pauseAfterSwitch(), ['静音 主', '隐藏 主', 'PAUSE 主', '静音 预备', '显示 预备', '切场景'], '预备']
])('晚到交接中途失败（%s）：报错不重发，记下的解码器就是画面上的那个，同一素材后面的片段照常预热和播出', async (_case, inject, sent, shown) => {
  vi.useFakeTimers();
  try {
    const t = await handover(), [, second, third, fourth] = t.events;
    inject(t.obs);
    expect(await outcome(t.preload.execute({ ...second!, sourceOffsetMs: second!.sourceOffsetMs + 600 }, path))).not.toBe('完成');
    expect(t.obs.sent).toEqual(sent);
    t.obs.resume();
    // Transport controls and the clip's stop reach the decoder the audience sees.
    const onAir = shown === '主' ? t.primary : t.standby, other = shown === '主' ? t.standby : t.primary;
    expect(t.obs.onAir.at(-1)?.decoder ?? '主').toBe(shown);
    expect(t.preload.resolveSource(t.primary)).toBe(onAir);
    expect([t.scenes.isActive(onAir), t.scenes.isActive(other)]).toEqual([true, false]);
    for (const [frame, event] of [[450, third!], [800, fourth!]] as const) {
      expect(await t.preload.upcoming(frame, current)).toMatchObject({ clipId: event.clipId });
      await t.preload.execute(event, path);
      expect(t.obs.onAir.at(-1)).toMatchObject({ decoder: t.preload.resolveSource(t.primary) === t.primary ? '主' : '预备', state: 'PLAYING', cursor: 100 });
    }
    expect(t.obs.sent.filter(entry => entry.startsWith('RESTART'))).toEqual([]);
  } finally { vi.useRealTimers(); }
});

it('晚到交接的定位晚 600 ms 才落定：片段已经在画面上，照常报晚；之后的漂移检查把它拉回和音乐同步', async () => {
  vi.useFakeTimers();
  try {
    const t = await handover(), late = { ...t.events[1]!, sourceOffsetMs: 700 };
    const started = performance.now(), music = (): number => late.sourceOffsetMs + performance.now() - started;
    t.obs.seekDelay(600);
    expect(await outcome(t.preload.execute(late, path))).toContain('比音乐晚了');
    expect(t.obs.decoder(t.standby)).toMatchObject({ state: 'OBS_MEDIA_STATE_PLAYING', enabled: true });
    expect(t.obs.position(t.standby) - music()).toBeLessThan(-300);
    t.obs.seekDelay(0);
    // The session's drift check every 5 s, on the decoder the preload resolves for this material.
    await vi.advanceTimersByTimeAsync(5000);
    const correction = t.scenes.correctDrift({ ...late, sourceName: t.preload.resolveSource(late.sourceName) }, music);
    expect(await outcome(correction)).toBe('完成');
    const drift = await correction;
    expect(drift, '漂移检查没有校正画面上的片段').not.toBeNull();
    expect(drift ?? 0).toBeLessThan(-300);
    expect(Math.abs(t.obs.position(t.standby) - music())).toBeLessThanOrEqual(100);
  } finally { vi.useRealTimers(); }
});

it('交接还在等 OBS 回应时不抢正在退役的解码器：同一素材下一段等交接做完再预热，照常按时开播', async () => {
  vi.useFakeTimers();
  try {
    const t = await handover();
    const release = t.obs.holdNextBatch();
    const starting = t.preload.execute(t.events[1]!, path);
    await untilHeld(t.obs);
    // A clock sample while OBS has not carried out the handover: clip-2 is inside the lookahead.
    expect(await t.preload.upcoming(450, current)).toBeNull();
    release(); await starting;
    expect(await t.preload.upcoming(453, current)).toMatchObject({ clipId: 'clip-2' });
    expect(t.obs.sent).toContain('预热 主 从已解码画面重启');
    await t.preload.execute(t.events[2]!, path);
    expect(t.obs.onAir.at(-1)).toMatchObject({ decoder: '主', state: 'PLAYING', cursor: 100 });
  } finally { vi.useRealTimers(); }
});

it('片段停止还在等 OBS 回应时不预热同一个解码器：停完后再准备下一段，从已解码画面重启，照常按时开播', async () => {
  vi.useFakeTimers();
  try {
    // clip-0 [0,6) s, then clip-1 [16,22) s of the same video: clip-1 enters the 10 s lookahead just after clip-0 stops.
    const project = song([[0, 6000], [16, 6000]], undefined, 100), obs = fakeObs();
    const scenes = new ObsMediaScenes(obs.client, obs.request, operation => operation());
    const preload = new ObsMediaPreload(project, 'song', scenes, obs.native);
    const [first, second] = new SceneOutputTimeline(project, 'song').preloadEntries();
    await scenes.prepare(project.projectId, project.mediaAssets[0]!, path);
    preload.register(project.projectId, project.mediaAssets[0]!, path);
    await preload.prime(first!, current); await preload.execute(first!, path);
    expect(await preload.upcoming(170, current)).toBeNull();
    obs.sent.length = 0;
    const release = obs.holdNextBatch();
    const stopping = preload.execute({ ...first!, phase: 'stop', frameNumber: 180 }, path);
    await untilHeld(obs);
    expect(await preload.upcoming(181, current)).toBeNull();
    release(); await stopping;
    expect(await preload.upcoming(182, current)).toMatchObject({ clipId: 'clip-1' });
    expect(obs.sent).toEqual(['PAUSE 主', '静音 主', '隐藏 主', '静音 主', '预热 主 从已解码画面重启']);
    await preload.execute(second!, path);
    expect(obs.onAir.at(-1)).toMatchObject({ decoder: '主', state: 'PLAYING', cursor: 100 });
  } finally { vi.useRealTimers(); }
});

it('片段停止还在等 OBS 回应时，同一素材已经到点、还没准备的下一段也等停完再准备，然后按当前位置晚开播', async () => {
  vi.useFakeTimers();
  try {
    // clip-0 [0,6) s and clip-1 [7,13) s of the same video; clip-1 was never prepared (no clock sample before its start).
    const project = song([[0, 6000], [7, 6000]], undefined, 100), obs = fakeObs();
    const scenes = new ObsMediaScenes(obs.client, obs.request, operation => operation());
    const preload = new ObsMediaPreload(project, 'song', scenes, obs.native);
    const [first, second] = new SceneOutputTimeline(project, 'song').preloadEntries();
    await scenes.prepare(project.projectId, project.mediaAssets[0]!, path);
    preload.register(project.projectId, project.mediaAssets[0]!, path);
    await preload.prime(first!, current); await preload.execute(first!, path);
    obs.sent.length = 0;
    const release = obs.holdNextBatch();
    // OBS is behind: clip-0's stop goes out when clip-1 should already be on air.
    const stopping = preload.execute({ ...first!, phase: 'stop', frameNumber: 180 }, path);
    await untilHeld(obs);
    expect(await preload.upcoming(215, current)).toBeNull();
    release(); await stopping;
    expect(await preload.upcoming(216, current)).toMatchObject({ clipId: 'clip-1' });
    expect(obs.sent).toEqual(['PAUSE 主', '静音 主', '隐藏 主', '静音 主', '预热 主 从已解码画面重启']);
    // The program then starts it late at the current position (recovery rule B).
    const late = { ...second!, sourceOffsetMs: second!.sourceOffsetMs + 200 };
    expect(await outcome(preload.execute(late, path))).toBe('完成');
    expect(obs.onAir.at(-1)).toMatchObject({ decoder: '主', state: 'PLAYING' });
  } finally { vi.useRealTimers(); }
});

it('片段停止没送到 OBS：报错不重发，画面上的解码器仍记在这个素材名下，下一段从它交接出来，不会被它盖住', async () => {
  vi.useFakeTimers();
  try {
    // clip-0 [0,6) s, clip-1 [7,13) s and clip-2 [14,20) s of the same video, with gaps between.
    const project = song([[0, 6000], [7, 6000], [14, 6000]], undefined, 100), obs = fakeObs();
    const scenes = new ObsMediaScenes(obs.client, obs.request, operation => operation());
    const preload = new ObsMediaPreload(project, 'song', scenes, obs.native);
    const [first, second, third] = new SceneOutputTimeline(project, 'song').preloadEntries();
    await scenes.prepare(project.projectId, project.mediaAssets[0]!, path);
    preload.register(project.projectId, project.mediaAssets[0]!, path);
    const primary = first!.sourceName, standby = `${primary}·预备`;
    await preload.prime(first!, current); await preload.execute(first!, path);
    expect(await preload.upcoming(60, current)).toMatchObject({ clipId: 'clip-1' });
    await preload.execute({ ...first!, phase: 'stop', frameNumber: 180 }, path);
    await preload.execute(second!, path);
    expect(await preload.upcoming(240, current)).toMatchObject({ clipId: 'clip-2' });
    // OBS is busy at clip-1's end: the stop waits too long in the queue and is never sent.
    obs.refuseOnce('素材场景批量控制');
    await expect(preload.execute({ ...second!, phase: 'stop', frameNumber: 390 }, path)).rejects.toThrow('还没发送');
    expect(obs.onAir.at(-1)).toMatchObject({ decoder: '预备', state: 'PLAYING' });
    // Pause and resume reach the decoder the audience sees.
    expect(preload.resolveSource(primary)).toBe(standby);
    obs.sent.length = 0;
    await preload.execute(third!, path);
    expect(obs.sent.slice(0, 3)).toEqual(['静音 预备', '隐藏 预备', 'STOP 预备']);
    expect(obs.onAir.at(-1)).toMatchObject({ decoder: '主', state: 'PLAYING', cursor: 100 });
    expect(preload.resolveSource(primary)).toBe(primary);
  } finally { vi.useRealTimers(); }
});

it('预热好的短片段整段落在 OBS 卡住时的积压里、被合并跳过：同一素材的下一个片段照常按时开播（2026-11-09）', async () => {
  // clip-0 [0,2) s, a camera [2,3) s above, a short clip-1 [3,3.5) s, clip-2 [8,10) s: one video on one track.
  const project = song([[0, 2000], [3, 500], [8, 2000]], [2, 1]), obs = fakeObs();
  const scenes = new ObsMediaScenes(obs.client, obs.request, operation => operation());
  const preload = new ObsMediaPreload(project, 'song', scenes, obs.native);
  await scenes.prepare(project.projectId, project.mediaAssets[0]!, path);
  preload.register(project.projectId, project.mediaAssets[0]!, path);
  await preload.prime(new SceneOutputTimeline(project, 'song').preloadEntries()[0]!, current);
  let now = 0, answer = (): void => undefined;
  const cameraAnswered = new Promise<void>(resolve => { answer = resolve; });
  const reports: string[] = [];
  const session = new ObsProgramSession(project, 'C:/shows/test.tblink', 'song', {
    now: () => now, fault: () => undefined,
    recordLog: vi.fn<LinkDesktopApi['recordLog']>(entry => Promise.resolve({ ...entry, id: 'log', sessionId: 'test', timestamp: '2026-11-09T00:00:00Z', monotonicMs: now })),
    executeManagedMediaEvent: ({ event }) => preload.execute(event, path),
    guardOutput: <T>(_canSend: () => boolean, operation: () => Promise<T>) => operation(),
    prepareOutputs: () => Promise.resolve(), releaseOutputs: () => preload.close(),
    prepareUpcoming: (frame, assertCurrent) => preload.upcoming(frame, assertCurrent),
    seekMedia: () => Promise.resolve(),
    mediaReport: report => { reports.push(`${report.event.clipId} ${report.event.phase} ${report.status}${report.error ? `：${report.error}` : ''}`); },
    cueReport: () => undefined, state: () => undefined,
    executor: { id: 'obs', supports: action => action.kind.startsWith('obs.'), execute: async action => { if (action.id === 'camera-action') await cameraAnswered; } } });
  await session.prepare(0);
  const tick = async (at: number, settle: boolean): Promise<void> => {
    now = at; session.clock(at);
    if (settle) await session.settled();
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  for (let at = 0; at < 2000; at += 100) await tick(at, true);
  // OBS answers the camera switch at 2 s only after 1.6 s: under the 2 s limit, the connection stays.
  for (let at = 2000; at <= 3600; at += 100) await tick(at, false);
  answer();
  for (let at = 3700; at <= 9000; at += 100) await tick(at, true);
  expect(reports).toContain('clip-2 start succeeded');
  expect(reports.filter(line => line.startsWith('clip-1') || line.includes('failed'))).toEqual([]);
  expect(obs.onAir.at(-1)).toMatchObject({ decoder: '主', state: 'PLAYING' });
  await session.stop();
});
