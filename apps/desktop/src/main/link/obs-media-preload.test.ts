import type { OBSWebSocket } from 'obs-websocket-js';
import { expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type LinkAction, type LinkProject, type ReferenceCanvasTransform } from '@tb/schema';
import { MediaPreparationFailed, ObsProgramSession, SceneOutputTimeline, materialSceneNames, obsMaterialPresentation, type CueExecutionReport, type LinkDesktopApi, type ManagedMediaEvent } from '@tb/core/link';
import { ObsMediaPreload, ObsPreparationNotNeeded } from './obs-media-preload';
import { MediaOutOfStepError, ObsMediaScenes, lookFailure, opacityFailure } from './obs-media-scenes';
import { pictureDriftCheck, pictureExecutor, pictureSeekStep, pictureUpcoming } from './native-obs-outputs';
import { MemoryMaterialOwnLooks, type MaterialOwnLooks, type OwnLook } from './obs-material-own-looks';
import { ObsLiveEditor } from './obs-live-editor';

function mockScenes() {
  return { prepareStandby: vi.fn<ObsMediaScenes['prepareStandby']>(name => Promise.resolve(`${name}·预备`)),
    copyPresentation: vi.fn<ObsMediaScenes['copyPresentation']>(() => Promise.resolve()),
    prime: vi.fn<ObsMediaScenes['prime']>(async (_event, _path, run) => { await run(); }),
    execute: vi.fn<ObsMediaScenes['execute']>(() => Promise.resolve()), seek: vi.fn<ObsMediaScenes['seek']>(() => Promise.resolve(null)),
    isActive: vi.fn<ObsMediaScenes['isActive']>(() => false), continueClip: vi.fn<ObsMediaScenes['continueClip']>(() => false) };
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

/** One video on one track, `[start s, length ms, source offset ms]` per clip (the offset defaults to
 * `sourceOffsetMs`), and a camera `[start s, length s]` above it. */
function song(clips: ReadonlyArray<readonly [number, number, number?]>, camera?: readonly [number, number], sourceOffsetMs = 0): LinkProject {
  return parseLinkProject({ ...createEmptyLinkProject('预备'), playbackSource: 'internal', obsOutputMode: 'scenes',
    mediaAssets: [{ id: 'video', name: '视频', kind: 'video', relativePath: 'assets/video.mp4', sha256: 'a'.repeat(64), byteLength: 1, durationMs: 60000, width: 1920, height: 1080 }],
    rundown: [{ id: 'song', title: '歌曲', visualLayers: [{ id: 'camera', name: '机位' }, { id: 'video-layer', name: '视频' }],
      referenceMediaClips: clips.map(([seconds, durationMs, offset], index) => ({ id: `clip-${index}`, assetId: 'video', layerId: 'video-layer', label: '视频',
        startTimecode: { hours: 0, minutes: 0, seconds, frames: 0 }, durationMs, sourceOffsetMs: offset ?? sourceOffsetMs })),
      cues: camera ? [{ id: 'camera-cue', name: '机位', layerId: 'camera', timecode: { hours: 0, minutes: 0, seconds: camera[0], frames: 0 }, durationMs: camera[1] * 1000,
        actions: [{ id: 'camera-action', kind: 'obs.setProgramScene', label: '机位', sceneName: '机位1' }] }] : [] }] });
}
function mocked(project: LinkProject) {
  const scenes = mockScenes(), native = mockNative(), preload = new ObsMediaPreload(project, 'song', scenes, native);
  preload.register(project.projectId, project.mediaAssets[0]!, path);
  return { preload, scenes, native, events: new SceneOutputTimeline(project, 'song').preloadEntries() };
}

type FakeInput = { scene: string; item: number; state: string; base: number; since: number; muted: boolean; enabled: boolean; look?: Record<string, unknown> };
/** A write of a scene item's look: whose, to what, and whether the audience saw that item then. */
type LookWrite = { sceneName: string; input: string; look: Record<string, unknown>; onAir: boolean };
type OnAir = { decoder: string | null; state: string; cursor: number };
type Batch = Array<{ requestType: string; requestData?: Record<string, unknown> }>;
/** What OBS reports for a scene item nothing set: every settable field, as GetSceneItemTransform answers. */
const itemDefaults = { positionX: 0, positionY: 0, rotation: 0, scaleX: 1, scaleY: 1, alignment: 5, boundsType: 'OBS_BOUNDS_NONE', boundsAlignment: 0,
  boundsWidth: 0, boundsHeight: 0, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 };
/** OBS keeping each input's own state, as on the field machine: which decoder the
 * audience sees on program, whether it plays and where. A paused cursor stays put;
 * a playing one runs with the clock. `sent` lists the writes OBS carried out. */
function fakeObs() {
  const inputs = new Map<string, FakeInput>(), sceneNames = new Set<string>();
  let nextItem = 1, program = '', seekDelayMs = 0, cancelled = false, cancelAfterSwitch = false;
  /** The next matching batch waits here: sent, but OBS has not carried it out yet. */
  let gate: { match: (batch: Batch) => boolean; wait: Promise<void> } | null = null, holding = false;
  const sent: string[] = [], onAir: OnAir[] = [], lookWrites: LookWrite[] = [];
  /** Each time the audience sees another input, or the one it sees gets another look: the input, its look and the
   * opacity its enabled picture filter gives it (null: none, E17). */
  const seenLooks: Array<{ input: string | null; look: string; opacity?: number | null }> = [];
  /** Each source's filters, in order (E17); and each filter request OBS carried out: what, on which source, whether
   * the audience saw that source then. */
  const filters = new Map<string, Array<{ filterName: string; filterKind: string; filterEnabled: boolean; filterSettings: Record<string, unknown> }>>();
  const filterWrites: Array<{ type: string; sourceName: string; filterName: string; onAir: boolean }> = [];
  /** Filter kinds OBS does not know. */
  const unknownFilterKinds = new Set<string>();
  /** The source of each filter list the console read for its picture filter (E17), in order: not the two lists of a
   * copy to the standby decoder, which copies the operator's filters as before. */
  const filterReads: string[] = [];
  /** The source of every filter list OBS was asked for, these two lists of a copy included. */
  const filterLists: string[] = [];
  let requestLabel = '';
  /** The file of each image input. */
  const images = new Map<string, string>();
  const filterOf = (data: Record<string, unknown>) => {
    const found = filters.get(String(data.sourceName))?.find(entry => entry.filterName === data.filterName);
    if (!found) throw new Error(`OBS 里没有这个滤镜：${String(data.filterName)}`);
    return found;
  };
  const writeFilter = (type: string, data: Record<string, unknown>): void => {
    const target = input(data.sourceName);
    filterWrites.push({ type, sourceName: String(data.sourceName), filterName: String(data.filterName), onAir: target.enabled && target.scene === program });
  };
  const pictureOpacity = (name: string): number | null => {
    const own = filters.get(name)?.find(entry => entry.filterName === '联动台·画面调节' && entry.filterEnabled);
    return own ? Number(own.filterSettings.opacity) : null;
  };
  const landing = new Map<string, { at: number; to: number }>();
  const itemOf = (data: Record<string, unknown>): [string, FakeInput] | undefined => [...inputs].find(([, candidate]) => candidate.scene === data.sceneName && candidate.item === data.sceneItemId);
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
  /** Every request OBS got, by type, in order. */
  const requests: string[] = [];
  const handle = (type: string, data: Record<string, unknown>): unknown => {
    requests.push(type);
    if (failures.some(failure => failure(type, data))) throw new Error(`OBS 没能执行 ${type}`);
    switch (type) {
      case 'GetSceneList': return { scenes: [...sceneNames].map(sceneName => ({ sceneName })) };
      case 'CreateScene': sceneNames.add(String(data.sceneName)); return {};
      case 'CreateInput': {
        const item = nextItem++;
        inputs.set(String(data.inputName), { scene: String(data.sceneName), item, state: 'OBS_MEDIA_STATE_STOPPED', base: 0, since: 0, muted: false, enabled: data.sceneItemEnabled === true });
        if (data.inputKind === 'image_source') images.set(String(data.inputName), String((data.inputSettings as { file?: unknown }).file));
        return { sceneItemId: item };
      }
      case 'GetVideoSettings': return { baseWidth: 1080, baseHeight: 1920 };
      case 'GetInputSettings': if (images.has(String(data.inputName))) return { inputKind: 'image_source', inputSettings: { file: images.get(String(data.inputName)), unload: false } };
        return { inputKind: 'ffmpeg_source', inputSettings: { local_file: path, hw_decode: true, restart_on_activate: false, close_when_inactive: false, looping: false } };
      case 'GetSceneItemList': return { sceneItems: [...inputs].filter(([, entry]) => entry.scene === data.sceneName).map(([sourceName, entry]) => ({ sourceName, sceneItemId: entry.item })) };
      case 'GetSceneItemTransform': return { sceneItemTransform: { ...itemDefaults, sourceWidth: 1080, sourceHeight: 1920, ...itemOf(data)?.[1].look } };
      case 'GetCurrentProgramScene': return { sceneName: program };
      case 'GetSceneItemLocked': return { sceneItemLocked: false };
      case 'GetSourceFilterList': filterLists.push(String(data.sourceName)); if (requestLabel === '读取素材来源的滤镜') filterReads.push(String(data.sourceName)); return { filters: (filters.get(String(data.sourceName)) ?? []).map((entry, filterIndex) => ({ ...entry, filterIndex })) };
      case 'CreateSourceFilter': {
        if (unknownFilterKinds.has(String(data.filterKind))) throw new Error(`没有这种滤镜：${String(data.filterKind)}`);
        writeFilter(type, data);
        const list = filters.get(String(data.sourceName)) ?? [];
        if (list.some(entry => entry.filterName === data.filterName)) throw new Error('滤镜名称已被占用');
        list.push({ filterName: String(data.filterName), filterKind: String(data.filterKind), filterEnabled: true, filterSettings: { ...data.filterSettings as Record<string, unknown> } });
        filters.set(String(data.sourceName), list); return {};
      }
      case 'SetSourceFilterSettings': { const found = filterOf(data); writeFilter(type, data); found.filterSettings = { ...data.overlay === false ? {} : found.filterSettings, ...data.filterSettings as Record<string, unknown> }; return {}; }
      case 'SetSourceFilterEnabled': { const found = filterOf(data); writeFilter(type, data); found.filterEnabled = data.filterEnabled === true; return {}; }
      case 'SetSourceFilterIndex': {
        const list = filters.get(String(data.sourceName)) ?? [], found = filterOf(data);
        list.splice(list.indexOf(found), 1); list.splice(Number(data.filterIndex), 0, found); return {};
      }
      case 'RemoveSourceFilter': { const found = filterOf(data); writeFilter(type, data); const list = filters.get(String(data.sourceName))!; list.splice(list.indexOf(found), 1); return {}; }
      case 'GetSourceScreenshot': return { imageData: 'data:image/png;base64,x' };
      case 'SetSceneItemTransform': {
        const entry = itemOf(data);
        if (!entry) throw new Error('OBS 里没有这个场景项');
        const look = data.sceneItemTransform as Record<string, unknown>;
        lookWrites.push({ sceneName: String(data.sceneName), input: entry[0], look, onAir: entry[1].enabled && entry[1].scene === program });
        entry[1].look = { ...entry[1].look, ...look };
        return {};
      }
      case 'SetInputSettings': return {};
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
  /** What the audience sees now: the top shown input of the program scene. */
  const seen = (): OnAir => {
    const top = [...inputs].filter(([, entry]) => entry.scene === program && entry.enabled).sort((a, b) => b[1].item - a[1].item)[0];
    return top ? { decoder: decoder(top[0]), state: top[1].state.replace('OBS_MEDIA_STATE_', ''), cursor: Math.round(cursor(top[1])) } : { decoder: null, state: '', cursor: 0 };
  };
  const look = (): void => {
    const view = seen();
    const last = onAir.at(-1);
    if (!last || last.decoder !== view.decoder || last.state !== view.state || last.cursor !== view.cursor) onAir.push(view);
    const top = [...inputs].filter(([, entry]) => entry.scene === program && entry.enabled).sort((a, b) => b[1].item - a[1].item)[0];
    const opacity = top ? pictureOpacity(top[0]) : null;
    const now = { input: top?.[0] ?? null, look: JSON.stringify(top?.[1].look ?? null), ...opacity !== null ? { opacity } : {} }, previous = seenLooks.at(-1);
    if (!previous || previous.input !== now.input || previous.look !== now.look || previous.opacity !== now.opacity) seenLooks.push(now);
  };
  const client = {
    /** OBS's events: the fake sends none. */
    on: (): void => undefined,
    call: (type: string, data: Record<string, unknown> = {}) => {
      try { const result = handle(type, data); look(); return Promise.resolve(result); }
      catch (error) { return Promise.reject(error instanceof Error ? error : new Error(String(error))); }
    },
    callBatch: async (batch: Batch) => {
      if (gate?.match(batch)) { const { wait } = gate; gate = null; holding = true; await wait; holding = false; }
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
    client: client as unknown as OBSWebSocket, sent, onAir, lookWrites, seenLooks, filters, filterWrites, unknownFilterKinds, filterReads, filterLists, requests, view: seen, decoder: (name: string): FakeInput => input(name), position: (name: string): number => Math.round(cursor(input(name))),
    /** The scene on program. */
    program: (): string => program,
    request: <T>(operation: () => Promise<T>, label: string): Promise<T> => {
      if (cancelled) return Promise.reject(new Error(`OBS 动作已取消或已过时，没有发送：${label}`));
      const refused = refusals.map(refusal => refusal(label)).find(reason => reason !== null);
      if (refused) return Promise.reject(new Error(refused));
      requestLabel = label;
      try { return operation(); } finally { requestLabel = ''; }
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
    /** OBS is slow to answer the next batch (the next one `match` picks): it carries it out once released. */
    holdNextBatch: (match: (batch: Batch) => boolean = () => true): (() => void) => {
      let release = (): void => undefined;
      gate = { match, wait: new Promise<void>(resolve => { release = resolve; }) };
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
/** `project` with a point Cue at `seconds` that switches a filter on a camera: an action of its own, no picture. */
function withPointCue(project: LinkProject, seconds: number): LinkProject {
  const item = project.rundown[0]!;
  return parseLinkProject({ ...project, rundown: [{ ...item, cues: [...item.cues, { id: 'point', name: '滤镜', timecode: { hours: 0, minutes: 0, seconds, frames: 0 },
    actions: [{ id: 'filter-action', kind: 'obs.setSourceFilterEnabled', label: '滤镜', sourceName: '机位1', filterName: '模糊', enabled: true }] }] }] });
}
/** `project` with a picture `[start s, length ms]` on a track above everything else. */
function withLogo(project: LinkProject, [seconds, durationMs]: readonly [number, number]): LinkProject {
  const item = project.rundown[0]!;
  return parseLinkProject({ ...project,
    mediaAssets: [...project.mediaAssets, { id: 'logo', name: '台标', kind: 'image', relativePath: 'assets/logo.png', sha256: 'b'.repeat(64), byteLength: 1, width: 512, height: 512 }],
    rundown: [{ ...item, visualLayers: [{ id: 'logo-layer', name: '台标' }, ...item.visualLayers],
      referenceMediaClips: [...item.referenceMediaClips, { id: 'logo-clip', assetId: 'logo', layerId: 'logo-layer', label: '台标',
        startTimecode: { hours: 0, minutes: 0, seconds, frames: 0 }, durationMs, sourceOffsetMs: 0 }] }] });
}
/** `project` with these cameras `[start s, length s]` on the camera track above the video. */
function withCameras(project: LinkProject, spans: ReadonlyArray<readonly [number, number]>): LinkProject {
  const item = project.rundown[0]!;
  return parseLinkProject({ ...project, rundown: [{ ...item, cues: spans.map(([seconds, length], index) => ({ id: `camera-cue-${index}`, name: '机位', layerId: 'camera',
    timecode: { hours: 0, minutes: 0, seconds, frames: 0 }, durationMs: length * 1000,
    actions: [{ id: `camera-action-${index}`, kind: 'obs.setProgramScene', label: '机位', sceneName: '机位1' }] })) }] });
}
/** What the adapter does with a song's picture actions (obs-websocket-adapter.ts): a
 * scene switch goes through ObsMediaScenes (a composition through compose), a media
 * action is OBS's TriggerMediaInputAction on the input it names. `other` answers the
 * rest; `received` lists every action as it reached the adapter. */
function adapter(obs: FakeObs, scenes: ObsMediaScenes, other: (action: LinkAction) => Promise<void>, received: LinkAction[]) {
  const media = { restart: 'RESTART', start: 'PLAY', stop: 'STOP', pause: 'PAUSE', next: 'NEXT', previous: 'PREVIOUS' } as const;
  return { id: 'obs', supports: (action: LinkAction): boolean => action.kind.startsWith('obs.'),
    execute: async (action: LinkAction): Promise<void> => {
      received.push(action);
      if (action.kind === 'obs.setProgramScene') return action.sceneLayers ? scenes.compose(action.sceneName, action.sceneLayers) : scenes.switchScene(action.sceneName);
      if (action.kind === 'obs.mediaAction') {
        await obs.client.call('TriggerMediaInputAction', { inputName: action.inputName, mediaAction: `OBS_WEBSOCKET_MEDIA_INPUT_ACTION_${media[action.action]}` });
        return;
      }
      return other(action);
    },
    setSourceEnabledInProgramScene: (sourceName: string, enabled: boolean): Promise<void> => other({ id: 'shown', kind: 'obs.setSceneItemEnabled', label: '显示', sceneName: '', sourceName, enabled }) };
}
/** A run log that keeps what it is given. */
function recorder(clock: () => number = () => 0) {
  return vi.fn<LinkDesktopApi['recordLog']>(entry => Promise.resolve({ ...entry, id: 'log', sessionId: 'test', timestamp: '2026-11-09T00:00:00Z', monotonicMs: clock() }));
}
/** The program plays `project` on the per-input fake OBS as on the field machine:
 * every material prepared, the opening clips and their successors primed before
 * the clock starts (only the opening clips for a cold auto-next song, `following`
 * false). The music clock is moved by hand; `answer` is how OBS answers each
 * timeline action other than media, `reports` lists how each media action ended
 * and `faults` what the program reported besides. With `wiring` 'production' the
 * actions go through the executor, the drift check and the lookahead of
 * native-obs-outputs.ts, to an adapter that switches scenes and sends media actions
 * as the real one does; `answer` then answers the other actions. */
async function live(project: LinkProject, obs: FakeObs, answer: (action: LinkAction) => Promise<void> = () => Promise.resolve(), following = true, wiring: 'test' | 'production' = 'test',
  ownLooks: MaterialOwnLooks = new MemoryMaterialOwnLooks()) {
  const scenes = new ObsMediaScenes(obs.client, obs.request, operation => operation(), ownLooks);
  const preload = new ObsMediaPreload(project, 'song', scenes, obs.native);
  const file = (relativePath: string): string => `C:/shows/${relativePath}`;
  for (const asset of project.mediaAssets) {
    await scenes.prepare(project.projectId, asset, file(asset.relativePath));
    preload.register(project.projectId, asset, file(asset.relativePath));
  }
  for (const event of new SceneOutputTimeline(project, 'song').at(0).media) {
    if (event.assetKind === 'image') continue;
    await preload.prime(event, current); if (following) await preload.primeFollowing(event, current);
  }
  let now = 0;
  const reports: string[] = [], faults: string[] = [], received: LinkAction[] = [], cues: CueExecutionReport[] = [];
  const logs = recorder(() => now);
  const production = wiring === 'production';
  const session = new ObsProgramSession(project, 'C:/shows/test.tblink', 'song', {
    now: () => now, fault: message => { faults.push(message); },
    recordLog: logs,
    executeManagedMediaEvent: ({ event }) => preload.execute(event, file(event.relativePath)),
    guardOutput: <T>(_canSend: () => boolean, operation: () => Promise<T>) => operation(),
    prepareOutputs: () => Promise.resolve(), holdOutputs: () => Promise.resolve(), releaseOutputs: () => preload.close(),
    prepareUpcoming: production ? pictureUpcoming(preload, { record: logs, projectId: project.projectId, itemId: 'song' })
      : (frame, assertCurrent) => preload.upcoming(frame, assertCurrent),
    seekMedia: () => Promise.resolve(),
    mediaReport: report => { reports.push(`${report.event.clipId} ${report.event.phase} ${report.status}${report.error ? `：${report.error}` : ''}`); },
    cueReport: report => { cues.push(report); }, state: () => undefined,
    executor: production ? pictureExecutor(adapter(obs, scenes, answer, received), preload, { record: logs, projectId: project.projectId, itemId: 'song' })
      : { id: 'obs', supports: action => action.kind.startsWith('obs.'), execute: answer },
    ...(production ? { correctMediaDrift: pictureDriftCheck(scenes, preload) } : {}) });
  await session.prepare(0);
  /** The music moves from `from` to `to` ms in 100 ms steps. `settle` waits for each step's actions, as when OBS keeps up. */
  const play = async (from: number, to: number, settle: boolean): Promise<void> => {
    for (let at = from; at <= to; at += 100) {
      now = at; session.clock(at);
      if (settle) await session.settled();
      // After `settled` nothing of this step is left to wait for, so no timer: a Windows timer ticks about every 16 ms,
      // and the 251 steps of a 25 s song took a test past its 5 s limit there. Without `settle` time has to pass, as before.
      await new Promise(resolve => { if (settle) setImmediate(resolve); else setTimeout(resolve, 0); });
    }
  };
  /** Under fake timers: the music moves from `from` to `to` ms in 100 ms steps on the
   * clock OBS keeps, so a decoder playing on stays where the music is. What the
   * program sends meanwhile runs in that time, as on the field machine. */
  const run = async (from: number, to: number): Promise<void> => {
    for (let at = from; at <= to; at += 100) { now = at; session.clock(at); await vi.advanceTimersByTimeAsync(100); }
  };
  /** The music is at `ms`, for the program's own clock reads (a pause, a resume). */
  const at = (ms: number): void => { now = ms; };
  return { scenes, preload, session, reports, faults, play, run, at, logs, received, cues,
    failures: (): string[] => reports.filter(line => line.includes(' failed')),
    /** Actions the program sent that ended failed (scene switches, pauses, resumes). */
    failedActions: (): string[] => cues.flatMap(report => report.results).filter(result => result.status === 'failed').map(result => `${result.action.label}：${result.error ?? ''}`) };
}
/** Settles `operation` under fake timers, letting OBS's polls run. */
async function settle<T>(operation: Promise<T>): Promise<T> {
  let done = false;
  void operation.then(() => { done = true; }, () => { done = true; });
  for (let spent = 0; !done && spent < 5000; spent += 20) await vi.advanceTimersByTimeAsync(20);
  return operation;
}
/** One video cut into clips on one track at `frameRate`, `[start ms, length ms, place in the
 * file ms, own sound]` each, with `cameras` `[start ms, length ms]` on the track above. A
 * clip's own sound plays along with the music when it has it on. */
function cutVideo(clips: ReadonlyArray<readonly [number, number, number, boolean?]>, cameras: ReadonlyArray<readonly [number, number]> = [], frameRate: '25' | '30' = '30'): LinkProject {
  const at = (ms: number) => ({ hours: 0, minutes: 0, seconds: Math.floor(ms / 1000), frames: Math.round((ms % 1000) * Number(frameRate) / 1000) });
  return parseLinkProject({ ...createEmptyLinkProject('切开'), playbackSource: 'internal', obsOutputMode: 'scenes', internalVideoAudio: true,
    timebase: { frameRate, mode: 'per-item-reset' },
    mediaAssets: [{ id: 'video', name: '视频', kind: 'video', relativePath: 'assets/video.mp4', sha256: 'a'.repeat(64), byteLength: 1, durationMs: 60000, width: 1920, height: 1080 }],
    rundown: [{ id: 'song', title: '歌曲', visualLayers: [{ id: 'camera', name: '机位' }, { id: 'video-layer', name: '视频' }],
      referenceMediaClips: clips.map(([start, durationMs, sourceOffsetMs, sound = false], index) => ({ id: `clip-${index}`, assetId: 'video', layerId: 'video-layer', label: '视频',
        startTimecode: at(start), durationMs, sourceOffsetMs, embeddedAudioEnabled: sound })),
      cues: cameras.map(([start, durationMs], index) => ({ id: `camera-cue-${index}`, name: '机位', layerId: 'camera', timecode: at(start), durationMs,
        actions: [{ id: `camera-action-${index}`, kind: 'obs.setProgramScene', label: '机位', sceneName: '机位1' }] })) }] });
}
/** The second decoder's setup: holding this batch keeps a clip on it from getting ready in time. */
const standbySetup = (batch: Batch): boolean => batch.some(entry => entry.requestType === 'SetInputMute' && String(entry.requestData?.inputName).endsWith('·预备'));
/** Requests that move a decoder's media clock: none goes to a decoder that plays on in step. */
const transport = (entry: string): boolean => /^(PAUSE|PLAY|RESTART|STOP|定位) /.test(entry);
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
  return { project, obs, scenes, preload, events, primary, standby: `${primary}·预备` };
}
/** `count` other videos playing, each in its own scene, while `t`'s video hands over: a handover
 * mutes them first, in this order. Returns their inputs. */
async function othersPlaying(t: Awaited<ReturnType<typeof handover>>, count: number): Promise<string[]> {
  const inputs: string[] = [];
  for (let index = 0; index < count; index++) {
    const asset = { ...t.project.mediaAssets[0]!, id: `video-${index + 2}`, name: `视频${index + 2}` }, names = materialSceneNames(t.project.projectId, asset);
    await t.scenes.prepare(t.project.projectId, asset, path);
    const other = { ...t.events[1]!, ...names, clipId: `other-${index}`, assetId: asset.id, assetName: asset.name, frameNumber: 0, sourceOffsetMs: 0 };
    expect(await outcome(t.scenes.execute(other, path))).toBe('完成');
    inputs.push(names.sourceName);
  }
  t.obs.sent.length = 0;
  return inputs;
}
/** The red text of a handover OBS broke after the old picture went off and before the new one showed, at `request`. */
const gap = (request: string): string => `上一段的画面已经退下，这一段的画面没能显示出来。原因：${request}：OBS 没能执行 ${request}`;

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

it('预备失败放回预备槽：同一输入后面的片段照常准备和播出，失败的这一段不自动重试；它和上一段入点接不上，上一段在它的开始被拒绝时退下', async () => {
  // Every clip starts 100 ms into the file: clip-1 does not continue clip-0's picture.
  const t = setup(), [first, second, third] = t.events;
  await t.preload.prime(first!, current); await t.preload.execute(first!, t.path);
  t.native.prime.mockRejectedValueOnce(new Error('解码器无响应'));
  await expect(t.preload.upcoming(60, current)).rejects.toThrow('解码器无响应');
  expect(await t.preload.upcoming(400, current)).toBeNull();
  await expect(t.preload.execute(second!, t.path)).rejects.toThrow('没能在切换前准备好');
  expect(await t.preload.upcoming(450, current)).toMatchObject({ clipId: third!.clipId });
  await t.preload.execute(third!, t.path);
  expect(t.scenes.prime.mock.calls.map(([event]) => event.clipId)).toEqual(['clip-0', 'clip-1', 'clip-2']);
  // clip-1 never goes on air, but clip-0 still ends at the cut, when clip-1's start is refused: its own stop was left to clip-1's start.
  expect(t.scenes.execute.mock.calls.map(([event, , previous, retirement]) => [event.clipId, event.phase, event.sourceName === first!.sourceName ? '主' : '预备', previous ?? null, retirement]))
    .toEqual([['clip-0', 'start', '主', null, 'pause'], ['clip-0', 'stop', '主', null, 'pause'], ['clip-2', 'start', '主', null, 'stop']]);
  await t.preload.close();
});

it('预备失败的片段自己不再准备；画面会话允许（prepareAgain，次数记在会话那边）以后照常再准备一次，失败带着是哪一段（2026-11-10 第 2 题，R5）', async () => {
  const t = setup(), [first, second] = t.events;
  await t.preload.prime(first!, current); await t.preload.execute(first!, t.path);
  t.native.prime.mockRejectedValueOnce(new Error('解码器无响应'));
  const failure = await t.preload.upcoming(60, current).then(() => null, (error: unknown) => error);
  expect(failure).toBeInstanceOf(MediaPreparationFailed);
  expect(failure).toMatchObject({ message: '解码器无响应', event: { clipId: second!.clipId } });
  expect(await t.preload.upcoming(100, current)).toBeNull();
  t.preload.prepareAgain(second!.clipId);
  expect(await t.preload.upcoming(120, current)).toMatchObject({ clipId: second!.clipId });
  expect(t.scenes.prime.mock.calls.map(([event]) => event.clipId)).toEqual(['clip-0', 'clip-1', 'clip-1']);
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

it('片段还在准备时被定位接管（从中间开播或重建画面，用的就是这个解码器），之后准备没成：照常把失败交给节目，不当作接着上一段往下播', async () => {
  const t = setup(), [first, second] = t.events;
  await t.preload.prime(first!, current); await t.preload.execute(first!, t.path);
  let finish = (): void => undefined;
  t.scenes.prime.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const preparing = t.preload.upcoming(60, current);
  await vi.waitFor(() => expect(t.scenes.prime).toHaveBeenCalledTimes(2));
  // The seek puts clip-1 on air on the decoder it was being prepared on.
  await t.preload.seek(second!, t.path);
  finish();
  const failure = await preparing.then(() => null, (error: unknown) => error);
  // R5: the failure names the clip it was for, so the session can prepare it once more.
  expect(failure).toBeInstanceOf(MediaPreparationFailed);
  expect(failure).toMatchObject({ message: '素材准备结果已过期', event: { clipId: 'clip-1' } });
  expect(failure).not.toBeInstanceOf(ObsPreparationNotNeeded);
});

it('同一素材连着定位两次（拖动进度），前一次在 OBS 显示它之前失败时后一次还没答复：后一次照常算这个素材在画面上的，不被前一次的失败改成没在播', async () => {
  const t = setup(), [first, second] = t.events, primary = first!.sourceName;
  let failFirst: (error: Error) => void = () => undefined, finishSecond = (): void => undefined;
  t.scenes.seek.mockImplementationOnce(() => new Promise<string | null>((_resolve, reject) => { failFirst = reject; }))
    .mockImplementationOnce(() => new Promise<string | null>(resolve => { finishSecond = () => resolve(null); }));
  const firstSeek = t.preload.seek({ ...first!, sourceOffsetMs: 3000 }, t.path).then(() => null, (error: unknown) => error);
  const secondSeek = t.preload.seek({ ...second!, sourceOffsetMs: 5000 }, t.path);
  failFirst(new Error('OBS 没能执行 SetSceneItemEnabled'));
  expect(await firstSeek).toEqual(new Error('OBS 没能执行 SetSceneItemEnabled'));
  t.scenes.isActive.mockReturnValue(true);
  finishSecond(); await secondSeek;
  expect(t.preload.onAirSource(primary)).toBe(primary);
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
  await expect(t.preload.execute(second!, path)).rejects.toThrow(new Error('这一段素材没有播出：轮到它时这一段已经结束了，电脑或 OBS 当时太忙。后面的素材照常播，不用处理'));
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
    // The new decoder is shown before its sound is set: it is never audible while hidden.
    expect(t.obs.sent).toEqual(['静音 主', '隐藏 主', 'PAUSE 主', '显示 预备', '静音 预备', '切场景', 'PLAY 预备']);
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
  ['切到素材后操作员按了暂停', obs => obs.pauseAfterSwitch(), ['静音 主', '隐藏 主', 'PAUSE 主', '静音 预备', '显示 预备', '切场景'], '预备'],
  // The new decoder is already shown when OBS breaks the batch: it counts as on air.
  ['新解码器显示后切场景出错', obs => obs.failOnce(type => type === 'SetCurrentProgramScene'), ['静音 主', '隐藏 主', 'PAUSE 主', '静音 预备', '显示 预备'], '预备']
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
      const before = t.obs.sent.length, idle = t.preload.resolveSource(t.primary) === t.primary ? '预备' : '主';
      expect(await t.preload.upcoming(frame, current)).toMatchObject({ clipId: event.clipId });
      // The decoder off air was decoded and paused before: it restarts from there.
      expect(t.obs.sent.slice(before)).toContain(`预热 ${idle} 从已解码画面重启`);
      await t.preload.execute(event, path);
      expect(t.obs.onAir.at(-1)).toMatchObject({ decoder: t.preload.resolveSource(t.primary) === t.primary ? '主' : '预备', state: 'PLAYING', cursor: 100 });
    }
    expect(t.obs.sent.filter(entry => entry.startsWith('RESTART'))).toEqual([]);
  } finally { vi.useRealTimers(); }
});

it('晚到交接时 OBS 退下了旧解码器、却没能显示新解码器：报错写明这一段没有画面，两个解码器都不算在画面上，不重发；后面的片段照常播出', async () => {
  vi.useFakeTimers();
  try {
    const t = await handover(), [, second, third] = t.events;
    t.obs.failOnce((type, data) => type === 'SetSceneItemEnabled' && data.sceneItemEnabled === true);
    const message = await outcome(t.preload.execute({ ...second!, sourceOffsetMs: second!.sourceOffsetMs + 600 }, path));
    expect(t.obs.sent).toEqual(['静音 主', '隐藏 主', 'PAUSE 主', '静音 预备']);
    expect(t.obs.decoder(t.primary)).toMatchObject({ state: 'OBS_MEDIA_STATE_PAUSED', enabled: false, muted: true });
    expect(t.obs.decoder(t.standby)).toMatchObject({ state: 'OBS_MEDIA_STATE_PAUSED', enabled: false, muted: true });
    expect(t.obs.onAir.at(-1)).toEqual({ decoder: null, state: '', cursor: 0 });
    expect([t.scenes.isActive(t.primary), t.scenes.isActive(t.standby)]).toEqual([false, false]);
    expect(message).toBe(`${gap('SetSceneItemEnabled')}。后面的素材照常播`);
    // The new decoder still stands for clip-1, off air, and clip-1 is not started again.
    expect(t.preload.resolveSource(t.primary)).toBe(t.standby);
    expect(await t.preload.upcoming(400, current)).toBeNull();
    expect(await t.preload.upcoming(450, current)).toMatchObject({ clipId: 'clip-2' });
    await t.preload.execute(third!, path);
    expect(t.obs.onAir.at(-1)).toMatchObject({ decoder: '主', state: 'PLAYING', cursor: 100 });
    expect(t.obs.sent.filter(entry => entry.startsWith('RESTART'))).toEqual([]);
  } finally { vi.useRealTimers(); }
});

it('交接时 OBS 退下了旧解码器、却没能显示新解码器：这一段这时没有画面在播，暂停、继续和漂移检查都不发给任何解码器，也不算失败，日志各记一行；这一段的停止照常送到新解码器', async () => {
  vi.useFakeTimers();
  try {
    const t = await handover(), [, second] = t.events;
    t.obs.failOnce((type, data) => type === 'SetSceneItemEnabled' && data.sceneItemEnabled === true);
    expect(await outcome(t.preload.execute({ ...second!, sourceOffsetMs: second!.sourceOffsetMs + 600 }, path))).toBe(`${gap('SetSceneItemEnabled')}。后面的素材照常播`);
    const before = t.obs.sent.length, received: LinkAction[] = [], logs = recorder();
    const executor = pictureExecutor(adapter(t.obs, t.scenes, () => Promise.resolve(), received), t.preload, { record: logs, projectId: t.project.projectId, itemId: 'song' });
    for (const action of ['pause', 'start'] as const) await executor.execute({ id: action, label: '同步', kind: 'obs.mediaAction', inputName: t.primary, action });
    const drift = pictureDriftCheck(t.scenes, t.preload)({ ...second!, sourceOffsetMs: 9000 }, () => true);
    expect(await outcome(drift)).toBe('完成');
    expect(await drift).toBeNull();
    expect(t.obs.sent.slice(before)).toEqual([]);
    expect(received).toEqual([]);
    expect(t.preload.onAirSource(t.primary)).toBeNull();
    expect(logs.mock.calls.map(([entry]) => [entry.message, entry.result])).toEqual([
      ['素材暂停没有发给 OBS：这个素材这时没有画面在播，不用处理', 'skipped'], ['素材继续播放没有发给 OBS：这个素材这时没有画面在播，不用处理', 'skipped']]);
    // The new decoder still stands for clip-1, off air: clip-1's stop reaches it, hidden and muted.
    expect(await outcome(t.preload.execute({ ...second!, phase: 'stop', frameNumber: 720 }, path))).toBe('完成');
    expect(t.obs.sent.slice(before)).toEqual(['PAUSE 预备', '静音 预备', '隐藏 预备']);
  } finally { vi.useRealTimers(); }
});

it('按时交接时 OBS 退下了旧解码器、却没能显示新解码器（这一段开着原声）：报错写明这一段没有画面、后面照常播；新解码器仍静音、不算在画面上，后面的片段照常播出', async () => {
  vi.useFakeTimers();
  try {
    const t = await handover(), [, second, third] = t.events;
    t.obs.failOnce((type, data) => type === 'SetSceneItemEnabled' && data.sceneItemEnabled === true);
    const message = await outcome(t.preload.execute({ ...second!, embeddedAudioEnabled: true }, path));
    expect(message).toBe(`${gap('SetSceneItemEnabled')}。后面的素材照常播`);
    expect(t.obs.sent).toEqual(['静音 主', '隐藏 主', 'PAUSE 主']);
    // Hidden, the new decoder kept its sound off: a resume cannot make it heard.
    expect(t.obs.decoder(t.standby)).toMatchObject({ state: 'OBS_MEDIA_STATE_PAUSED', enabled: false, muted: true });
    expect(t.obs.view()).toEqual({ decoder: null, state: '', cursor: 0 });
    expect([t.scenes.isActive(t.primary), t.scenes.isActive(t.standby)]).toEqual([false, false]);
    expect(await t.preload.upcoming(450, current)).toMatchObject({ clipId: 'clip-2' });
    await t.preload.execute(third!, path);
    expect(t.obs.view()).toMatchObject({ decoder: '主', state: 'PLAYING', cursor: 100 });
  } finally { vi.useRealTimers(); }
});

it('晚到交接时有别的素材在播，OBS 隐藏了旧解码器、暂停它时出错：报错写明这一段没有画面，两个解码器都不算在画面上', async () => {
  vi.useFakeTimers();
  try {
    const t = await handover(), [, second] = t.events;
    await othersPlaying(t, 1);
    t.obs.failOnce((type, data) => type === 'TriggerMediaInputAction' && data.inputName === t.primary);
    const message = await outcome(t.preload.execute({ ...second!, sourceOffsetMs: second!.sourceOffsetMs + 600 }, path));
    expect(message).toBe(`${gap('TriggerMediaInputAction')}。后面的素材照常播`);
    // The other video's mute, then the old decoder's mute and hide.
    expect(t.obs.sent).toEqual(['静音 主', '静音 主', '隐藏 主']);
    expect(t.obs.decoder(t.primary)).toMatchObject({ enabled: false, muted: true });
    expect([t.scenes.isActive(t.primary), t.scenes.isActive(t.standby)]).toEqual([false, false]);
  } finally { vi.useRealTimers(); }
});

it.each([['晚到 600 ms', 600], ['按时', 0]])('交接时有三个别的素材在播（%s），OBS 静音最后一个时出错：旧解码器原样留在画面上、仍算在画面上，报 OBS 的原话', async (_case, lateMs) => {
  vi.useFakeTimers();
  try {
    const t = await handover(), [, second] = t.events;
    const others = await othersPlaying(t, 3);
    t.obs.failOnce((type, data) => type === 'SetInputMute' && data.inputName === others[2] && data.inputMuted === true);
    const message = await outcome(t.preload.execute({ ...second!, sourceOffsetMs: second!.sourceOffsetMs + lateMs }, path));
    expect(message).toBe('SetInputMute：OBS 没能执行 SetInputMute');
    expect(t.obs.sent).toEqual(['静音 主', '静音 主']);
    expect(t.obs.decoder(t.primary)).toMatchObject({ state: 'OBS_MEDIA_STATE_PLAYING', enabled: true });
    expect([t.scenes.isActive(t.primary), t.scenes.isActive(t.standby)]).toEqual([true, false]);
    expect(t.preload.resolveSource(t.primary)).toBe(t.primary);
  } finally { vi.useRealTimers(); }
});

it.each<[string, string, (type: string, data: Record<string, unknown>, standby: string) => boolean, string[]]>([
  ['设置它的声音', 'SetInputMute', (type, data, standby) => type === 'SetInputMute' && data.inputName === standby, ['静音 主', '隐藏 主', 'PAUSE 主', '显示 预备']],
  ['切场景', 'SetCurrentProgramScene', type => type === 'SetCurrentProgramScene', ['静音 主', '隐藏 主', 'PAUSE 主', '显示 预备', '静音 预备']],
  ['让它播起来', 'TriggerMediaInputAction', (type, data, standby) => type === 'TriggerMediaInputAction' && data.inputName === standby, ['静音 主', '隐藏 主', 'PAUSE 主', '显示 预备', '静音 预备', '切场景']]
])('按时交接时 OBS 显示了新解码器、%s时出错：新解码器算在画面上，记下的解码器就是它；红字写明这一段的画面停在第一帧、原因和后面照常播，不重发', async (_case, request, match, sent) => {
  vi.useFakeTimers();
  try {
    const t = await handover(), [, second] = t.events;
    t.obs.failOnce((type, data) => match(type, data, t.standby));
    const message = await outcome(t.preload.execute(second!, path));
    expect(message).toBe(`这一段的画面停在第一帧，没有播起来。原因：${request}：OBS 没能执行 ${request}。后面的素材照常播`);
    expect(t.obs.sent).toEqual(sent);
    expect(t.obs.view()).toMatchObject({ decoder: '预备', state: 'PAUSED' });
    // The clip's stop, pause, resume and the drift check reach the decoder the audience sees.
    expect([t.scenes.isActive(t.primary), t.scenes.isActive(t.standby)]).toEqual([false, true]);
    expect(t.preload.onAirSource(t.primary)).toBe(t.standby);
  } finally { vi.useRealTimers(); }
});

it('按时开播的音频 OBS 已经把它放上、却没能让它播起来：红字写明这一段的声音没有播起来、原因和后面照常播', async () => {
  vi.useFakeTimers();
  try {
    const cut = song([[0, 2000]]), obs = fakeObs();
    const project = parseLinkProject({ ...cut, mediaAssets: cut.mediaAssets.map(asset => ({ ...asset, kind: 'audio' as const })) });
    const scenes = new ObsMediaScenes(obs.client, obs.request, operation => operation());
    const preload = new ObsMediaPreload(project, 'song', scenes, obs.native);
    const [first] = new SceneOutputTimeline(project, 'song').preloadEntries();
    await scenes.prepare(project.projectId, project.mediaAssets[0]!, path);
    preload.register(project.projectId, project.mediaAssets[0]!, path);
    await preload.prime(first!, current);
    obs.failOnce(type => type === 'TriggerMediaInputAction');
    expect(await outcome(preload.execute(first!, path))).toBe('这一段的声音没有播起来。原因：TriggerMediaInputAction：OBS 没能执行 TriggerMediaInputAction。后面的素材照常播');
  } finally { vi.useRealTimers(); }
});

it('按时开播的第一段 OBS 没能把它显示出来：报 OBS 的原话，不说停在第一帧；这一段这时没有画面在播，暂停不发给任何解码器，它的停止照常送到它的解码器', async () => {
  vi.useFakeTimers();
  try {
    const project = song([[0, 2000]]), obs = fakeObs();
    const scenes = new ObsMediaScenes(obs.client, obs.request, operation => operation());
    const preload = new ObsMediaPreload(project, 'song', scenes, obs.native);
    const [first] = new SceneOutputTimeline(project, 'song').preloadEntries(), primary = first!.sourceName;
    await scenes.prepare(project.projectId, project.mediaAssets[0]!, path);
    preload.register(project.projectId, project.mediaAssets[0]!, path);
    await preload.prime(first!, current);
    obs.failOnce((type, data) => type === 'SetSceneItemEnabled' && data.sceneItemEnabled === true);
    expect(await outcome(preload.execute(first!, path))).toBe('SetSceneItemEnabled：OBS 没能执行 SetSceneItemEnabled');
    expect(obs.view()).toEqual({ decoder: null, state: '', cursor: 0 });
    expect(scenes.isActive(primary)).toBe(false);
    expect(preload.onAirSource(primary)).toBeNull();
    const before = obs.sent.length, logs = recorder();
    await pictureExecutor(adapter(obs, scenes, () => Promise.resolve(), []), preload, { record: logs, projectId: project.projectId, itemId: 'song' })
      .execute({ id: 'pause', label: '同步暂停', kind: 'obs.mediaAction', inputName: primary, action: 'pause' });
    expect(obs.sent.slice(before)).toEqual([]);
    expect(await outcome(preload.execute({ ...first!, phase: 'stop', frameNumber: 60 }, path))).toBe('完成');
    expect(obs.sent.slice(before)).toEqual(['STOP 主', '静音 主', '隐藏 主']);
  } finally { vi.useRealTimers(); }
});

it('晚到交接时有别的素材在播，旧解码器已经退下、OBS 静音新解码器时出错：报错写明这一段没有画面，两个解码器都不算在画面上', async () => {
  vi.useFakeTimers();
  try {
    const t = await handover(), [, second] = t.events;
    await othersPlaying(t, 1);
    t.obs.failOnce((type, data) => type === 'SetInputMute' && data.inputName === t.standby && data.inputMuted === true);
    const message = await outcome(t.preload.execute({ ...second!, sourceOffsetMs: second!.sourceOffsetMs + 600 }, path));
    expect(message).toBe(`${gap('SetInputMute')}。后面的素材照常播`);
    expect(t.obs.sent).toEqual(['静音 主', '静音 主', '隐藏 主', 'PAUSE 主']);
    expect(t.obs.decoder(t.standby)).toMatchObject({ enabled: false });
    expect([t.scenes.isActive(t.primary), t.scenes.isActive(t.standby)]).toEqual([false, false]);
  } finally { vi.useRealTimers(); }
});

it.each([['晚到 600 ms', 600], ['按时', 0]])('交接时先静音其他素材（%s）：这一步 OBS 出错时旧解码器原样留在画面上，不会两个解码器都不在画面上', async (_case, lateMs) => {
  vi.useFakeTimers();
  try {
    const t = await handover(), [, second] = t.events;
    // A second video still running in its own scene.
    const asset = { ...t.project.mediaAssets[0]!, id: 'video-2', name: '视频二' }, names = materialSceneNames(t.project.projectId, asset);
    await t.scenes.prepare(t.project.projectId, asset, path);
    const other = { ...second!, ...names, clipId: 'other', assetId: asset.id, assetName: asset.name, frameNumber: 0, sourceOffsetMs: 0 };
    expect(await outcome(t.scenes.execute(other, path))).toBe('完成');
    t.obs.sent.length = 0;
    t.obs.failOnce((type, data) => type === 'SetInputMute' && data.inputName === names.sourceName && data.inputMuted === true);
    expect(await outcome(t.preload.execute({ ...second!, sourceOffsetMs: second!.sourceOffsetMs + lateMs }, path))).toBe('SetInputMute：OBS 没能执行 SetInputMute');
    expect(t.obs.sent).toEqual([]);
    expect(t.obs.decoder(t.primary)).toMatchObject({ state: 'OBS_MEDIA_STATE_PLAYING', enabled: true });
    expect([t.scenes.isActive(t.primary), t.scenes.isActive(t.standby)]).toEqual([true, false]);
    expect(t.preload.resolveSource(t.primary)).toBe(t.primary);
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
    // The session's drift check every 5 s, as production wires it (native-obs-outputs.ts).
    await vi.advanceTimersByTimeAsync(5000);
    const correction = pictureDriftCheck(t.scenes, t.preload)({ ...late, sourceOffsetMs: Math.round(music()) }, () => true);
    expect(await outcome(correction)).toBe('完成');
    const drift = await correction;
    expect(drift, '漂移检查没有校正画面上的片段').not.toBeNull();
    expect(drift ?? 0).toBeLessThan(-300);
    expect(Math.abs(t.obs.position(t.standby) - music())).toBeLessThanOrEqual(100);
    // The program's pause reaches it as well.
    const received: LinkAction[] = [], logs = recorder();
    const executor = pictureExecutor(adapter(t.obs, t.scenes, () => Promise.resolve(), received), t.preload, { record: logs, projectId: t.project.projectId, itemId: 'song' });
    await executor.execute({ id: 'pause', label: '同步暂停', kind: 'obs.mediaAction', inputName: t.primary, action: 'pause' });
    expect(t.obs.decoder(t.standby).state).toBe('OBS_MEDIA_STATE_PAUSED');
    expect(logs).not.toHaveBeenCalled();
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
    prepareOutputs: () => Promise.resolve(), holdOutputs: () => Promise.resolve(), releaseOutputs: () => preload.close(),
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

const unplayed = '这一段素材没有播出：轮到它时这一段已经结束了，电脑或 OBS 当时太忙。后面的素材照常播，不用处理';

it('剪切点上的点 Cue OBS 过 0.6 s 才回应，同一视频首尾相接的下一段（300 ms）轮到时已经结束：上一段在这一段的开始被拒绝时退下，不接着往下播，后面的片段照常开播（2026-11-09）', async () => {
  // clip-0 [0,2) s and clip-1 [2,2.3) s back to back, clip-2 [8,10) s: one video on one track. clip-1's start is what ends clip-0.
  const project = withPointCue(song([[0, 2000], [2, 300], [8, 2000]], undefined, 5000), 2), obs = fakeObs();
  let answer = (): void => undefined;
  const answered = new Promise<void>(resolve => { answer = resolve; });
  const t = await live(project, obs, action => action.id === 'filter-action' ? answered : Promise.resolve());
  const primary = new SceneOutputTimeline(project, 'song').preloadEntries()[0]!.sourceName;
  await t.play(0, 1900, true);
  await t.play(2000, 2600, false);
  answer();
  await t.play(2700, 7900, true);
  // clip-0's decoder went off once, when clip-1's start came 0.6 s late and was refused; nothing of the video is on air until clip-2.
  expect(obs.decoder(primary)).toMatchObject({ state: 'OBS_MEDIA_STATE_PAUSED', enabled: false, muted: true });
  expect(obs.decoder(`${primary}·预备`)).toMatchObject({ enabled: false, muted: true });
  expect(obs.onAir.at(-1)).toEqual({ decoder: null, state: '', cursor: 0 });
  expect(obs.sent.filter(entry => entry === 'PAUSE 主' || entry === '隐藏 主')).toEqual(['PAUSE 主', '隐藏 主']);
  expect(t.failures()).toEqual([`clip-1 start failed：${unplayed}`]);
  await t.play(8000, 9000, true);
  expect(t.reports).toContain('clip-2 start succeeded');
  expect(t.failures()).toHaveLength(1);
  expect(obs.onAir.at(-1)).toMatchObject({ state: 'PLAYING' });
  await t.session.stop();
});

it('剪切点上的点 Cue OBS 过 0.6 s 才回应，同一视频切成首尾相接、入点接得上的下一段（300 ms）轮到时已经结束：照样算没有播出，上一段在这一段的开始被拒绝时退下，后面的片段照常开播', async () => {
  // clip-0 [0,2) s from 5000 ms and clip-1 [2,2.3) s from 7000 ms: one video cut in two. clip-2 [8,10) s from 20000 ms.
  const project = withPointCue(song([[0, 2000, 5000], [2, 300, 7000], [8, 2000, 20000]]), 2), obs = fakeObs();
  let answer = (): void => undefined;
  const answered = new Promise<void>(resolve => { answer = resolve; });
  const t = await live(project, obs, action => action.id === 'filter-action' ? answered : Promise.resolve());
  const primary = new SceneOutputTimeline(project, 'song').preloadEntries()[0]!.sourceName;
  await t.play(0, 1900, true);
  await t.play(2000, 2600, false);
  answer();
  await t.play(2700, 7900, true);
  expect(t.failures()).toEqual([`clip-1 start failed：${unplayed}`]);
  expect(obs.decoder(primary)).toMatchObject({ state: 'OBS_MEDIA_STATE_PAUSED', enabled: false, muted: true });
  expect(obs.onAir.at(-1)).toEqual({ decoder: null, state: '', cursor: 0 });
  await t.play(8000, 9000, true);
  expect(t.reports).toContain('clip-2 start succeeded');
  expect(t.failures()).toHaveLength(1);
  await t.session.stop();
});

it('剪切点上排在前面的台标停止 OBS 过 0.7 s 才回应，同一视频首尾相接的下一段轮到时已经结束：上一段在这一段的开始被拒绝时退下，后面的片段照常开播（2026-11-09）', async () => {
  // Top track: a logo [0,2) s. Video track: clip-0 [0,2) s and clip-1 [2,2.5) s back to back, clip-2 [8,10) s.
  const project = withLogo(song([[0, 2000], [2, 500], [8, 2000]], undefined, 5000), [0, 2000]), obs = fakeObs();
  const logoScene = materialSceneNames(project.projectId, project.mediaAssets[1]!).sceneName;
  const t = await live(project, obs);
  const primary = new SceneOutputTimeline(project, 'song').preloadEntries().find(event => event.assetKind === 'video')!.sourceName;
  await t.play(0, 1900, true);
  const release = obs.holdNextBatch(batch => batch.some(entry => entry.requestType === 'SetSceneItemEnabled'
    && entry.requestData?.sceneName === logoScene && entry.requestData.sceneItemEnabled === false));
  await t.play(2000, 2600, false);
  release();
  await t.play(2700, 7900, true);
  expect(obs.decoder(primary)).toMatchObject({ state: 'OBS_MEDIA_STATE_PAUSED', enabled: false, muted: true });
  expect(obs.decoder(`${primary}·预备`)).toMatchObject({ enabled: false, muted: true });
  expect(t.failures()).toEqual([`clip-1 start failed：${unplayed}`]);
  await t.play(8000, 9000, true);
  expect(t.reports).toContain('clip-2 start succeeded');
  expect(t.failures()).toHaveLength(1);
  expect(obs.onAir.at(-1)).toMatchObject({ state: 'PLAYING' });
  await t.session.stop();
});

it('只有一段的短素材（300 ms）排在一个 OBS 过 0.6 s 才回应的点 Cue 后面，轮到它时已经结束：不再播出，标红写明没有播出、不用处理', async () => {
  const project = withPointCue(song([[2, 300]], undefined, 5000), 2), obs = fakeObs();
  let answer = (): void => undefined;
  const answered = new Promise<void>(resolve => { answer = resolve; });
  const t = await live(project, obs, action => action.id === 'filter-action' ? answered : Promise.resolve());
  const primary = new SceneOutputTimeline(project, 'song').preloadEntries()[0]!.sourceName;
  await t.play(0, 1900, true);
  await t.play(2000, 2600, false);
  answer();
  await t.play(2700, 4000, true);
  expect(t.failures()).toEqual([`clip-0 start failed：${unplayed}`]);
  // Prepared and paused at its entry point, never on air.
  expect(obs.decoder(primary)).toMatchObject({ state: 'OBS_MEDIA_STATE_PAUSED', muted: true });
  expect(obs.onAir.every(view => view.state !== 'PLAYING')).toBe(true);
  await t.session.stop();
});

it('同一素材首尾相接、但入点接不上的下一段没能在切换前准备好：上一段在这一段的开始被拒绝时退下，不接着往下播；后面的片段照常准备和开播', async () => {
  vi.useFakeTimers();
  try {
    // clip-0 [0,2) s and clip-1 [2,4) s back to back, both from 100 ms in the file, clip-2 [8,10) s.
    const project = song([[0, 2000], [2, 2000], [8, 2000]], undefined, 100), obs = fakeObs();
    const scenes = new ObsMediaScenes(obs.client, obs.request, operation => operation());
    const preload = new ObsMediaPreload(project, 'song', scenes, obs.native);
    const [first, second, third] = new SceneOutputTimeline(project, 'song').preloadEntries(), primary = first!.sourceName;
    await scenes.prepare(project.projectId, project.mediaAssets[0]!, path);
    preload.register(project.projectId, project.mediaAssets[0]!, path);
    await preload.prime(first!, current); await preload.execute(first!, path);
    // OBS is slow to set up the second decoder: clip-1 is still being prepared at the cut.
    const release = obs.holdNextBatch();
    const preparing = preload.upcoming(30, current);
    await untilHeld(obs);
    await expect(preload.execute(second!, path)).rejects.toThrow(new Error('下一个素材没能在切换前准备好：视频'));
    expect(obs.decoder(primary)).toMatchObject({ state: 'OBS_MEDIA_STATE_PAUSED', enabled: false, muted: true });
    expect(scenes.isActive(primary)).toBe(false);
    release(); await preparing;
    // clip-1 is not started again; its slot goes to clip-2 at clip-1's end.
    expect(await preload.upcoming(119, current)).toBeNull();
    expect(await preload.upcoming(120, current)).toMatchObject({ clipId: 'clip-2' });
    expect(obs.sent).toContain('预热 主 从已解码画面重启');
    await preload.execute(third!, path);
    expect(obs.onAir.at(-1)).toMatchObject({ decoder: '主', state: 'PLAYING', cursor: 100 });
  } finally { vi.useRealTimers(); }
});

/** The run log's entry for a clip that started: the clip counts as playing. */
const startedEntry = (clipId: string): unknown => expect.objectContaining({ message: '播放素材 · 视频 · succeeded', result: 'succeeded', details: expect.objectContaining({ clipId }) as unknown });

it('同一视频切成首尾相接、入点接得上的两段，切换时后一段还在预热（OBS 卡住）：上一段的解码器接着往下播，画面不断、位置对；切换只做这一段的显示、声音和切场景，不动它的播放；这一段算开播成功，准备好后不再开播它，它结束时照常退下（2026-11-09）', async () => {
  vi.useFakeTimers();
  try {
    // clip-0 [0,1) s from 5000 ms and clip-1 [1,4) s from 6000 ms: one video cut in two. clip-2 [8,10) s from 20000 ms.
    const project = song([[0, 1000, 5000], [1, 3000, 6000], [8, 2000, 20000]]), obs = fakeObs();
    // A cold auto-next song: only the opening clip is primed before the clock, and OBS is slow to set up the second decoder for clip-1.
    const release = obs.holdNextBatch(standbySetup);
    const t = await live(project, obs, () => Promise.resolve(), false, 'production');
    const primary = new SceneOutputTimeline(project, 'song').preloadEntries()[0]!.sourceName, standby = `${primary}·预备`;
    await t.run(0, 900);
    const opened = obs.sent.length, views: OnAir[] = [];
    for (let at = 1000; at <= 3900; at += 100) {
      if (at === 1600) release();
      await t.run(at, at);
      views.push(obs.view());
    }
    // The first decoder plays on through the cut from where clip-0 started it, which is clip-1's picture. clip-1's
    // on-air step shows it, sets its sound and puts its scene on program; nothing moved its media clock since.
    expect(views.every(view => view.decoder === '主' && view.state === 'PLAYING')).toBe(true);
    expect(obs.sent.slice(opened).filter(entry => entry.endsWith(' 主') || entry === '切场景')).toEqual(['显示 主', '静音 主', '切场景']);
    expect(obs.decoder(primary)).toMatchObject({ state: 'OBS_MEDIA_STATE_PLAYING', enabled: true, base: 5000 });
    expect(Math.abs(obs.position(primary) - 9000)).toBeLessThanOrEqual(100);
    // clip-1's late preparation does not start it a second time: the second decoder stays hidden and muted, for clip-2.
    expect(obs.sent).not.toContain('显示 预备');
    expect(obs.decoder(standby)).toMatchObject({ state: 'OBS_MEDIA_STATE_PAUSED', enabled: false, muted: true });
    // Nothing went wrong on air: clip-1 counts as started, nothing in red.
    expect(t.reports).toContain('clip-1 start succeeded');
    expect(t.logs).toHaveBeenCalledWith(startedEntry('clip-1'));
    expect(t.failures()).toEqual([]);
    expect(t.faults).toEqual([]);
    // clip-1's end takes the first decoder off; clip-2 starts on time on the second.
    await t.run(4000, 7900);
    expect(obs.decoder(primary)).toMatchObject({ state: 'OBS_MEDIA_STATE_PAUSED', enabled: false, muted: true });
    // The second decoder was decoded and paused for clip-1: clip-2's preparation restarts it from there.
    expect(obs.sent.filter(entry => entry.startsWith('预热 预备'))).toEqual(['预热 预备', '预热 预备 从已解码画面重启']);
    await t.run(8000, 9000);
    expect(t.reports).toContain('clip-2 start succeeded');
    expect(obs.view()).toMatchObject({ decoder: '预备', state: 'PLAYING' });
    expect(t.failures()).toEqual([]);
    await settle(t.session.stop());
  } finally { vi.useRealTimers(); }
});

it.each([110, 150, -150, 250])('同一视频切成首尾相接、入点接得上的两段，后一段还在预热时，上一段的解码器和音乐差 %s ms（现场常见的稳定偏差，在漂移检查的 300 ms 以内）：剪切点上不暂停、不定位、不重播它，画面一直在播，不标红', async offset => {
  vi.useFakeTimers();
  try {
    // clip-0 [0,1) s from 5000 ms with its sound, clip-1 [1,4) s from 6000 ms continues it; clip-2 [8,10) s from 20000 ms.
    const project = cutVideo([[0, 1000, 5000, true], [1000, 3000, 6000, true], [8000, 2000, 20000, true]]), obs = fakeObs();
    const release = obs.holdNextBatch(standbySetup);
    const t = await live(project, obs, () => Promise.resolve(), false, 'production');
    const primary = new SceneOutputTimeline(project, 'song').preloadEntries()[0]!.sourceName, scene = obs.decoder(primary).scene;
    await t.run(0, 500);
    // The first decoder runs this far from the music from here on, as OBS's cursor does on the field machine.
    obs.decoder(primary).base += offset;
    await t.run(600, 900);
    const opened = obs.sent.length, views: string[] = [];
    for (let at = 1000; at <= 3900; at += 100) {
      if (at === 1600) release();
      await t.run(at, at);
      views.push(obs.program() === scene ? `${obs.view().decoder ?? '黑'} ${obs.view().state}` : obs.program());
    }
    expect(views.every(view => view === '主 PLAYING')).toBe(true);
    // clip-1's on-air step only; nothing moved its media clock.
    expect(obs.sent.slice(opened).filter(entry => entry.endsWith(' 主') || entry === '切场景')).toEqual(['显示 主', '出声 主', '切场景']);
    expect(obs.onAir.slice(1).every(view => view.decoder === '主' && view.state === 'PLAYING')).toBe(true);
    expect(obs.decoder(primary)).toMatchObject({ state: 'OBS_MEDIA_STATE_PLAYING', enabled: true, muted: false });
    expect(t.reports).toContain('clip-1 start succeeded');
    expect(t.failures()).toEqual([]);
    expect(t.faults).toEqual([]);
    await settle(t.session.stop());
  } finally { vi.useRealTimers(); }
});

it('同一视频切成首尾相接、入点接得上的两段，上一段的解码器接着往下播；这一段被卡在 OBS 里的预热在剪切点之后才失败：不报“准备后面的素材失败”，运行日志记一行，画面照常；同一素材后面的片段照常准备和开播', async () => {
  vi.useFakeTimers();
  try {
    // clip-0 [0,1) s from 5000 ms, clip-1 [1,4) s from 6000 ms continues it; clip-2 [8,10) s from 20000 ms.
    const project = cutVideo([[0, 1000, 5000], [1000, 3000, 6000], [8000, 2000, 20000]]), obs = fakeObs();
    const release = obs.holdNextBatch(standbySetup);
    const t = await live(project, obs, () => Promise.resolve(), false, 'production');
    const primary = new SceneOutputTimeline(project, 'song').preloadEntries()[0]!.sourceName, standby = `${primary}·预备`;
    await t.run(0, 1500);
    expect(t.reports).toContain('clip-1 start succeeded');
    // OBS carries out the held setup after the cut, then fails the second decoder's first frame.
    obs.failOnce((type, data) => type === 'GetSourceScreenshot' && data.sourceName === standby);
    release();
    await t.run(1600, 3900);
    expect(t.faults).toEqual([]);
    expect(t.failures()).toEqual([]);
    expect(t.logs).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning', result: 'failed',
      message: '准备素材没成功：视频。这一段已经接着上一段往下播，画面照常。原因：OBS 没能执行 GetSourceScreenshot。不用处理，后面的素材照常播',
      details: expect.objectContaining({ clipId: 'clip-1', inputName: standby }) as unknown }));
    expect(obs.view()).toMatchObject({ decoder: '主', state: 'PLAYING' });
    await t.run(4000, 9000);
    expect(t.reports).toContain('clip-2 start succeeded');
    expect(obs.view()).toMatchObject({ decoder: '预备', state: 'PLAYING' });
    expect(t.faults).toEqual([]);
    await settle(t.session.stop());
  } finally { vi.useRealTimers(); }
});

it('同一视频切成首尾相接、入点接得上的两段，后一段没准备好；剪切点上上一段的解码器和音乐差 400 ms（超过 300 ms 的容差），按音乐重新定位又落定得慢：红字写明画面接着往下播、切到了这一段但和音乐没对齐，原因，差得多时会自动校正、不用处理；不叫操作员去 OBS 切场景', async () => {
  vi.useFakeTimers();
  try {
    // clip-0 [0,1.5) s from 5000 ms, clip-1 [1.5,4) s from 6500 ms continues it; clip-2 [8,10) s from 20000 ms.
    const project = cutVideo([[0, 1500, 5000], [1500, 2500, 6500], [8000, 2000, 20000]]), obs = fakeObs();
    const release = obs.holdNextBatch(standbySetup);
    const t = await live(project, obs, () => Promise.resolve(), false, 'production');
    const primary = new SceneOutputTimeline(project, 'song').preloadEntries()[0]!.sourceName, scene = obs.decoder(primary).scene;
    // After the drift check at 1 s: the first decoder runs 400 ms ahead of the music, and OBS takes 500 ms to land a seek.
    await t.run(0, 1100);
    obs.decoder(primary).base += 400; obs.seekDelay(500);
    await t.run(1200, 2400);
    expect(t.failures()).toEqual([expect.stringMatching(new RegExp('^clip-1 start failed：画面接着上一段往下播，切到了这一段，但和音乐没对齐。原因：素材开始播放时比音乐晚了 \\d+ ms：视频 定位解码太慢。'
      + '差得多时联动台过几秒会自动按音乐校正，不用处理；后面的素材照常播$', 'u'))]);
    // Its scene is on program and the decoder plays this clip.
    expect([obs.program(), obs.view().decoder, obs.view().state]).toEqual([scene, '主', 'PLAYING']);
    expect(t.preload.onAirSource(primary)).toBe(primary);
    release();
    await settle(t.session.stop());
  } finally { vi.useRealTimers(); }
});

it('接着往下播的这一段晚准备好时，它的预备解码器让给同一素材紧接着的下一段：下一段照常提前预热，按时交接开播', async () => {
  vi.useFakeTimers();
  try {
    // clip-0 [0,1) s from 5000 ms, clip-1 [1,4) s from 6000 ms continues it; clip-2 [4,6) s from 20000 ms right after clip-1.
    const project = song([[0, 1000, 5000], [1, 3000, 6000], [4, 2000, 20000]]), obs = fakeObs();
    const release = obs.holdNextBatch(standbySetup);
    const t = await live(project, obs, () => Promise.resolve(), false, 'production');
    await t.run(0, 1500);
    expect(t.reports).toContain('clip-1 start succeeded');
    release();
    await t.run(1600, 3900);
    const before = obs.sent.length;
    await t.run(4000, 4500);
    expect(t.reports).toContain('clip-2 start succeeded');
    expect(t.failures()).toEqual([]);
    // In time from its primed frame: the old decoder off, the new one shown, its sound, its scene, then played.
    expect(obs.sent.slice(before)).toEqual(['静音 主', '隐藏 主', 'STOP 主', '显示 预备', '静音 预备', '切场景', 'PLAY 预备']);
    expect(obs.view()).toMatchObject({ decoder: '预备', state: 'PLAYING' });
    expect(Math.abs(obs.view().cursor - 20500)).toBeLessThanOrEqual(100);
    await settle(t.session.stop());
  } finally { vi.useRealTimers(); }
});

it('接着往下播时 OBS 没能切到这一段的场景，这一段随后晚准备好：红字只报这一次，不再开播它、不重发，也不再报“没能在切换前准备好”；上一段的解码器照常往下播', async () => {
  vi.useFakeTimers();
  try {
    // clip-0 [0,1) s from 5000 ms, clip-1 [1,4) s from 6000 ms continues it; clip-2 [8,10) s from 20000 ms.
    const project = song([[0, 1000, 5000], [1, 3000, 6000], [8, 2000, 20000]]), obs = fakeObs();
    const release = obs.holdNextBatch(standbySetup);
    const t = await live(project, obs, () => Promise.resolve(), false, 'production');
    const primary = new SceneOutputTimeline(project, 'song').preloadEntries()[0]!.sourceName, standby = `${primary}·预备`;
    await t.run(0, 900);
    obs.failOnce(type => type === 'SetCurrentProgramScene');
    await t.run(1000, 1500);
    const reported = ['clip-1 start failed：画面接着上一段往下播，切到这一段时出了错。原因：SetCurrentProgramScene：OBS 没能执行 SetCurrentProgramScene。'
      + '如果 OBS 节目画面上不是这段素材，在 OBS 里切到它的场景；后面的素材照常播'];
    expect(t.failures()).toEqual(reported);
    const after = obs.sent.length;
    release();
    await t.run(1600, 3900);
    expect(t.failures()).toEqual(reported);
    expect(t.faults).toEqual([]);
    expect(obs.sent.slice(after).filter(entry => entry.endsWith(' 主') || entry === '切场景' || entry === '显示 预备')).toEqual([]);
    expect(obs.decoder(primary)).toMatchObject({ state: 'OBS_MEDIA_STATE_PLAYING', enabled: true });
    expect(obs.decoder(standby)).toMatchObject({ state: 'OBS_MEDIA_STATE_PAUSED', enabled: false, muted: true });
    await settle(t.session.stop());
  } finally { vi.useRealTimers(); }
});

it.each<[string, (obs: FakeObs) => () => void, boolean]>([
  ['后一段的预热被 OBS 卡住', obs => obs.holdNextBatch(standbySetup), false],
  ['后一段的预热被 OBS 卡住、两段都开着原声', obs => obs.holdNextBatch(standbySetup), true],
  ['后一段的预热直接失败', obs => { obs.failOnce((type, data) => type === 'GetSourceScreenshot' && String(data.sourceName).endsWith('·预备')); return () => undefined; }, false]
])('机位盖住上一段的末尾、正好在剪切点结束，同一视频接得上的后一段没准备好（%s）：从剪切点起节目画面回到素材，上一段的解码器接着往下播、位置对，声音按这一段的设置；这一段算开播成功', async (_case, stall, sound) => {
  vi.useFakeTimers();
  try {
    // A camera [0.5,1) s above clip-0 [0,1) s from 5000 ms; clip-1 [1,4) s from 6000 ms continues it in the file; clip-2 [8,10) s from 20000 ms.
    const project = cutVideo([[0, 1000, 5000, sound], [1000, 3000, 6000, sound], [8000, 2000, 20000, sound]], [[500, 500]]), obs = fakeObs();
    const release = stall(obs);
    const t = await live(project, obs, () => Promise.resolve(), false, 'production');
    const primary = new SceneOutputTimeline(project, 'song').preloadEntries()[0]!.sourceName, scene = obs.decoder(primary).scene;
    await t.run(0, 900);
    expect([obs.program(), obs.decoder(primary).muted]).toEqual(['机位1', true]);
    const opened = obs.sent.length, programs: string[] = [];
    for (let at = 1000; at <= 3900; at += 100) {
      if (at === 1600) release();
      await t.run(at, at);
      programs.push(obs.program() === scene ? `${obs.view().decoder ?? '黑'} ${obs.view().state}` : obs.program());
    }
    expect(programs.every(entry => entry === '主 PLAYING')).toBe(true);
    // Nothing moved its media clock: it is at clip-1's place in the file.
    expect(obs.sent.slice(opened).filter(transport)).toEqual([]);
    expect(obs.decoder(primary)).toMatchObject({ enabled: true, muted: !sound, base: 5000 });
    expect(Math.abs(obs.position(primary) - 9000)).toBeLessThanOrEqual(100);
    expect(t.reports).toContain('clip-1 start succeeded');
    expect(t.logs).toHaveBeenCalledWith(startedEntry('clip-1'));
    expect(t.failures()).toEqual([]);
    // A prime that failed outright was already reported once, as it happened; nothing went wrong on air.
    expect(t.faults).toEqual(_case === '后一段的预热直接失败' ? ['准备后面的素材失败：OBS 没能执行 GetSourceScreenshot；不会重试，到时候这个素材可能播不出来'] : []);
    await t.run(4000, 9000);
    expect(t.reports).toContain('clip-2 start succeeded');
    expect(obs.view()).toMatchObject({ decoder: '预备', state: 'PLAYING' });
    await settle(t.session.stop());
  } finally { vi.useRealTimers(); }
});

it('接着往下播的是预备解码器（上一段在它上面开播），这一段在主解码器上的预热直接失败：上画面那一步只发给预备解码器，主解码器不上画面；这一段算开播成功', async () => {
  vi.useFakeTimers();
  try {
    // clip-0 [0,1) s from 5000 ms; clip-1 [1,2) s from 9000 ms with its sound, on the second decoder; clip-2 [2,4) s
    // from 10000 ms without it continues clip-1 in the file; clip-3 at 9 s.
    const project = cutVideo([[0, 1000, 5000], [1000, 1000, 9000, true], [2000, 2000, 10000, false], [9000, 1000, 30000]]), obs = fakeObs();
    const t = await live(project, obs, () => Promise.resolve(), true, 'production');
    const primary = new SceneOutputTimeline(project, 'song').preloadEntries()[0]!.sourceName, standby = `${primary}·预备`;
    await t.run(0, 900);
    // clip-2 is prepared on the first decoder once clip-1 is on the second one, and that fails.
    obs.failOnce((type, data) => type === 'GetSourceScreenshot' && data.sourceName === primary);
    await t.run(1000, 1900);
    expect(obs.view()).toMatchObject({ decoder: '预备', state: 'PLAYING' });
    const opened = obs.sent.length;
    await t.run(2000, 3000);
    expect(obs.sent.slice(opened).filter(entry => !entry.startsWith('预热'))).toEqual(['显示 预备', '静音 预备', '切场景']);
    expect(obs.decoder(primary)).toMatchObject({ enabled: false, muted: true });
    expect(obs.view()).toMatchObject({ decoder: '预备', state: 'PLAYING' });
    expect(Math.abs(obs.view().cursor - 11000)).toBeLessThanOrEqual(100);
    expect(t.reports).toContain('clip-2 start succeeded');
    expect(t.preload.onAirSource(primary)).toBe(standby);
    await settle(t.session.stop());
  } finally { vi.useRealTimers(); }
});

it.each([[true, false], [false, true]])('同一视频切成首尾相接、入点接得上的两段，后一段没准备好，原声开着=%s 换成开着=%s：上一段的解码器接着往下播，从剪切点起声音按后一段的设置', async (before, after) => {
  vi.useFakeTimers();
  try {
    // Video sound plays along with the music. clip-0 [0,1) s from 5000 ms, clip-1 [1,4) s from 6000 ms continues it; clip-2 [8,10) s.
    const project = cutVideo([[0, 1000, 5000, before], [1000, 3000, 6000, after], [8000, 2000, 20000, after]]), obs = fakeObs();
    const release = obs.holdNextBatch(standbySetup);
    const t = await live(project, obs, () => Promise.resolve(), false, 'production');
    const primary = new SceneOutputTimeline(project, 'song').preloadEntries()[0]!.sourceName;
    await t.run(0, 900);
    expect(obs.decoder(primary).muted).toBe(!before);
    const opened = obs.sent.length;
    await t.run(1000, 1500);
    release();
    await t.run(1600, 3900);
    expect(obs.decoder(primary)).toMatchObject({ state: 'OBS_MEDIA_STATE_PLAYING', enabled: true, muted: !after, base: 5000 });
    expect(obs.sent.slice(opened).filter(entry => entry.endsWith(' 主') || entry === '切场景')).toEqual(['显示 主', after ? '出声 主' : '静音 主', '切场景']);
    expect(t.reports).toContain('clip-1 start succeeded');
    expect(t.failures()).toEqual([]);
    await settle(t.session.stop());
  } finally { vi.useRealTimers(); }
});

it('同一视频切成首尾相接、入点接得上的两段，后一段关了原声、没准备好：上一段的解码器接着往下播；后一段中间插进机位，机位结束时声音按后一段的设置恢复', async () => {
  vi.useFakeTimers();
  try {
    // clip-0 [0,1) s from 5000 ms with its sound, clip-1 [1,4) s from 6000 ms without; a camera [2,2.5) s above clip-1.
    const project = cutVideo([[0, 1000, 5000, true], [1000, 3000, 6000, false], [8000, 2000, 20000, false]], [[2000, 500]]), obs = fakeObs();
    const release = obs.holdNextBatch(standbySetup);
    const t = await live(project, obs, () => Promise.resolve(), false, 'production');
    const primary = new SceneOutputTimeline(project, 'song').preloadEntries()[0]!.sourceName, scene = obs.decoder(primary).scene;
    await t.run(0, 900);
    expect(obs.decoder(primary).muted).toBe(false);
    await t.run(1000, 1500);
    release();
    await t.run(1600, 1900);
    expect(obs.decoder(primary)).toMatchObject({ state: 'OBS_MEDIA_STATE_PLAYING', enabled: true, muted: true, base: 5000 });
    await t.run(2000, 2400);
    expect([obs.program(), obs.decoder(primary).muted]).toEqual(['机位1', true]);
    const covered = obs.sent.length;
    await t.run(2500, 3000);
    expect(obs.program()).toBe(scene);
    expect(obs.sent.slice(covered)).toEqual(['切场景', '静音 主']);
    expect(obs.decoder(primary)).toMatchObject({ state: 'OBS_MEDIA_STATE_PLAYING', base: 5000 });
    expect(t.failures()).toEqual([]);
    await settle(t.session.stop());
  } finally { vi.useRealTimers(); }
});

it('机位盖住剪切点、到后一段中间才结束：剪切点上上一段的解码器在机位下退下，机位结束时后一段在预热好的解码器上露出，声音按后一段的设置', async () => {
  vi.useFakeTimers();
  try {
    // clip-0 [0,1) s from 5000 ms without its sound, clip-1 [1,4) s from 6000 ms with it; a camera [0.5,1.5) s covers the cut.
    const project = cutVideo([[0, 1000, 5000, false], [1000, 3000, 6000, true], [8000, 2000, 20000, true]], [[500, 1000]]), obs = fakeObs();
    const t = await live(project, obs, () => Promise.resolve(), true, 'production');
    const primary = new SceneOutputTimeline(project, 'song').preloadEntries()[0]!.sourceName, standby = `${primary}·预备`;
    await t.run(0, 1400);
    expect(obs.program()).toBe('机位1');
    expect(obs.decoder(primary)).toMatchObject({ state: 'OBS_MEDIA_STATE_PAUSED', enabled: false, muted: true });
    await t.run(1500, 2000);
    expect(obs.view()).toMatchObject({ decoder: '预备', state: 'PLAYING' });
    expect(obs.decoder(standby).muted).toBe(false);
    expect(t.failures()).toEqual([]);
    await settle(t.session.stop());
  } finally { vi.useRealTimers(); }
});

it.each([true, false])('机位插在同一片段中间，机位结束时节目画面回到素材，素材的声音按片段的设置恢复（开着原声=%s），排在切场景之后；不动它的播放', async sound => {
  vi.useFakeTimers();
  try {
    // clip-0 [0,4) s from 5000 ms; a camera [1,1.5) s above it.
    const project = cutVideo([[0, 4000, 5000, sound]], [[1000, 500]]), obs = fakeObs();
    const t = await live(project, obs, () => Promise.resolve(), false, 'production');
    const primary = new SceneOutputTimeline(project, 'song').preloadEntries()[0]!.sourceName, scene = obs.decoder(primary).scene;
    await t.run(0, 900);
    expect(obs.decoder(primary).muted).toBe(!sound);
    await t.run(1000, 1400);
    // Covered by the camera, it is never heard.
    expect([obs.program(), obs.decoder(primary).muted]).toEqual(['机位1', true]);
    const covered = obs.sent.length;
    await t.run(1500, 2500);
    expect([obs.program() === scene, obs.decoder(primary).muted]).toEqual([true, !sound]);
    expect(obs.sent.slice(covered)).toEqual(['切场景', sound ? '出声 主' : '静音 主']);
    expect(obs.decoder(primary)).toMatchObject({ state: 'OBS_MEDIA_STATE_PLAYING', base: 5000 });
    expect(t.failedActions()).toEqual([]);
    await settle(t.session.stop());
  } finally { vi.useRealTimers(); }
});

it('同一视频切成首尾相接的三段：交接到第二段时 OBS 一开头就出错、旧解码器留在画面上算第二段的，第三段又没准备好：旧解码器接着往下播到第三段，画面一直不断', async () => {
  vi.useFakeTimers();
  try {
    // clip-0 [0,1) s from 5000 ms, clip-1 [1,2) s from 6000 ms, clip-2 [2,4) s from 7000 ms: one video cut in three. clip-3 at 20 s.
    const project = song([[0, 1000, 5000], [1, 1000, 6000], [2, 2000, 7000], [20, 2000, 30000]]), obs = fakeObs();
    const t = await live(project, obs, () => Promise.resolve(), true, 'production');
    const primary = new SceneOutputTimeline(project, 'song').preloadEntries()[0]!.sourceName;
    await t.run(0, 900);
    // OBS refuses the first request of the handover into clip-1: the first decoder stays on air for it.
    obs.failOnce((type, data) => type === 'SetInputMute' && data.inputName === primary && data.inputMuted === true);
    const views: OnAir[] = [];
    await t.run(1000, 1000); views.push(obs.view());
    // OBS is slow to set up the second decoder again, for clip-2.
    const release = obs.holdNextBatch(standbySetup);
    for (let at = 1100; at <= 3900; at += 100) { if (at === 2600) release(); await t.run(at, at); views.push(obs.view()); }
    expect(views.every(view => view.decoder === '主' && view.state === 'PLAYING')).toBe(true);
    expect(t.failures()).toEqual(['clip-1 start failed：SetInputMute：OBS 没能执行 SetInputMute']);
    expect(t.reports).toContain('clip-2 start succeeded');
    expect(Math.abs(obs.position(primary) - 9000)).toBeLessThanOrEqual(100);
    await settle(t.session.stop());
  } finally { vi.useRealTimers(); }
});

it('交接一开头 OBS 就出错、旧解码器留在画面上算这一段的，而这一段和上一段在文件里接不上：漂移检查不去动旧解码器（它播的是上一段的画面）', async () => {
  vi.useFakeTimers();
  try {
    // Every clip starts 100 ms into the file: clip-1 does not continue clip-0.
    const t = await handover(), [, second] = t.events;
    t.obs.failOnce((type, data) => type === 'SetInputMute' && data.inputName === t.primary && data.inputMuted === true);
    expect(await outcome(t.preload.execute(second!, path))).toBe('SetInputMute：OBS 没能执行 SetInputMute');
    expect(t.preload.onAirSource(t.primary)).toBe(t.primary);
    const before = t.obs.sent.length, drift = pictureDriftCheck(t.scenes, t.preload)({ ...second!, sourceOffsetMs: 9000 }, () => true);
    expect(await outcome(drift)).toBe('完成');
    expect(await drift).toBeNull();
    expect(t.obs.sent.slice(before)).toEqual([]);
  } finally { vi.useRealTimers(); }
});

it('同一视频切成首尾相接、入点接得上的两段，后一段预热直接失败：上一段的解码器接着往下播，位置对，只做这一段的显示、声音和切场景，漂移检查照管它；这一段算开播成功，结束时照常退下，之后不再准备、不再开播它', async () => {
  vi.useFakeTimers();
  try {
    // clip-0 [0,2) s from 5000 ms and clip-1 [2,4) s from 7000 ms: one video cut in two. clip-2 [8,10) s from 20000 ms.
    const project = song([[0, 2000, 5000], [2, 2000, 7000], [8, 2000, 20000]]), obs = fakeObs();
    const scenes = new ObsMediaScenes(obs.client, obs.request, operation => operation());
    const preload = new ObsMediaPreload(project, 'song', scenes, obs.native);
    const [first, second, third] = new SceneOutputTimeline(project, 'song').preloadEntries(), primary = first!.sourceName;
    await scenes.prepare(project.projectId, project.mediaAssets[0]!, path);
    preload.register(project.projectId, project.mediaAssets[0]!, path);
    await preload.prime(first!, current);
    expect(await outcome(preload.execute(first!, path))).toBe('完成');
    const started = performance.now(), file = (): number => 5000 + performance.now() - started;
    // The second decoder never comes up for clip-1.
    obs.failOnce(type => type === 'GetSourceScreenshot');
    expect(await outcome(preload.upcoming(30, current))).toBe('OBS 没能执行 GetSourceScreenshot');
    await vi.advanceTimersByTimeAsync(2000 - (performance.now() - started));
    const before = obs.sent.length;
    expect(await outcome(preload.execute(second!, path))).toBe('完成');
    // clip-1's on-air step only: shown, its sound setting, its scene on program. The first decoder plays on, at clip-1's place in the file.
    expect(obs.sent.slice(before)).toEqual(['显示 主', '静音 主', '切场景']);
    expect(obs.view()).toMatchObject({ decoder: '主', state: 'PLAYING' });
    expect(Math.abs(obs.position(primary) - file())).toBeLessThanOrEqual(100);
    expect(preload.onAirSource(primary)).toBe(primary);
    // clip-1 is not prepared again: the next preparation is clip-2's, on the second decoder.
    const preparing = preload.upcoming(90, current);
    expect(await outcome(preparing)).toBe('完成');
    expect(await preparing).toMatchObject({ clipId: 'clip-2' });
    // The drift check, as production wires it, reaches it as clip-1's decoder.
    await vi.advanceTimersByTimeAsync(1000);
    const correction = pictureDriftCheck(scenes, preload)({ ...second!, sourceOffsetMs: Math.round(file()) + 600 }, () => true);
    expect(await outcome(correction)).toBe('完成');
    expect(await correction).toBeLessThan(-300);
    // clip-1's end takes it off; clip-2 starts on time on the second decoder, which only then goes on air.
    expect(await outcome(preload.execute({ ...second!, phase: 'stop', frameNumber: 120 }, path))).toBe('完成');
    expect(obs.decoder(primary)).toMatchObject({ state: 'OBS_MEDIA_STATE_PAUSED', enabled: false, muted: true });
    expect(obs.sent).not.toContain('显示 预备');
    expect(await outcome(preload.execute(third!, path))).toBe('完成');
    expect(obs.view()).toMatchObject({ decoder: '预备', state: 'PLAYING' });
    expect(Math.abs(obs.view().cursor - 20000)).toBeLessThanOrEqual(100);
  } finally { vi.useRealTimers(); }
});

it('接着往下播只认画面上正在播上一段的解码器：不在画面上的、在播别的片段的都不接；接上以后漂移检查跟着新的这一段走', async () => {
  vi.useFakeTimers();
  try {
    const t = await handover(), [first, second, third] = t.events, started = performance.now();
    // clip-0 plays on the first decoder; the second waits for clip-1, primed and off air.
    expect(t.scenes.continueClip(t.standby, first!.clipId, second!)).toBe(false);
    expect(t.scenes.continueClip(t.primary, second!.clipId, third!)).toBe(false);
    expect(t.obs.sent).toEqual([]);
    expect(t.scenes.continueClip(t.primary, first!.clipId, second!)).toBe(true);
    expect(t.obs.sent).toEqual([]);
    const aligned = (): number => 100 + 600 + performance.now() - started;
    expect(await t.scenes.correctDrift({ ...first!, sourceName: t.primary }, aligned)).toBeNull();
    const correction = t.scenes.correctDrift({ ...second!, sourceName: t.primary }, aligned);
    expect(await outcome(correction)).toBe('完成');
    expect(await correction).toBeLessThan(-300);
    // After OBS reconnects the material is prepared again: nothing of it counts as on air until the picture is rebuilt.
    expect(await outcome(t.scenes.prepare(t.project.projectId, t.project.mediaAssets[0]!, path))).toBe('完成');
    expect(t.scenes.continueClip(t.primary, second!.clipId, third!)).toBe(false);
  } finally { vi.useRealTimers(); }
});

it('同一视频的两段文件位置正好接得上、时间线上却隔着空档（上一段的停止没有单独发来），下一段没准备好：不当作接着播，上一段在被拒绝时退下', async () => {
  // clip-0 [0,2) s from the file's start and clip-1 [3,5) s from 2000 ms: the file goes on, the timeline has a second's gap.
  const t = mocked(song([[0, 2000, 0], [3, 2000, 2000]])), [first, second] = t.events;
  t.scenes.continueClip.mockReturnValue(true);
  await t.preload.prime(first!, current); await t.preload.execute(first!, path);
  await expect(t.preload.execute(second!, path)).rejects.toThrow(new Error('下一个素材没能在切换前准备好：视频'));
  expect(t.scenes.continueClip).not.toHaveBeenCalled();
  expect(t.scenes.execute.mock.calls.map(([event]) => [event.clipId, event.phase])).toEqual([['clip-0', 'start'], ['clip-0', 'stop']]);
});

it('同一视频切成首尾相接、入点接得上的两段，后一段关了原声，切换时后一段没准备好：照样接着往下播，这一段上画面的那一步按它自己的设置关掉原声', async () => {
  // Video sound plays along with the music; clip-0 [0,2) s from 5000 ms with its sound, clip-1 [2,4) s from 7000 ms without.
  const cut = song([[0, 2000, 5000], [2, 2000, 7000], [8, 2000, 20000]]);
  const project = parseLinkProject({ ...cut, internalVideoAudio: true, rundown: cut.rundown.map(item => ({ ...item,
    referenceMediaClips: item.referenceMediaClips.map(clip => clip.id === 'clip-1' ? { ...clip, embeddedAudioEnabled: false } : clip) })) });
  const t = mocked(project), [first, second] = t.events, primary = first!.sourceName;
  expect([first!.embeddedAudioEnabled, second!.embeddedAudioEnabled]).toEqual([true, false]);
  t.scenes.continueClip.mockReturnValue(true);
  await t.preload.prime(first!, current); await t.preload.execute(first!, path);
  await t.preload.execute(second!, path);
  expect(t.scenes.continueClip).toHaveBeenCalledExactlyOnceWith(primary, 'clip-0', second);
  expect(t.scenes.execute.mock.calls.map(([event, , previous]) => [event.clipId, event.phase, event.sourceName === primary, event.embeddedAudioEnabled, previous ?? null]))
    .toEqual([['clip-0', 'start', true, true, null], ['clip-1', 'start', true, false, null]]);
  expect(t.preload.onAirSource(primary)).toBe(primary);
});

it('同一段音频切成首尾相接、入点接得上的两段，接着往下播时 OBS 没能做完这一段上画面的那一步：红字写明声音接着往下播、原因和怎么办，不重发；它仍算这一段的', async () => {
  const cut = song([[0, 2000, 5000], [2, 2000, 7000]]);
  const project = parseLinkProject({ ...cut, mediaAssets: cut.mediaAssets.map(asset => ({ ...asset, kind: 'audio' as const })) });
  const t = mocked(project), [first, second] = t.events, primary = first!.sourceName;
  t.scenes.continueClip.mockReturnValue(true);
  await t.preload.prime(first!, current); await t.preload.execute(first!, path);
  t.scenes.execute.mockRejectedValueOnce(new Error('SetInputMute：OBS 没能执行 SetInputMute'));
  await expect(t.preload.execute(second!, path)).rejects.toThrow(new Error('声音接着上一段往下播，切到这一段时出了错。原因：SetInputMute：OBS 没能执行 SetInputMute。'
    + '如果这一段的声音不对，在 OBS 混音器里调整；后面的素材照常播'));
  expect(t.scenes.execute).toHaveBeenCalledTimes(2);
  expect(t.preload.onAirSource(primary)).toBe(primary);
});

it('同一段音频切成首尾相接、入点接得上的两段，接着往下播时 OBS 做完了上画面那一步、只是位置和音乐没对齐：红字写明声音切到了这一段但没对齐、原因，不用处理；它仍算这一段的', async () => {
  const cut = song([[0, 2000, 5000], [2, 2000, 7000]]);
  const project = parseLinkProject({ ...cut, mediaAssets: cut.mediaAssets.map(asset => ({ ...asset, kind: 'audio' as const })) });
  const t = mocked(project), [first, second] = t.events, primary = first!.sourceName;
  t.scenes.continueClip.mockReturnValue(true);
  await t.preload.prime(first!, current); await t.preload.execute(first!, path);
  t.scenes.execute.mockRejectedValueOnce(new MediaOutOfStepError('切场景后素材位置对不上：视频，按音乐应该在 7000 ms，OBS 实际在 7400 ms'));
  await expect(t.preload.execute(second!, path)).rejects.toThrow(new Error('声音接着上一段往下播，切到了这一段，但和音乐没对齐。原因：切场景后素材位置对不上：视频，按音乐应该在 7000 ms，OBS 实际在 7400 ms。'
    + '差得多时联动台过几秒会自动按音乐校正，不用处理；后面的素材照常播'));
  expect(t.scenes.execute).toHaveBeenCalledTimes(2);
  expect(t.preload.onAirSource(primary)).toBe(primary);
});

it('接着往下播时没对齐：重新写的红字带着原来的错误（cause），它自己不算“没对齐”的类型，文案和分支都不变（2026-11-11 R3b）', async () => {
  const cut = song([[0, 2000, 5000], [2, 2000, 7000]]);
  const t = mocked(cut), [first, second] = t.events;
  t.scenes.continueClip.mockReturnValue(true);
  await t.preload.prime(first!, current); await t.preload.execute(first!, path);
  const original = new MediaOutOfStepError('切场景后素材位置对不上：视频，按音乐应该在 7000 ms，OBS 实际在 7400 ms');
  t.scenes.execute.mockRejectedValueOnce(original);
  const error = await t.preload.execute(second!, path).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(MediaOutOfStepError);
  expect((error as Error).message).toBe('画面接着上一段往下播，切到了这一段，但和音乐没对齐。原因：切场景后素材位置对不上：视频，按音乐应该在 7000 ms，OBS 实际在 7400 ms。'
    + '差得多时联动台过几秒会自动按音乐校正，不用处理；后面的素材照常播');
  expect((error as Error).cause).toBe(original);
});

it('上一段的解码器接着往下播时，OBS 没能切到这一段的场景：红字写明画面接着往下播、原因和怎么办，不重发；它仍算这一段的解码器，漂移检查、暂停和停止照常送到它', async () => {
  vi.useFakeTimers();
  try {
    // clip-0 [0,2) s from 5000 ms and clip-1 [2,4) s from 7000 ms: one video cut in two; clip-1's decoder never comes up.
    const project = song([[0, 2000, 5000], [2, 2000, 7000], [30, 2000, 20000]]), obs = fakeObs();
    const scenes = new ObsMediaScenes(obs.client, obs.request, operation => operation());
    const preload = new ObsMediaPreload(project, 'song', scenes, obs.native);
    const [first, second] = new SceneOutputTimeline(project, 'song').preloadEntries(), primary = first!.sourceName;
    await scenes.prepare(project.projectId, project.mediaAssets[0]!, path);
    preload.register(project.projectId, project.mediaAssets[0]!, path);
    await preload.prime(first!, current);
    expect(await outcome(preload.execute(first!, path))).toBe('完成');
    const started = performance.now(), file = (): number => 5000 + performance.now() - started;
    obs.failOnce(type => type === 'GetSourceScreenshot');
    expect(await outcome(preload.upcoming(30, current))).toBe('OBS 没能执行 GetSourceScreenshot');
    await vi.advanceTimersByTimeAsync(2000 - (performance.now() - started));
    obs.failOnce(type => type === 'SetCurrentProgramScene');
    const before = obs.sent.length;
    expect(await outcome(preload.execute(second!, path))).toBe('画面接着上一段往下播，切到这一段时出了错。原因：SetCurrentProgramScene：OBS 没能执行 SetCurrentProgramScene。'
      + '如果 OBS 节目画面上不是这段素材，在 OBS 里切到它的场景；后面的素材照常播');
    expect(obs.sent.slice(before)).toEqual(['显示 主', '静音 主']);
    expect(obs.decoder(primary)).toMatchObject({ state: 'OBS_MEDIA_STATE_PLAYING', enabled: true });
    expect(scenes.isActive(primary)).toBe(true);
    expect(preload.onAirSource(primary)).toBe(primary);
    await vi.advanceTimersByTimeAsync(500);
    const correction = pictureDriftCheck(scenes, preload)({ ...second!, sourceOffsetMs: Math.round(file()) + 600 }, () => true);
    expect(await outcome(correction)).toBe('完成');
    expect(await correction).toBeLessThan(-300);
    const received: LinkAction[] = [], executor = pictureExecutor(adapter(obs, scenes, () => Promise.resolve(), received), preload, { record: recorder(), projectId: project.projectId, itemId: 'song' });
    await executor.execute({ id: 'pause', label: '同步暂停', kind: 'obs.mediaAction', inputName: primary, action: 'pause' });
    expect(obs.decoder(primary).state).toBe('OBS_MEDIA_STATE_PAUSED');
    // clip-1's stop takes it off; the scene switch is not sent again.
    expect(await outcome(preload.execute({ ...second!, phase: 'stop', frameNumber: 120 }, path))).toBe('完成');
    expect(obs.decoder(primary)).toMatchObject({ enabled: false, muted: true });
    expect(obs.sent.slice(before).filter(entry => entry === '切场景')).toEqual([]);
  } finally { vi.useRealTimers(); }
});

it.each([[7040, true], [7041, false], [6960, true], [6959, false]])('同一视频切成首尾相接的两段（25 帧），后一段没准备好、入点在文件 %s ms 处：上一段到剪切点时播到 7000 ms，差一帧（40 ms）以内算接着往下播（%s），超过一帧就不算，这一段被拒绝、上一段退下', async (offset, continuing) => {
  // clip-0 [0,2) s from 5000 ms reaches 7000 ms in the file at the cut.
  const t = mocked(cutVideo([[0, 2000, 5000], [2000, 2000, offset], [8000, 2000, 20000]], [], '25')), [first, second] = t.events, primary = first!.sourceName;
  t.scenes.continueClip.mockReturnValue(true);
  await t.preload.prime(first!, current); await t.preload.execute(first!, path);
  const starting = t.preload.execute(second!, path);
  if (continuing) {
    await starting;
    expect(t.scenes.continueClip).toHaveBeenCalledExactlyOnceWith(primary, 'clip-0', second);
    expect(t.scenes.execute).toHaveBeenLastCalledWith({ ...second!, sourceName: primary }, path, undefined, 'pause');
  } else {
    await expect(starting).rejects.toThrow(new Error('下一个素材没能在切换前准备好：视频'));
    expect(t.scenes.continueClip).not.toHaveBeenCalled();
    expect(t.scenes.execute.mock.calls.map(([event]) => [event.clipId, event.phase])).toEqual([['clip-0', 'start'], ['clip-0', 'stop']]);
  }
});

it('上一段的退下已经发过一次、OBS 没执行（它仍在画面上），接得上的下一段又没准备好：不当作接着播，也不重发退下', async () => {
  // clip-0 [0,2) s from 5000 ms and clip-1 [2,4) s from 7000 ms: one video cut in two.
  const t = mocked(song([[0, 2000, 5000], [2, 2000, 7000]])), [first, second] = t.events, primary = first!.sourceName;
  t.scenes.isActive.mockImplementation(name => name === primary);
  t.scenes.continueClip.mockReturnValue(true);
  await t.preload.prime(first!, current); await t.preload.execute(first!, path);
  // clip-0's own stop reached the preload and OBS did not carry it out: the decoder may still be on air.
  t.scenes.execute.mockRejectedValueOnce(new Error('SetSceneItemEnabled：OBS 没能执行 SetSceneItemEnabled'));
  await expect(t.preload.execute({ ...first!, phase: 'stop', frameNumber: 60 }, path)).rejects.toThrow('SetSceneItemEnabled');
  expect(t.preload.resolveSource(primary)).toBe(primary);
  await expect(t.preload.execute(second!, path)).rejects.toThrow(new Error('下一个素材没能在切换前准备好：视频'));
  expect(t.scenes.continueClip).not.toHaveBeenCalled();
  expect(t.scenes.execute.mock.calls.filter(([event]) => event.phase === 'stop')).toHaveLength(1);
});

it('下一段的开始被拒绝时上一段也没能退下：报错写明并说明怎么办，画面上的解码器仍记在这个素材名下；退下不单独重发，同一素材的下一段交接时照常把它退下', async () => {
  // clip-0 [0,2) s, clip-1 [2,4) s right after it, clip-2 [5,7) s, all from the file's start: neither clip-1 nor clip-2 was prepared in time.
  const t = mocked(song([[0, 2000], [2, 2000], [5, 2000]])), [first, second, third] = t.events, primary = first!.sourceName;
  t.scenes.isActive.mockImplementation(name => name === primary);
  await t.preload.prime(first!, current); await t.preload.execute(first!, path);
  t.scenes.execute.mockRejectedValueOnce(new Error('SetSceneItemEnabled：OBS 没能执行 SetSceneItemEnabled'));
  await expect(t.preload.execute(second!, path)).rejects.toThrow(new Error('下一个素材没能在切换前准备好：视频。上一段的画面也没能退下，可能还留在 OBS 节目画面上。'
    + '原因：SetSceneItemEnabled：OBS 没能执行 SetSceneItemEnabled。如果 OBS 画面上还是上一段，在 OBS 里把它隐藏；后面的素材照常播'));
  // clip-2's start is refused as well; clip-0's retirement already went out once and is not sent again.
  await expect(t.preload.execute(third!, path)).rejects.toThrow(new Error('下一个素材没能在切换前准备好：视频'));
  expect(t.scenes.execute.mock.calls.filter(([event]) => event.phase === 'stop')).toHaveLength(1);
  // clip-2 is prepared late on the other decoder and hands over from the one still on air.
  expect(await t.preload.upcoming(160, current)).toMatchObject({ clipId: 'clip-2' });
  expect(t.scenes.prime).toHaveBeenLastCalledWith(expect.objectContaining({ clipId: 'clip-2', sourceName: `${primary}·预备` }), path, expect.any(Function));
  await t.preload.execute({ ...third!, sourceOffsetMs: 333 }, path);
  expect(t.scenes.execute).toHaveBeenLastCalledWith({ ...third!, sourceOffsetMs: 333, sourceName: `${primary}·预备` }, path, primary, 'stop');
});

it('上一段的停止没有单独发来（重建画面时恰好落在下一段开头被省掉），下一段的开始又被拒绝：上一段在被拒绝时退下，停歌时这个素材的解码器仍会清理', async () => {
  // clip-0 [0,2) s and clip-1 [3,5) s with a gap; clip-0's own stop never reached the preload.
  const t = mocked(song([[0, 2000], [3, 2000]])), [first, second] = t.events;
  await t.preload.prime(first!, current); await t.preload.execute(first!, path);
  await expect(t.preload.execute(second!, path)).rejects.toThrow(new Error('下一个素材没能在切换前准备好：视频'));
  expect(t.scenes.execute.mock.calls.map(([event, , previous, retirement]) => [event.clipId, event.phase, event.sourceName === first!.sourceName, previous ?? null, retirement]))
    .toEqual([['clip-0', 'start', true, null, 'pause'], ['clip-0', 'stop', true, null, 'stop']]);
  // The material's main decoder stays owned, so the song's stop stops it again.
  await t.preload.close();
  expect(t.scenes.execute.mock.calls.slice(2).map(([event]) => [event.phase, event.sourceName === first!.sourceName])).toEqual([['stop', true]]);
});

it('下一段的开始被拒绝时退下的是预备解码器、主解码器早已停下：这一段这时没有画面在播，暂停和继续不送到任何解码器；停歌时照样停下主解码器', async () => {
  // clip-0 [0,1) s, clip-1 [1,31) s on the second decoder, clip-2 [31,33) s right after it, not prepared in time.
  // clip-2 is too far off at clip-1's start to keep the first decoder paused: the handover stopped it.
  const t = mocked(song([[0, 1000], [1, 30000], [31, 2000]])), [first, second, third] = t.events, primary = first!.sourceName;
  await t.preload.prime(first!, current); await t.preload.execute(first!, path);
  await t.preload.prime(second!, current); await t.preload.execute(second!, path);
  await expect(t.preload.execute(third!, path)).rejects.toThrow(new Error('下一个素材没能在切换前准备好：视频'));
  expect(t.scenes.execute.mock.calls.map(([event, , previous, retirement]) => [event.clipId, event.phase, event.sourceName === primary ? '主' : '预备', previous === primary ? '主' : previous ?? null, retirement]))
    .toEqual([['clip-0', 'start', '主', null, 'pause'], ['clip-1', 'start', '预备', '主', 'stop'], ['clip-1', 'stop', '预备', null, 'stop']]);
  expect(t.preload.resolveSource(primary)).toBe(primary);
  expect(t.preload.onAirSource(primary)).toBeNull();
  await t.preload.close();
  expect(t.scenes.execute.mock.calls.slice(3).map(([event]) => [event.phase, event.sourceName === primary ? '主' : '预备'])).toEqual([['stop', '主']]);
});

/** The run log's lines for pauses and resumes that reached no decoder. */
const unsent = (logs: ReturnType<typeof recorder>): string[] => logs.mock.calls.map(([entry]) => entry.message).filter(message => message.includes('没有发给 OBS'));
const notOnAir = ['素材暂停没有发给 OBS：这个素材这时没有画面在播，不用处理', '素材继续播放没有发给 OBS：这个素材这时没有画面在播，不用处理'];

it.each<[string, (type: string, data: Record<string, unknown>) => boolean, boolean]>([
  ['显示它之前（OBS 没能显示它）', (type, data) => type === 'SetSceneItemEnabled' && data.sceneItemEnabled === true, false],
  ['显示它之后（定位时）', type => type === 'SetMediaInputCursor' || type === 'GetSceneItemTransform', true]
])('从中间开播或 OBS 重连后重建画面，定位片段时 OBS 在%s出错：没显示出来的不算在画面上，随后的继续播放和暂停都不发给它、日志各记一行；已经显示出来的照常收到', async (_case, failure, shown) => {
  vi.useFakeTimers();
  try {
    const project = song([[0, 12000], [12, 12000]]), obs = fakeObs();
    const scenes = new ObsMediaScenes(obs.client, obs.request, operation => operation());
    const preload = new ObsMediaPreload(project, 'song', scenes, obs.native);
    await scenes.prepare(project.projectId, project.mediaAssets[0]!, path);
    preload.register(project.projectId, project.mediaAssets[0]!, path);
    const [first] = new SceneOutputTimeline(project, 'song').preloadEntries(), primary = first!.sourceName;
    obs.failOnce(failure);
    expect(await outcome(preload.seek({ ...first!, sourceOffsetMs: 3000 }, path))).toContain('OBS 没能执行');
    expect(preload.onAirSource(primary)).toBe(shown ? primary : null);
    const before = obs.sent.length, received: LinkAction[] = [], logs = recorder();
    const executor = pictureExecutor(adapter(obs, scenes, () => Promise.resolve(), received), preload, { record: logs, projectId: project.projectId, itemId: 'song' });
    // The program plays the picture it rebuilt, then the operator pauses.
    await executor.execute({ id: 'start', label: '同步继续', kind: 'obs.mediaAction', inputName: primary, action: 'start' });
    await executor.execute({ id: 'pause', label: '同步暂停', kind: 'obs.mediaAction', inputName: primary, action: 'pause' });
    expect(obs.sent.slice(before)).toEqual(shown ? ['PLAY 主', 'PAUSE 主'] : []);
    expect(unsent(logs)).toEqual(shown ? [] : [notOnAir[1], notOnAir[0]]);
    // Not shown, its scene never went on program: the decoder is not woken behind it.
    if (!shown) expect([obs.program() === obs.decoder(primary).scene, obs.decoder(primary).state, obs.decoder(primary).muted]).toEqual([false, 'OBS_MEDIA_STATE_STOPPED', true]);
    // Its stop still reaches that decoder.
    expect(await outcome(preload.execute({ ...first!, phase: 'stop', frameNumber: 360 }, path))).toBe('完成');
    expect(obs.decoder(primary)).toMatchObject({ enabled: false, muted: true });
  } finally { vi.useRealTimers(); }
});

it('入点接不上的下一段没能在切换前准备好，上一段在被拒绝时停止退下；操作员接着暂停又继续：这一段这时没有画面在播，暂停和继续不发给任何解码器、不算失败，日志各记一行；准备好后这一段按当前位置晚开播，停歌时两个解码器都停下', async () => {
  // clip-0 [0,1) s from 5000 ms and clip-1 [1,4) s from 9000 ms (the video jumps there); clip-2 at 30 s is too far off to keep clip-0's decoder paused.
  const project = song([[0, 1000, 5000], [1, 3000, 9000], [30, 2000, 20000]]), obs = fakeObs();
  // OBS is slow to set up the second decoder for clip-1.
  const release = obs.holdNextBatch(standbySetup);
  const t = await live(project, obs, () => Promise.resolve(), false, 'production');
  const primary = new SceneOutputTimeline(project, 'song').preloadEntries()[0]!.sourceName, standby = `${primary}·预备`;
  await t.play(0, 900, true);
  await t.play(1000, 1200, true);
  expect(obs.decoder(primary)).toMatchObject({ state: 'OBS_MEDIA_STATE_STOPPED', enabled: false, muted: true });
  expect(t.failures()).toEqual(['clip-1 start failed：下一个素材没能在切换前准备好：视频']);
  const before = obs.sent.length;
  await t.session.pause();
  t.at(1300); t.session.clock(1300); await t.session.settled();
  // The stopped decoder is not woken: nothing went to OBS, nothing in red.
  expect(obs.sent.slice(before)).toEqual([]);
  expect(t.received.filter(action => action.kind === 'obs.mediaAction')).toEqual([]);
  expect(obs.decoder(primary).state).toBe('OBS_MEDIA_STATE_STOPPED');
  expect(t.failedActions()).toEqual([]);
  expect(unsent(t.logs)).toEqual(notOnAir);
  release();
  await t.play(1400, 5000, true);
  expect(t.reports).toContain('clip-1 start succeeded');
  await t.session.stop();
  expect([obs.decoder(primary).state, obs.decoder(standby).state]).toEqual(['OBS_MEDIA_STATE_STOPPED', 'OBS_MEDIA_STATE_STOPPED']);
  expect([obs.decoder(primary).enabled, obs.decoder(standby).enabled]).toEqual([false, false]);
});

it('入点接不上的下一段预热直接失败，上一段在被拒绝时暂停退下，同一素材再下一段随后在它上面预热好；操作员在这一段里暂停又继续：都不发给任何解码器，再下一段按时从预热的画面开播，不从文件开头播', async () => {
  vi.useFakeTimers();
  try {
    // clip-0 [0,1) s from 5000 ms, clip-1 [1,4) s from 9000 ms (the video jumps there), clip-2 [12,14) s from 20000 ms.
    const project = song([[0, 1000, 5000], [1, 3000, 9000], [12, 2000, 20000]]), obs = fakeObs();
    // The second decoder never comes up for clip-1.
    obs.failOnce((type, data) => type === 'GetSourceScreenshot' && String(data.sourceName).endsWith('·预备'));
    const t = await live(project, obs, () => Promise.resolve(), false, 'production');
    const primary = new SceneOutputTimeline(project, 'song').preloadEntries()[0]!.sourceName;
    await t.run(0, 3000);
    expect(t.failures()).toEqual(['clip-1 start failed：下一个素材没能在切换前准备好：视频']);
    // clip-0's decoder went off paused at the cut, and clip-2 is primed on it since, off air at its entry point.
    expect(obs.decoder(primary)).toMatchObject({ state: 'OBS_MEDIA_STATE_PAUSED', enabled: false, base: 20000 });
    const before = obs.sent.length;
    await settle(t.session.pause());
    t.at(3100); t.session.clock(3100); await settle(t.session.settled());
    expect(obs.sent.slice(before)).toEqual([]);
    expect(obs.decoder(primary)).toMatchObject({ state: 'OBS_MEDIA_STATE_PAUSED', base: 20000 });
    expect(t.failedActions()).toEqual([]);
    expect(unsent(t.logs)).toEqual(notOnAir);
    await t.run(3200, 12500);
    // clip-2 starts on time from its primed frame: shown, its sound, its scene, then played.
    expect(obs.sent.slice(before)).toEqual(['显示 主', '静音 主', '切场景', 'PLAY 主']);
    expect(t.reports).toContain('clip-2 start succeeded');
    expect(obs.view()).toMatchObject({ decoder: '主', state: 'PLAYING' });
    expect(Math.abs(obs.view().cursor - 20500)).toBeLessThanOrEqual(100);
    await settle(t.session.stop());
  } finally { vi.useRealTimers(); }
});

it('操作员写的 Cue 里的 OBS 动作（不是节目里的素材）照原名发出；节目里素材的暂停送到它画面上的那个解码器', async () => {
  vi.useFakeTimers();
  try {
    const t = await handover();
    await t.preload.execute(t.events[1]!, path);
    const sent: LinkAction[] = [], logs = recorder();
    const executor = pictureExecutor({ id: 'obs', supports: () => true, execute: action => { sent.push(action); return Promise.resolve(); },
      setSourceEnabledInProgramScene: (sourceName, enabled) => { sent.push({ id: 'shown', kind: 'obs.setSceneItemEnabled', label: '显示', sceneName: '', sourceName, enabled }); return Promise.resolve(); } },
    t.preload, { record: logs, projectId: t.project.projectId, itemId: 'song' });
    await executor.execute({ id: 'intro', label: '片头', kind: 'obs.mediaAction', inputName: '片头视频', action: 'restart' });
    await executor.execute({ id: 'intro-sound', label: '片头声音', kind: 'obs.setInputMute', inputName: '片头视频', muted: false });
    await executor.execute({ id: 'logo', label: '台标', kind: 'obs.setSceneItemEnabled', sceneName: '机位1', sourceName: '台标', enabled: true });
    await executor.execute({ id: 'pause', label: '同步暂停', kind: 'obs.mediaAction', inputName: t.primary, action: 'pause' });
    // Any name the preload does not know is the user's own, even one shaped like an input of the
    // app's: it goes out as it is. (Every material of the song is known: one that fails to prepare
    // fails the song's picture before it can play, in preloadResources.)
    const unprepared = materialSceneNames(t.project.projectId, { ...t.project.mediaAssets[0]!, id: 'video-2', name: '视频2' }).sourceName;
    await executor.execute({ id: 'pause-2', label: '同步暂停', kind: 'obs.mediaAction', inputName: unprepared, action: 'pause' });
    expect(sent.map(action => [action.kind, 'inputName' in action ? action.inputName : 'sourceName' in action ? action.sourceName : null])).toEqual([
      ['obs.mediaAction', '片头视频'], ['obs.setInputMute', '片头视频'], ['obs.setSceneItemEnabled', '台标'], ['obs.mediaAction', t.standby], ['obs.mediaAction', unprepared]]);
    expect(logs).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it('被机位盖住、开始又被合并跳过的片段，之后再被机位盖住：一直留着预备位置到它真正结束，不重复预热，再露出时照常开播', async () => {
  // clip-0 [0,12) s, clip-1 [12,24) s, clip-2 [24,36) s; cameras [10,14) s and [16,18) s above: clip-1 shows at 14 s and again at 18 s.
  const t = mocked(withCameras(song([[0, 12000], [12, 12000], [24, 12000]], undefined, 100), [[10, 4], [16, 2]]));
  expect(t.events.map(event => [event.clipId, event.frameNumber, event.sourceOffsetMs])).toEqual([['clip-0', 0, 100], ['clip-1', 420, 2100], ['clip-1', 540, 6100], ['clip-2', 720, 100]]);
  const [first, , again] = t.events, standby = `${first!.sourceName}·预备`;
  await t.preload.prime(first!, current); await t.preload.execute(first!, path);
  expect(await t.preload.upcoming(150, current)).toMatchObject({ clipId: 'clip-1', frameNumber: 420 });
  await t.preload.execute({ ...first!, phase: 'stop', frameNumber: 360 }, path);
  // OBS was busy at 14 s and clip-1's start there was merged away. On air at 15 s, under the second camera at 16.7 s and at 18 s less a frame.
  for (const frame of [450, 500, 539]) expect(await t.preload.upcoming(frame, current)).toBeNull();
  await t.preload.execute(again!, path);
  expect(t.scenes.prime.mock.calls.map(([event]) => event.clipId)).toEqual(['clip-0', 'clip-1']);
  expect(t.scenes.execute).toHaveBeenLastCalledWith({ ...again!, sourceName: standby }, path, undefined, 'pause');
});

it('片段停止没成功、而它的解码器已经不在画面上：不再把它记成这个素材正在播的解码器，下一段不从它交接', async () => {
  // clip-0 [0,6) s, clip-1 [7,13) s and clip-2 [14,20) s of the same video, with gaps between.
  const t = mocked(song([[0, 6000], [7, 6000], [14, 6000]], undefined, 100)), [first, second, third] = t.events;
  const primary = first!.sourceName, standby = `${primary}·预备`;
  await t.preload.prime(first!, current); await t.preload.execute(first!, path);
  expect(await t.preload.upcoming(60, current)).toMatchObject({ clipId: 'clip-1' });
  await t.preload.execute({ ...first!, phase: 'stop', frameNumber: 180 }, path);
  await t.preload.execute(second!, path);
  expect(await t.preload.upcoming(240, current)).toMatchObject({ clipId: 'clip-2' });
  expect(t.preload.resolveSource(primary)).toBe(standby);
  // OBS no longer counts the decoder as on air (isActive is false), and its stop fails.
  t.scenes.execute.mockRejectedValueOnce(new Error('SetSceneItemEnabled：OBS 没能执行 SetSceneItemEnabled'));
  await expect(t.preload.execute({ ...second!, phase: 'stop', frameNumber: 390 }, path)).rejects.toThrow('OBS 没能执行 SetSceneItemEnabled');
  expect(t.preload.resolveSource(primary)).toBe(primary);
  await t.preload.execute(third!, path);
  expect(t.scenes.execute).toHaveBeenLastCalledWith({ ...third!, sourceName: primary }, path, undefined, 'stop');
});

/* 0.5.9 E16: how each clip looks in OBS. A clip edited in the editor has its look set on its decoder's scene item
 * when the material is prepared (core media-obs-transform.ts); a clip never edited since leaves OBS's look alone. */

/** `project` with these clips' looks decided by the project, as an edit in the editor leaves them. */
function withLooks(project: LinkProject, looks: Readonly<Record<string, ReferenceCanvasTransform>>): LinkProject {
  const item = project.rundown[0]!;
  return parseLinkProject({ ...project, schemaVersion: 3, rundown: [{ ...item, referenceMediaClips: item.referenceMediaClips.map(clip => {
    const look = looks[clip.id];
    return look ? { ...clip, canvasTransform: look, obsTransform: 'project' as const } : clip;
  }) }] });
}
const leftLook: ReferenceCanvasTransform = { x: 0.25, y: 0.3, scale: 0.5, scaleX: 1, scaleY: 1, rotation: 0 };
const rightLook: ReferenceCanvasTransform = { x: 0.75, y: 0.7, scale: 0.8, scaleX: 1.2, scaleY: 1, rotation: 15 };
/** What OBS gets for a look on the fake's 1080×1920 canvas. */
const inObs = (look: ReferenceCanvasTransform) => obsMaterialPresentation(look, { width: 1080, height: 1920 }).sceneItemTransform;
/** The look a material scene item is created with: fitted to the canvas, OBS's own look from then on. */
const createdLook = { positionX: 540, positionY: 960, alignment: 0, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: 1080, boundsHeight: 1920 };
/** Only scenes of ours, and only material pictures in them, get a look written. */
const ownMaterial = (write: LookWrite): boolean => write.sceneName.startsWith('团播联动台·素材·') && /·来源(·预备)?$/u.test(write.input);

it('E16 规则：准备素材时，主解码器和预备解码器各按自己那一段在工程里的样子设好；交接时各用各的，播出中不改样子', async () => {
  const project = withLooks(song([[0, 12000, 100], [12, 12000, 12100]]), { 'clip-0': leftLook, 'clip-1': rightLook }), obs = fakeObs();
  const t = await live(project, obs);
  const primary = new SceneOutputTimeline(project, 'song').preloadEntries()[0]!.sourceName, standby = `${primary}·预备`;
  // Both decoders are prepared before the clock starts: each has its clip's look already.
  expect(obs.decoder(primary).look).toMatchObject(inObs(leftLook));
  expect(obs.decoder(standby).look).toMatchObject(inObs(rightLook));
  expect(obs.lookWrites.every(ownMaterial)).toBe(true);
  obs.lookWrites.length = 0;
  await t.play(0, 13000, true);
  expect(t.reports).toEqual(expect.arrayContaining(['clip-0 start succeeded', 'clip-1 start succeeded']));
  // Nothing about the look was written while the song played: the handover shows each decoder as it was prepared.
  expect(obs.lookWrites).toEqual([]);
  const shown = obs.seenLooks.filter(view => view.input !== null);
  expect(shown.map(view => view.input)).toEqual([primary, standby]);
  expect(JSON.parse(shown[0]!.look)).toMatchObject(inObs(leftLook));
  expect(JSON.parse(shown[1]!.look)).toMatchObject(inObs(rightLook));
  await t.session.stop();
});

it('E16 规则：没在编辑器里改过的素材，联动台不发任何素材样子；OBS 里是什么样就什么样', async () => {
  const project = song([[0, 12000, 100], [12, 12000, 12100], [24, 12000, 24100]]), obs = fakeObs();
  const t = await live(project, obs);
  await t.play(0, 25000, true);
  expect(t.reports).toEqual(expect.arrayContaining(['clip-0 start succeeded', 'clip-1 start succeeded', 'clip-2 start succeeded']));
  // The only looks written are the one the scene item was created with and copies of it to the second decoder, as
  // before 0.5.9: never a look of the project's, never while on air.
  expect(obs.lookWrites.length).toBeGreaterThan(0);
  for (const write of obs.lookWrites) {
    expect(write.look).toMatchObject(createdLook);
    expect(write.onAir).toBe(false);
  }
  expect(obs.lookWrites.some(write => write.look.boundsType === 'OBS_BOUNDS_NONE')).toBe(false);
  await t.session.stop();
});

it('E16 规则：同一素材前一段有自己的样子、后一段没设：后一段换回这个素材在 OBS 里原来的样子，在它上屏之前换好', async () => {
  const project = withLooks(song([[0, 12000, 100], [12, 12000, 12100], [24, 12000, 24100]]), { 'clip-0': leftLook, 'clip-2': rightLook }), obs = fakeObs();
  const t = await live(project, obs);
  const primary = new SceneOutputTimeline(project, 'song').preloadEntries()[0]!.sourceName, standby = `${primary}·预备`;
  expect(obs.decoder(primary).look).toMatchObject(inObs(leftLook));
  // clip-1 is prepared on the second decoder with the material's own look, not clip-0's.
  expect(obs.decoder(standby).look).toMatchObject(createdLook);
  await t.play(0, 25000, true);
  expect(t.reports).toEqual(expect.arrayContaining(['clip-0 start succeeded', 'clip-1 start succeeded', 'clip-2 start succeeded']));
  // clip-2 comes back on the first decoder with its own look, set while that decoder was off air.
  expect(obs.decoder(primary).look).toMatchObject(inObs(rightLook));
  expect(obs.lookWrites.every(write => !write.onAir && ownMaterial(write))).toBe(true);
  const shown = obs.seenLooks.filter(view => view.input !== null);
  expect(shown.map(view => view.input)).toEqual([primary, standby, primary]);
  expect(JSON.parse(shown[1]!.look)).toMatchObject(createdLook);
  expect(JSON.parse(shown[2]!.look)).toMatchObject(inObs(rightLook));
  await t.session.stop();
});

it('E16 规则：图片片段的样子和显示同一批发给 OBS，排在显示前面；只写联动台自己的素材场景', async () => {
  const project = withLooks(withLogo(song([[0, 4000, 100]]), [0, 4000]), { 'logo-clip': leftLook }), obs = fakeObs();
  const logo = materialSceneNames(project.projectId, project.mediaAssets[1]!).sourceName;
  const t = await live(project, obs);
  expect(obs.decoder(logo).look).toMatchObject(createdLook);
  await t.play(0, 1000, true);
  expect(t.reports).toContain('logo-clip start succeeded');
  expect(obs.decoder(logo).look).toMatchObject(inObs(leftLook));
  expect(obs.lookWrites.filter(write => write.input === logo).at(-1)).toMatchObject({ look: inObs(leftLook), onAir: false });
  expect(obs.lookWrites.every(ownMaterial)).toBe(true);
  await t.session.stop();
});

/* The material's own look is kept on this machine (obs-material-own-looks.ts), so what a clip that is not set shows
 * never depends on what earlier runs did. The fake OBS keeps its scene items across ObsMediaScenes instances, as the
 * scene collection does across restarts of the app. */

/** The same project with no clip's look sent to OBS (an older song, or 「用 OBS 里的样子」): the same material scenes. */
function withoutLooks(project: LinkProject): LinkProject {
  const item = project.rundown[0]!;
  return parseLinkProject({ ...project, schemaVersion: 1, rundown: [{ ...item, referenceMediaClips: item.referenceMediaClips.map(clip => {
    const unset = { ...clip }; delete unset.obsTransform; return unset;
  }) }] });
}
/** How OBS has a material scene item the console created and never placed: the material's own look. */
const ownLook = { ...itemDefaults, ...createdLook };
const primaryOf = (project: LinkProject): string => new SceneOutputTimeline(project, 'song').preloadEntries()[0]!.sourceName;

it('E16 规则：素材原来的样子记在这台电脑上：上一次运行里有一段送过样子，重开软件以后没设的那一段照样是 OBS 原来的样子；那首歌再播一遍也不会把它的样子当成原来的', async () => {
  const placed = withLooks(song([[0, 12000, 100]]), { 'clip-0': leftLook }), unset = withoutLooks(placed), obs = fakeObs(), store = new MemoryMaterialOwnLooks();
  const primary = primaryOf(placed);
  const first = await live(placed, obs, undefined, true, 'test', store);
  // Each run ends as the app quits: what the song left on its last frame is taken off (R14), as its stop did before.
  await first.play(0, 1000, true); await first.session.release();
  expect(obs.decoder(primary).look).toMatchObject(inObs(leftLook));
  expect(store.looks.get(primary)).toMatchObject(ownLook);
  // The app restarts: a new session book, the same OBS and the same machine.
  const second = await live(unset, obs, undefined, true, 'test', store);
  expect(obs.decoder(primary).look).toMatchObject(ownLook);
  await second.play(0, 1000, true);
  expect(second.reports).toContain('clip-0 start succeeded');
  expect(JSON.parse(obs.seenLooks.filter(view => view.input === primary).at(-1)!.look)).toMatchObject(ownLook);
  await second.session.release();
  // Song 1 plays again, then the unset song: the own look kept the first time comes back, not song 1's.
  const third = await live(placed, obs, undefined, true, 'test', store);
  await third.play(0, 1000, true); await third.session.release();
  expect(store.looks.get(primary)).toMatchObject(ownLook);
  await live(unset, obs, undefined, true, 'test', store);
  expect(obs.decoder(primary).look).toMatchObject(ownLook);
  expect(obs.lookWrites.every(write => !write.onAir && ownMaterial(write))).toBe(true);
});

it('E16 规则：OBS 断开重连（clear）只忘掉这次运行记着的，不忘本机记下的原来的样子；软件在送过样子的片段播着时崩了，重开后没设的片段先播也是原来的样子', async () => {
  const placed = withLooks(song([[0, 12000, 100]]), { 'clip-0': leftLook }), unset = withoutLooks(placed), store = new MemoryMaterialOwnLooks();
  const primary = primaryOf(placed);
  // Reconnect: the same ObsMediaScenes, cleared.
  const obs = fakeObs(), first = await live(placed, obs, undefined, true, 'test', store);
  await first.play(0, 1000, true); await first.session.stop();
  first.scenes.clear();
  const preload = new ObsMediaPreload(unset, 'song', first.scenes, obs.native);
  await first.scenes.prepare(unset.projectId, unset.mediaAssets[0]!, path);
  preload.register(unset.projectId, unset.mediaAssets[0]!, path);
  await preload.prime(new SceneOutputTimeline(unset, 'song').at(0).media[0]!, current);
  expect(obs.decoder(primary).look).toMatchObject(ownLook);
  // Crash: the clip with a look is on air when the app goes; a new app plays the unset clip first.
  const crashed = fakeObs(), running = await live(placed, crashed, undefined, true, 'test', store);
  await running.play(0, 1000, true);
  expect(crashed.decoder(primary).look).toMatchObject(inObs(leftLook));
  const after = await live(unset, crashed, undefined, true, 'test', store);
  expect(crashed.decoder(primary).look).toMatchObject(ownLook);
  await after.play(0, 1000, true);
  expect(JSON.parse(crashed.seenLooks.at(-1)!.look)).toMatchObject(ownLook);
});

it('E16 规则：本机没记过原来样子的素材（联动台从没改过它）：没设的片段一个 SetSceneItemTransform 都不发，什么也不记', async () => {
  const project = song([[0, 12000, 100], [12, 12000, 12100]]), obs = fakeObs(), store = new MemoryMaterialOwnLooks();
  await (await live(project, obs, undefined, true, 'test', store)).session.stop();
  obs.lookWrites.length = 0;
  const t = await live(project, obs, undefined, true, 'test', store);
  await t.play(0, 13000, true);
  expect(t.reports).toEqual(expect.arrayContaining(['clip-0 start succeeded', 'clip-1 start succeeded']));
  // Only the standby decoder gets the primary's look copied as before 0.5.9; the material's decoder is never written.
  expect(obs.lookWrites.filter(write => write.input === primaryOf(project))).toEqual([]);
  for (const write of obs.lookWrites) expect(write).toMatchObject({ input: `${primaryOf(project)}·预备`, look: createdLook, onAir: false });
  expect(store.looks.size).toBe(0);
  await t.session.stop();
});

it('E16 规则：素材场景是新建出来的：本机以前记下的原来的样子作废，新建时的样子就是它原来的样子', async () => {
  const project = song([[0, 12000, 100], [12, 12000, 12100]]), obs = fakeObs(), store = new MemoryMaterialOwnLooks(), primary = primaryOf(project);
  store.looks.set(primary, { ...itemDefaults, positionX: 1, positionY: 2 });
  const t = await live(project, obs, undefined, true, 'test', store);
  expect(store.looks.has(primary)).toBe(false);
  await t.play(0, 13000, true);
  for (const write of obs.lookWrites) expect(write.look).toMatchObject(createdLook);
  await t.session.stop();
});

it('E16 规则：原来的样子没能记到本机：不写联动台的样子（没留住原样的场景项不改），片段照常显示，这一段标红写明怎么回事', async () => {
  class FullDisk extends MemoryMaterialOwnLooks { override keep(): Promise<void> { return Promise.reject(new Error('磁盘满了')); } }
  const project = withLooks(song([[0, 12000, 100]]), { 'clip-0': leftLook }), obs = fakeObs(), primary = primaryOf(project);
  const t = await live(project, obs, undefined, true, 'test', new FullDisk());
  await t.play(0, 1000, true);
  expect(obs.lookWrites.some(write => write.look.boundsType === 'OBS_BOUNDS_NONE')).toBe(false);
  expect(obs.decoder(primary).look).toMatchObject(createdLook);
  expect(obs.view().decoder).toBe('主');
  expect(t.reports).toContain('clip-0 start failed：素材“视频”照常在播，但没有按工程里的位置和大小摆，用的是 OBS 里现在的样子。原因：磁盘满了。下一段用到这个素材时会再按工程摆；一直这样，请重新连接 OBS，或把运行日志发给我们');
  await t.session.stop();
});

it('E16 规则：实时画布上拖联动台的素材：第一次写变换之前先把原来的样子记到本机（这次运行没准备过它也认得出来）；之后没设的片段还是原来的样子', async () => {
  const project = song([[0, 12000, 100]]), obs = fakeObs(), store = new MemoryMaterialOwnLooks(), primary = primaryOf(project);
  const t = await live(project, obs, undefined, true, 'test', store);
  await t.play(0, 1000, true);
  const { scene: sceneName, item: sceneItemId } = obs.decoder(primary);
  expect(obs.program()).toBe(sceneName);
  const scenes = new ObsMediaScenes(obs.client, obs.request, operation => operation(), store);
  const editor = new ObsLiveEditor(obs.client, obs.request, operation => operation(), (scene, item) => scenes.beforeLiveTransform(scene, item));
  await editor.edit({ sceneName, sceneItemId, transform: { positionX: 100, positionY: 200 } });
  await editor.edit({ sceneName, sceneItemId, transform: { positionX: 120, positionY: 200 } });
  expect(store.looks.get(primary)).toMatchObject(ownLook);
  expect(obs.decoder(primary).look).toMatchObject({ positionX: 120, positionY: 200 });
  // Not one of ours: nothing is read or kept.
  await scenes.beforeLiveTransform('机位1', 1);
  expect(store.looks.size).toBe(1);
  await t.session.stop();
  await live(project, obs, undefined, true, 'test', store);
  expect(obs.decoder(primary).look).toMatchObject(ownLook);
});

it('E16 规则：复制到预备解码器的是素材原来的样子：本机记着就用记着的，没记过就用主解码器现在的样子（联动台没改过它）', async () => {
  const project = song([[0, 12000, 100]]), obs = fakeObs(), store = new MemoryMaterialOwnLooks();
  const scenes = new ObsMediaScenes(obs.client, obs.request, operation => operation(), store);
  await scenes.prepare(project.projectId, project.mediaAssets[0]!, path);
  const { sceneName, sourceName: primary } = materialSceneNames(project.projectId, project.mediaAssets[0]!), sceneItemId = obs.decoder(primary).item;
  await obs.client.call('SetSceneItemTransform', { sceneName, sceneItemId, sceneItemTransform: { positionX: 300 } });
  const standby = await scenes.prepareStandby(primary);
  expect(obs.decoder(standby).look).toMatchObject({ ...createdLook, positionX: 300 });
  store.looks.set(primary, ownLook);
  await obs.client.call('SetSceneItemTransform', { sceneName, sceneItemId, sceneItemTransform: { positionX: 700, boundsType: 'OBS_BOUNDS_NONE' } });
  await scenes.copyPresentation(primary, standby);
  expect(obs.decoder(standby).look).toMatchObject(ownLook);
});

/** This machine's record of own looks, broken the way a damaged or locked file is. */
class BrokenOwnLooks extends MemoryMaterialOwnLooks {
  constructor(private readonly broken: ReadonlySet<'read' | 'keep' | 'drop'>) { super(); }
  override read(decoder: string): Promise<OwnLook | null> { return this.broken.has('read') ? Promise.reject(new Error('本机记下的素材原来的样子损坏了')) : super.read(decoder); }
  override keep(decoder: string, look: OwnLook): Promise<void> { return this.broken.has('keep') ? Promise.reject(new Error('本机记下的素材原来的样子写不进去')) : super.keep(decoder, look); }
  override drop(decoder: string): Promise<void> { return this.broken.has('drop') ? Promise.reject(new Error('本机记下的素材原来的样子写不进去')) : super.drop(decoder); }
}

it('E16 规则：新建素材场景时本机记录作废不了：素材照常新建、准备、显示；这次运行不写联动台的样子，每次开始标红写明原因', async () => {
  const project = withLooks(song([[0, 12000, 100], [12, 12000, 12100]]), { 'clip-0': leftLook, 'clip-1': rightLook }), obs = fakeObs(), primary = primaryOf(project);
  const t = await live(project, obs, undefined, true, 'test', new BrokenOwnLooks(new Set(['drop'])));
  expect(obs.decoder(primary).look).toMatchObject(createdLook);
  await t.play(0, 13000, true);
  expect(obs.seenLooks.filter(view => view.input !== null).map(view => view.input)).toEqual([primary, `${primary}·预备`]);
  // Only the creation look and its copy to the second decoder, as before 0.5.9: no look of ours.
  for (const write of obs.lookWrites) expect(write.look).toMatchObject(createdLook);
  const red = lookFailure({ assetName: '视频' }, '本机记下的素材原来的样子写不进去');
  expect(t.reports).toEqual(expect.arrayContaining([`clip-0 start failed：${red}`, `clip-1 start failed：${red}`]));
  await t.session.stop();
});

it('E16 规则：复制到预备解码器时本机记录读不了：照样准备好预备解码器，复制主解码器现在的样子', async () => {
  const project = song([[0, 12000, 100]]), obs = fakeObs();
  const scenes = new ObsMediaScenes(obs.client, obs.request, operation => operation(), new BrokenOwnLooks(new Set(['read'])));
  await scenes.prepare(project.projectId, project.mediaAssets[0]!, path);
  const { sceneName, sourceName: primary } = materialSceneNames(project.projectId, project.mediaAssets[0]!);
  await obs.client.call('SetSceneItemTransform', { sceneName, sceneItemId: obs.decoder(primary).item, sceneItemTransform: { positionX: 300 } });
  const standby = await scenes.prepareStandby(primary);
  expect(obs.decoder(standby).look).toMatchObject({ ...createdLook, positionX: 300 });
});

it('E16 规则：从中间开播或定位时样子没设好：片段照常显示、算定位成功，不重发；运行日志记一行，和开始时的红字同一句', async () => {
  vi.useFakeTimers();
  try {
    const project = withLooks(song([[0, 12000, 100]]), { 'clip-0': leftLook }), obs = fakeObs(), primary = primaryOf(project);
    const scenes = new ObsMediaScenes(obs.client, obs.request, operation => operation(), new BrokenOwnLooks(new Set(['keep'])));
    // The native seek leaves the decoder paused where it was told, as the real one does.
    const preload = new ObsMediaPreload(project, 'song', scenes, { ...obs.native, seek: async (name, ms) => {
      await obs.client.call('TriggerMediaInputAction', { inputName: name, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE' }); await obs.native.seek(name, ms);
    } });
    await scenes.prepare(project.projectId, project.mediaAssets[0]!, path);
    preload.register(project.projectId, project.mediaAssets[0]!, path);
    const logs = recorder(), [first] = new SceneOutputTimeline(project, 'song').preloadEntries();
    expect(await outcome(pictureSeekStep(preload, { record: logs, projectId: project.projectId, itemId: 'song' })({ ...first!, sourceOffsetMs: 3000 }, path))).toBe('完成');
    expect(preload.onAirSource(primary)).toBe(primary);
    expect(obs.view()).toMatchObject({ decoder: '主', state: 'PAUSED', cursor: 3000 });
    expect(obs.lookWrites.some(write => write.look.boundsType === 'OBS_BOUNDS_NONE')).toBe(false);
    expect(logs).toHaveBeenCalledTimes(1);
    expect(logs).toHaveBeenCalledWith(expect.objectContaining({ level: 'error', category: 'device', device: '后台画面', result: 'failed',
      message: lookFailure({ assetName: '视频' }, '本机记下的素材原来的样子写不进去'), details: { clipId: 'clip-0' } }));
  } finally { vi.useRealTimers(); }
});

/** A stopped song's last frame on these decoders (R14): `takeOver` hands one over and records it. */
function holding(...names: string[]) {
  const held = new Map(names.map(name => [name, 'stopped-clip'] as const)), order: string[] = [];
  return { held, order, pictures: { decoders: () => held,
    takeOver: vi.fn((name: string, reuse: boolean) => { order.push(`${reuse ? '接着显示' : '让出'} ${name}`); held.delete(name); return Promise.resolve(); }) } };
}

it('上一首停在最后一帧占着主解码器：这一首从预备解码器开播，那一帧不让出（R14）', async () => {
  const project = song([[0, 4000]]), scenes = mockScenes(), native = mockNative(), events = new SceneOutputTimeline(project, 'song').preloadEntries();
  const primary = events[0]!.sourceName, hold = holding(primary);
  const preload = new ObsMediaPreload(project, 'song', scenes, native, hold.pictures);
  preload.register(project.projectId, project.mediaAssets[0]!, path);
  await preload.prime(events[0]!, current);
  expect(scenes.prepareStandby).toHaveBeenCalledExactlyOnceWith(primary);
  expect(scenes.prime.mock.calls.map(([event]) => event.sourceName)).toEqual([`${primary}·预备`]);
  expect(hold.pictures.takeOver).not.toHaveBeenCalled();
  await preload.execute(events[0]!, path);
  expect(preload.onAirSource(primary)).toBe(`${primary}·预备`);
});

it('两个解码器都停着上一首的画面：准备要用的那一个先让出，然后才写它；只有这时最后一帧会在开播前换掉（R14）', async () => {
  const project = song([[0, 4000]]), scenes = mockScenes(), native = mockNative(), events = new SceneOutputTimeline(project, 'song').preloadEntries();
  const primary = events[0]!.sourceName, hold = holding(primary, `${primary}·预备`);
  scenes.prime.mockImplementation(async (event, _path, run) => { hold.order.push(`准备 ${event.sourceName}`); await run(); });
  const preload = new ObsMediaPreload(project, 'song', scenes, native, hold.pictures);
  preload.register(project.projectId, project.mediaAssets[0]!, path);
  await preload.prime(events[0]!, current);
  expect(hold.order).toEqual([`让出 ${primary}`, `准备 ${primary}`]);
  // Asked once: the decoder is this song's from then on.
  await preload.execute(events[0]!, path);
  expect(hold.pictures.takeOver).toHaveBeenCalledOnce();
});

it('空闲时提前准备下一段：停着上一首画面的解码器留给它，不让出（R14）', async () => {
  const project = song([[0, 1000], [1, 1000]]), scenes = mockScenes(), native = mockNative(), events = new SceneOutputTimeline(project, 'song').preloadEntries();
  const primary = events[0]!.sourceName, hold = holding(`${primary}·预备`);
  const preload = new ObsMediaPreload(project, 'song', scenes, native, hold.pictures);
  preload.register(project.projectId, project.mediaAssets[0]!, path);
  await preload.prime(events[0]!, current);
  await preload.primeFollowing(events[0]!, current);
  expect(scenes.prime.mock.calls.map(([event]) => event.sourceName)).toEqual([primary]);
  expect(hold.pictures.takeOver).not.toHaveBeenCalled();
});

/** The same project after 「用 OBS 里的样子」 on every clip: no look sent, and the editor's preview back to plain. */
function obsOwnLooks(project: LinkProject): LinkProject {
  const item = project.rundown[0]!;
  return parseLinkProject({ ...project, schemaVersion: 1, rundown: [{ ...item, referenceMediaClips: item.referenceMediaClips.map(clip => {
    const unset = { ...clip, canvasTransform: { x: 0.5, y: 0.5, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 } }; delete unset.obsTransform; return unset;
  }) }] });
}

/* 0.5.9 E17: mirror, quarter turns, crop and opacity. The first three are part of the scene item's look E16 writes, at
 * the same moments and in the same batch; the opacity is one filter of ours on the decoder's own input. */

/** The fake's video is 1920×1080: this look mirrors it left to right, turns it a quarter right, cuts a quarter off its
 * left, a tenth off its top and a fifth off its bottom, and shows it half see-through. */
const fullLook: ReferenceCanvasTransform = { x: 0.5, y: 0.4, scale: 0.5, scaleX: 1, scaleY: 1, rotation: 90, flipX: true,
  crop: { top: 0.1, right: 0, bottom: 0.2, left: 0.25 }, opacity: 0.5 };
const FILTER = '联动台·画面调节';
/** Filters are only ever on the decoders of our material scenes, never on a scene or a source of the user's. */
const ownDecoder = (name: string): boolean => /^团播联动台·素材·.*·来源(·预备)?$/u.test(name);
const filterRequests = (obs: FakeObs): string[] => obs.requests.filter(type => /Filter/u.test(type) && type !== 'GetSourceFilterList');
const countOf = (list: readonly string[]): Map<string, number> => list.reduce((counts, type) => counts.set(type, (counts.get(type) ?? 0) + 1), new Map<string, number>());

it('E17 规则：镜像、转 90°、裁剪和位置大小一起写在素材的场景项上；不透明度是这个解码器自己来源上的一个联动台滤镜，上画面之前就设好', async () => {
  const project = withLooks(song([[0, 12000, 100], [12, 12000, 12100]]), { 'clip-0': fullLook }), obs = fakeObs(), store = new MemoryMaterialOwnLooks();
  const primary = primaryOf(project), standby = `${primary}·预备`;
  const t = await live(project, obs, undefined, true, 'test', store);
  expect(obs.decoder(primary).look).toMatchObject({ scaleX: -0.5, scaleY: 0.5, rotation: 90, cropTop: 108, cropRight: 0, cropBottom: 216, cropLeft: 480, positionX: 540, positionY: 768 });
  expect(obs.filters.get(primary)).toEqual([{ filterName: FILTER, filterKind: 'color_filter_v2', filterEnabled: true, filterSettings: { opacity: 0.5 } }]);
  // The other clip has none of it: its decoder gets no filter.
  expect(obs.filters.get(standby) ?? []).toEqual([]);
  expect([...obs.filters.keys()].every(ownDecoder)).toBe(true);
  expect(obs.filterWrites.every(write => !write.onAir && ownDecoder(write.sourceName) && write.filterName === FILTER)).toBe(true);
  // Nothing about the filter is kept on this machine: the file is E16's.
  expect(Object.keys(store)).not.toContain('filters');
  await t.play(0, 13000, true);
  expect(t.failures()).toEqual([]);
  // On air at once at half opacity, then the other decoder fully opaque: no frame of either at the other's opacity.
  const shown = obs.seenLooks.filter(view => view.input !== null);
  expect(shown.map(view => [view.input, view.opacity ?? 1])).toEqual([[primary, 0.5], [standby, 1]]);
  await t.session.stop();
});

it('E17 规则：一段带全四样的片段，准备时比只有位置大小的多一个 CreateSourceFilter；下一次连接读到滤镜开着，只改不透明度那一条', async () => {
  const base = song([[0, 12000, 100]]);
  const run = async (look: ReferenceCanvasTransform, obs = fakeObs(), store = new MemoryMaterialOwnLooks()) => {
    const before = obs.requests.length;
    await (await live(withLooks(base, { 'clip-0': look }), obs, undefined, true, 'test', store)).session.stop();
    return obs.requests.slice(before);
  };
  const placed = countOf(await run({ x: 0.5, y: 0.4, scale: 0.5, scaleX: 1, scaleY: 1, rotation: 90 })), full = countOf(await run(fullLook));
  expect([...full].filter(([type, count]) => count !== (placed.get(type) ?? 0))).toEqual([['CreateSourceFilter', 1]]);
  expect([...placed].filter(([type, count]) => count !== (full.get(type) ?? 0))).toEqual([]);
  // The filter is there, on, from the run before: only its opacity is written.
  const obs = fakeObs(), store = new MemoryMaterialOwnLooks();
  await run(fullLook, obs, store);
  const again = await run({ ...fullLook, opacity: 0.25 }, obs, store);
  expect(again.filter(type => /Filter/u.test(type) && type !== 'GetSourceFilterList')).toEqual(['SetSourceFilterSettings']);
  expect(obs.filters.get(primaryOf(base))).toEqual([{ filterName: FILTER, filterKind: 'color_filter_v2', filterEnabled: true, filterSettings: { opacity: 0.25 } }]);
});

it('E17 规则：片段没有这几样，联动台不写一个滤镜请求；每个解码器每次连接最多读一次滤镜列表', async () => {
  for (const project of [song([[0, 12000, 100], [12, 12000, 12100], [24, 12000, 24100]]), withLooks(song([[0, 12000, 100], [12, 12000, 12100], [24, 12000, 24100]]), { 'clip-0': leftLook, 'clip-1': rightLook })]) {
    const obs = fakeObs(), store = new MemoryMaterialOwnLooks();
    const scenes = new ObsMediaScenes(obs.client, obs.request, operation => operation(), store);
    // The material scene is there from before, so this connection reads what its decoders have.
    await scenes.prepare(project.projectId, project.mediaAssets[0]!, path);
    await scenes.prepareStandby(primaryOf(project));
    obs.filterReads.length = 0;
    const t = await live(project, obs, undefined, true, 'test', store);
    await t.play(0, 25000, true);
    expect(t.failures()).toEqual([]);
    expect(filterRequests(obs)).toEqual([]);
    expect([...countOf(obs.filterReads)].filter(([, count]) => count > 1)).toEqual([]);
    expect(obs.filterReads.length).toBeGreaterThan(0);
    await t.session.stop();
  }
});

it('E17 规则：不透明度不用了就把滤镜关掉，不删；同一素材下一段没设时在它上画面之前关好', async () => {
  const project = withLooks(song([[0, 12000, 100], [12, 12000, 12100], [24, 12000, 24100]]), { 'clip-0': { ...leftLook, opacity: 0.3 } }), obs = fakeObs();
  const primary = primaryOf(project);
  const t = await live(project, obs);
  await t.play(0, 25000, true);
  expect(t.failures()).toEqual([]);
  expect(obs.filters.get(primary)).toEqual([{ filterName: FILTER, filterKind: 'color_filter_v2', filterEnabled: false, filterSettings: { opacity: 0.3 } }]);
  expect(obs.filterWrites.map(write => [write.type, write.onAir])).toEqual([['CreateSourceFilter', false], ['SetSourceFilterEnabled', false]]);
  const shown = obs.seenLooks.filter(view => view.input !== null);
  expect(shown.map(view => [view.input === primary ? '主' : '预备', view.opacity ?? 1])).toEqual([['主', 0.3], ['预备', 1], ['主', 1]]);
  await t.session.stop();
});

it('E17 规则：复制到预备解码器时只复制操作员自己的滤镜；两边的联动台滤镜都不碰（不复制、不当成过期删掉）', async () => {
  const project = song([[0, 12000, 100]]), obs = fakeObs(), store = new MemoryMaterialOwnLooks();
  const scenes = new ObsMediaScenes(obs.client, obs.request, operation => operation(), store);
  await scenes.prepare(project.projectId, project.mediaAssets[0]!, path);
  const { sourceName: primary } = materialSceneNames(project.projectId, project.mediaAssets[0]!), standby = `${primary}·预备`;
  await obs.client.call('CreateSourceFilter', { sourceName: primary, filterName: FILTER, filterKind: 'color_filter_v2', filterSettings: { opacity: 0.5 } });
  await obs.client.call('CreateSourceFilter', { sourceName: primary, filterName: '模糊', filterKind: 'blur', filterSettings: { size: 3 } });
  await scenes.prepareStandby(primary);
  expect(obs.filters.get(standby)?.map(filter => filter.filterName)).toEqual(['模糊']);
  await obs.client.call('CreateSourceFilter', { sourceName: standby, filterName: FILTER, filterKind: 'color_filter_v2', filterSettings: { opacity: 0.8 } });
  await obs.client.call('RemoveSourceFilter', { sourceName: primary, filterName: '模糊' });
  await scenes.copyPresentation(primary, standby);
  expect(obs.filters.get(standby)).toEqual([{ filterName: FILTER, filterKind: 'color_filter_v2', filterEnabled: true, filterSettings: { opacity: 0.8 } }]);
  expect(obs.filters.get(primary)?.map(filter => filter.filterName)).toEqual([FILTER]);
});

it('E17 规则：OBS 不认这种滤镜：片段照常显示（镜像、裁剪照样有），开始那一步标红写明不透明度没设好，这一段不再发第二次', async () => {
  const project = withLooks(song([[0, 12000, 100]]), { 'clip-0': fullLook }), obs = fakeObs(), store = new MemoryMaterialOwnLooks();
  obs.unknownFilterKinds.add('color_filter_v2');
  const primary = primaryOf(project);
  const t = await live(project, obs, undefined, true, 'test', store);
  await t.play(0, 1000, true);
  expect(obs.view().decoder).toBe('主');
  expect(obs.decoder(primary).look).toMatchObject({ scaleX: -0.5, cropLeft: 480 });
  expect(t.reports).toContain(`clip-0 start failed：${opacityFailure({ assetName: '视频' }, { kind: 'set', reason: 'CreateSourceFilter：没有这种滤镜：color_filter_v2' })}`);
  expect(obs.requests.filter(type => type === 'CreateSourceFilter')).toHaveLength(1);
  await t.session.stop();
});

/** A material scene prepared on an earlier connection, with what the operator then did to its primary decoder's filters. */
async function earlier(project: LinkProject, obs: FakeObs, change: (primary: string) => Promise<unknown>): Promise<string> {
  await new ObsMediaScenes(obs.client, obs.request, operation => operation()).prepare(project.projectId, project.mediaAssets[0]!, path);
  const primary = primaryOf(project);
  await change(primary);
  return primary;
}

it('E17 规则：联动台的滤镜被人在 OBS 里删了：下次连接读到没有，照常重建，不标红；这次连接里写失败只红一次，下一段读一次再按读到的建', async () => {
  const project = withLooks(song([[0, 12000, 100]]), { 'clip-0': { ...leftLook, opacity: 0.4 } }), obs = fakeObs();
  const primary = await earlier(project, obs, name => obs.client.call('CreateSourceFilter', { sourceName: name, filterName: FILTER, filterKind: 'color_filter_v2', filterSettings: { opacity: 0.4 } }));
  await obs.client.call('RemoveSourceFilter', { sourceName: primary, filterName: FILTER });
  const t = await live(project, obs);
  await t.play(0, 1000, true);
  expect(t.failures()).toEqual([]);
  expect(obs.filters.get(primary)).toEqual([{ filterName: FILTER, filterKind: 'color_filter_v2', filterEnabled: true, filterSettings: { opacity: 0.4 } }]);
  expect(obs.seenLooks.filter(view => view.input !== null).map(view => view.opacity)).toEqual([0.4]);
  await t.session.stop();
  // Deleted again while this connection still thinks it is there: the next write fails once, the decoder is then in
  // doubt and read once before the next look, which makes it again.
  const scenes = new ObsMediaScenes(obs.client, obs.request, operation => operation());
  await scenes.prepare(project.projectId, project.mediaAssets[0]!, path);
  await obs.client.call('RemoveSourceFilter', { sourceName: primary, filterName: FILTER });
  const event = new SceneOutputTimeline(withLooks(project, { 'clip-0': { ...leftLook, opacity: 0.7 } }), 'song').at(0).media[0]!;
  await expect(scenes.execute(event, 'C:/shows/assets/video.mp4')).rejects.toThrow('不透明度没有按工程设好');
  expect(obs.decoder(primary).enabled).toBe(true);
  await scenes.execute({ ...event, phase: 'stop' }, 'C:/shows/assets/video.mp4');
  const reads = obs.filterReads.length;
  await scenes.execute(event, 'C:/shows/assets/video.mp4');
  expect(obs.filterReads.length - reads).toBe(1);
  expect(obs.filters.get(primary)).toEqual([{ filterName: FILTER, filterKind: 'color_filter_v2', filterEnabled: true, filterSettings: { opacity: 0.7 } }]);
});

it('E17 规则：第一次准备就读到联动台的滤镜开着（别的电脑或备份带来的），没设不透明度的片段上画面之前关掉一次，之后不再发', async () => {
  const project = song([[0, 12000, 100], [12, 12000, 12100], [24, 12000, 24100]]), obs = fakeObs();
  const primary = await earlier(project, obs, name => obs.client.call('CreateSourceFilter', { sourceName: name, filterName: FILTER, filterKind: 'color_filter_v2', filterSettings: { opacity: 0.4 } }));
  const setup = obs.filterWrites.length, t = await live(project, obs);
  await t.play(0, 25000, true);
  expect(t.failures()).toEqual([]);
  expect(obs.filterWrites.slice(setup).map(write => [write.type, write.sourceName === primary, write.onAir])).toEqual([['SetSourceFilterEnabled', true, false]]);
  expect(obs.filters.get(primary)).toEqual([{ filterName: FILTER, filterKind: 'color_filter_v2', filterEnabled: false, filterSettings: { opacity: 0.4 } }]);
  expect(obs.seenLooks.filter(view => view.input !== null).every(view => (view.opacity ?? 1) === 1)).toBe(true);
  await t.session.stop();
});

it('E17 规则：素材来源上有一个同名、不是联动台建的滤镜：从不改、不删；要不透明度的片段照常显示并标红写明，不要的什么都不说', async () => {
  const opaque = withLooks(song([[0, 12000, 100]]), { 'clip-0': { ...leftLook, opacity: 0.5 } }), obs = fakeObs();
  const primary = await earlier(opaque, obs, name => obs.client.call('CreateSourceFilter', { sourceName: name, filterName: FILTER, filterKind: 'blur', filterSettings: { size: 2 } }));
  const theirs = [{ filterName: FILTER, filterKind: 'blur', filterEnabled: true, filterSettings: { size: 2 } }];
  const setup = obs.filterWrites.length, t = await live(opaque, obs);
  await t.play(0, 1000, true);
  expect(obs.view().decoder).toBe('主');
  expect(t.reports).toContain(`clip-0 start failed：${opacityFailure({ assetName: '视频' }, { kind: 'foreign' })}`);
  expect(opacityFailure({ assetName: '视频' }, { kind: 'foreign' })).toBe('素材“视频”照常在播，但不透明度没有设置：素材来源上已经有一个叫“联动台·画面调节”的滤镜，不是联动台建的。请在 OBS 里把它改名或删掉');
  await t.session.stop();
  const plain = await live(song([[0, 12000, 100]]), obs);
  await plain.play(0, 1000, true);
  expect(plain.failures()).toEqual([]);
  expect(obs.filterWrites.slice(setup)).toEqual([]);
  expect(obs.filters.get(primary)).toEqual(theirs);
  await plain.session.stop();
});

it('E17 规则：关滤镜失败以后不知道它现在怎样：标红一次；下一段没设不透明度的，读一次，再按读到的关掉', async () => {
  const project = withLooks(song([[0, 6000, 100], [6, 6000, 6100], [12, 6000, 12100], [18, 6000, 18100], [24, 6000, 24100]]), { 'clip-0': { ...leftLook, opacity: 0.3 } }), obs = fakeObs();
  const primary = primaryOf(project);
  let failedAt = -1;
  obs.failOnce((type, data) => {
    const hit = type === 'SetSourceFilterEnabled' && data.filterEnabled === false;
    if (hit) failedAt = obs.filterReads.length;
    return hit;
  });
  const t = await live(project, obs);
  await t.play(0, 31000, true);
  expect(t.failures().filter(text => text.includes('不透明度'))).toHaveLength(1);
  expect(t.reports).toContainEqual(expect.stringMatching(/^clip-2 start failed：素材“视频”照常在播，但不透明度没有按工程设好/u));
  // The decoder in doubt is read again before its next look: here by the copy to the standby decoder, which reads both
  // lists anyway, so no read of its own is added. Then the switch-off it needs.
  expect(failedAt).toBeGreaterThanOrEqual(0);
  expect(obs.filterReads.slice(failedAt)).toEqual([]);
  expect(obs.filterLists.slice(failedAt)).toContain(primary);
  expect(obs.filterWrites.map(write => write.type)).toEqual(['CreateSourceFilter', 'SetSourceFilterEnabled']);
  expect(obs.filters.get(primary)?.[0]).toMatchObject({ filterEnabled: false });
  await t.session.stop();
});

it('E17 规则：关滤镜失败、又没有别的读到它：下一段没设不透明度的片段先上画面，再读一次，按读到的关掉；不再标红', async () => {
  const logo = withLogo(song([[0, 4000, 100]]), [0, 4000]), asset = logo.mediaAssets.find(entry => entry.kind === 'image')!, obs = fakeObs();
  const event = new SceneOutputTimeline(logo, 'song').at(0).media.find(entry => entry.clipId === 'logo-clip')!;
  await new ObsMediaScenes(obs.client, obs.request, operation => operation()).prepare(logo.projectId, asset, 'C:/shows/assets/logo.png');
  await obs.client.call('CreateSourceFilter', { sourceName: event.sourceName, filterName: FILTER, filterKind: 'color_filter_v2', filterSettings: { opacity: 0.4 } });
  const scenes = new ObsMediaScenes(obs.client, obs.request, operation => operation());
  await scenes.prepare(logo.projectId, asset, 'C:/shows/assets/logo.png');
  obs.failOnce((type, data) => type === 'SetSourceFilterEnabled' && data.filterEnabled === false);
  await expect(scenes.execute(event, 'C:/shows/assets/logo.png')).rejects.toThrow('不透明度没有按工程设好');
  expect(obs.decoder(event.sourceName).enabled).toBe(true);
  await scenes.execute({ ...event, phase: 'stop' }, 'C:/shows/assets/logo.png');
  const reads = obs.filterReads.length, before = obs.requests.length;
  await expect(scenes.execute(event, 'C:/shows/assets/logo.png')).resolves.toBeUndefined();
  expect(obs.filterReads.length - reads).toBe(1);
  expect(obs.requests.slice(before).filter(type => type === 'GetSourceFilterList' || type === 'SetSceneItemEnabled' || type === 'SetSourceFilterEnabled'))
    .toEqual(['SetSceneItemEnabled', 'GetSourceFilterList', 'SetSourceFilterEnabled']);
  expect(obs.filters.get(event.sourceName)?.[0]).toMatchObject({ filterEnabled: false });
});

it('E17 规则：重新连上 OBS 就忘了读到的滤镜，再准备时重新读；没读到的、晚到的没设不透明度的片段先上画面再读，要不透明度的先读', async () => {
  const project = song([[0, 12000, 100]]), obs = fakeObs();
  const primary = await earlier(project, obs, () => Promise.resolve());
  const scenes = new ObsMediaScenes(obs.client, obs.request, operation => operation());
  const readsOf = (): number => obs.filterReads.filter(name => name === primary).length;
  await scenes.prepare(project.projectId, project.mediaAssets[0]!, path);
  await scenes.prepare(project.projectId, project.mediaAssets[0]!, path);
  expect(readsOf()).toBe(1);
  scenes.clear();
  await scenes.prepare(project.projectId, project.mediaAssets[0]!, path);
  expect(readsOf()).toBe(2);
  // An image shown late, its decoder not read (the read at its preparation failed), with our filter on.
  const logo = withLogo(song([[0, 4000, 100]]), [0, 4000]), asset = logo.mediaAssets.find(entry => entry.kind === 'image')!;
  const event = new SceneOutputTimeline(logo, 'song').at(0).media.find(entry => entry.clipId === 'logo-clip')!;
  await new ObsMediaScenes(obs.client, obs.request, operation => operation()).prepare(logo.projectId, asset, 'C:/shows/assets/logo.png');
  await obs.client.call('CreateSourceFilter', { sourceName: event.sourceName, filterName: FILTER, filterKind: 'color_filter_v2', filterSettings: { opacity: 0.4 } });
  const late = async (shown: ManagedMediaEvent): Promise<string[]> => {
    const fresh = new ObsMediaScenes(obs.client, obs.request, operation => operation());
    obs.failOnce(type => type === 'GetSourceFilterList');
    await fresh.prepare(logo.projectId, asset, 'C:/shows/assets/logo.png');
    const before = obs.requests.length;
    await fresh.execute(shown, 'C:/shows/assets/logo.png');
    await fresh.execute({ ...shown, phase: 'stop' }, 'C:/shows/assets/logo.png');
    return obs.requests.slice(before).filter(type => type === 'GetSourceFilterList' || type === 'SetSceneItemEnabled' || /^(Create|Set)SourceFilter/u.test(type));
  };
  expect(await late(event)).toEqual(['SetSceneItemEnabled', 'GetSourceFilterList', 'SetSourceFilterEnabled', 'SetSceneItemEnabled']);
  expect(obs.filters.get(event.sourceName)?.[0]).toMatchObject({ filterEnabled: false });
  const seeThrough = new SceneOutputTimeline(withLooks(logo, { 'logo-clip': { ...leftLook, opacity: 0.6 } }), 'song').at(0).media.find(entry => entry.clipId === 'logo-clip')!;
  expect(await late(seeThrough)).toEqual(['GetSourceFilterList', 'SetSourceFilterSettings', 'SetSourceFilterEnabled', 'SetSceneItemEnabled', 'SetSceneItemEnabled']);
});

it('E17 规则：读不到滤镜：片段照常显示；要不透明度的标红写明，没设的、只是还没读过的不标红', async () => {
  const logo = withLogo(song([[0, 4000, 100]]), [0, 4000]), asset = logo.mediaAssets.find(entry => entry.kind === 'image')!, obs = fakeObs();
  const event = new SceneOutputTimeline(withLooks(logo, { 'logo-clip': { ...leftLook, opacity: 0.6 } }), 'song').at(0).media.find(entry => entry.clipId === 'logo-clip')!;
  const scenes = new ObsMediaScenes(obs.client, obs.request, operation => operation());
  await scenes.prepare(logo.projectId, asset, 'C:/shows/assets/logo.png');
  scenes.clear();
  obs.failOnce(type => type === 'GetSourceFilterList'); obs.failOnce(type => type === 'GetSourceFilterList');
  await scenes.prepare(logo.projectId, asset, 'C:/shows/assets/logo.png');
  await expect(scenes.execute(event, 'C:/shows/assets/logo.png')).rejects.toThrow(opacityFailure({ assetName: '台标' }, { kind: 'read', reason: 'OBS 没能执行 GetSourceFilterList' }));
  expect(obs.decoder(event.sourceName).enabled).toBe(true);
  await scenes.execute({ ...event, phase: 'stop' }, 'C:/shows/assets/logo.png');
  const plain = { ...event }; delete plain.transform;
  await expect(scenes.execute(plain, 'C:/shows/assets/logo.png')).resolves.toBeUndefined();
  expect(filterRequests(obs)).toEqual([]);
});

it('E17 规则：素材原来在 OBS 里裁过：本机记下的原样带着裁剪，「用 OBS 里的样子」把裁剪、镜像和不透明度都换回去；只摆位置的片段也留着原来的裁剪', async () => {
  const placed = withLooks(song([[0, 12000, 100], [12, 12000, 12100]]), { 'clip-0': fullLook, 'clip-1': leftLook }), obs = fakeObs(), store = new MemoryMaterialOwnLooks();
  const primary = primaryOf(placed), standby = `${primary}·预备`;
  const scenes = new ObsMediaScenes(obs.client, obs.request, operation => operation(), store);
  await scenes.prepare(placed.projectId, placed.mediaAssets[0]!, path);
  // Cropped by hand in OBS before the console ever placed it.
  await obs.client.call('SetSceneItemTransform', { sceneName: obs.decoder(primary).scene, sceneItemId: obs.decoder(primary).item, sceneItemTransform: { cropLeft: 30, cropTop: 12 } });
  const first = await live(placed, obs, undefined, true, 'test', store);
  expect(store.looks.get(primary)).toMatchObject({ cropLeft: 30, cropTop: 12 });
  expect(obs.decoder(primary).look).toMatchObject({ cropLeft: 480, cropTop: 108, scaleX: -0.5 });
  expect(obs.decoder(standby).look).toMatchObject({ ...inObs(leftLook), cropLeft: 30, cropTop: 12 });
  await first.play(0, 1000, true); await first.session.release();
  // The primary decoder holds the console's crop now; a clip that only moves it gets the material's own crop back.
  const moved = await live(withLooks(placed, { 'clip-0': leftLook, 'clip-1': leftLook }), obs, undefined, true, 'test', store);
  expect(obs.decoder(primary).look).toMatchObject({ ...inObs(leftLook), cropLeft: 30, cropTop: 12 });
  await moved.session.release();
  const second = await live(obsOwnLooks(placed), obs, undefined, true, 'test', store);
  expect(obs.decoder(primary).look).toMatchObject({ ...store.looks.get(primary), cropLeft: 30, cropTop: 12 });
  expect(obs.filters.get(primary)?.[0]).toMatchObject({ filterName: FILTER, filterEnabled: false });
  await second.play(0, 1000, true);
  expect(obs.seenLooks.at(-1)).not.toHaveProperty('opacity');
  await second.session.stop();
});

it('E17 规则：准备时读不到滤镜、片段又没设不透明度：不标红，也不多写；上画面以后读到了就照读到的办', async () => {
  const project = song([[0, 12000, 100]]), obs = fakeObs();
  const primary = await earlier(project, obs, () => Promise.resolve());
  const read = (type: string, data: Record<string, unknown>): boolean => type === 'GetSourceFilterList' && data.sourceName === primary;
  obs.failOnce(read); obs.failOnce(read);
  const t = await live(project, obs);
  await t.play(0, 1000, true);
  expect(t.failures()).toEqual([]);
  expect(filterRequests(obs)).toEqual([]);
  await t.session.stop();
});

it('E17 规则：建滤镜失败的解码器，复制到预备解码器时顺带读到了它现在怎样，之后不再为它单独读', async () => {
  const project = withLooks(song([[0, 12000, 100], [12, 12000, 12100], [24, 12000, 24100]]), { 'clip-0': { ...leftLook, opacity: 0.3 } }), obs = fakeObs();
  const primary = primaryOf(project);
  obs.failOnce(type => type === 'CreateSourceFilter');
  const t = await live(project, obs);
  await t.play(0, 25000, true);
  expect(t.failures().filter(text => text.includes('不透明度'))).toHaveLength(1);
  expect(obs.filterReads.filter(name => name === primary)).toEqual([]);
  expect(obs.filters.get(primary) ?? []).toEqual([]);
  await t.session.stop();
});

it('E17 规则：复制到预备解码器读到的两个滤镜列表就是这两个解码器的状态：准备时没读到的主解码器，复制以后再准备也不再读', async () => {
  const project = song([[0, 12000, 100]]), obs = fakeObs();
  const primary = await earlier(project, obs, () => Promise.resolve());
  const scenes = new ObsMediaScenes(obs.client, obs.request, operation => operation());
  obs.failOnce((type, data) => type === 'GetSourceFilterList' && data.sourceName === primary);
  await scenes.prepare(project.projectId, project.mediaAssets[0]!, path);
  await scenes.prepareStandby(primary);
  const reads = obs.filterReads.length;
  await scenes.prepare(project.projectId, project.mediaAssets[0]!, path);
  expect(obs.filterReads.length).toBe(reads);
});

it('E17 规则：这次运行不信任本机记录的素材，联动台的滤镜也不碰；裁剪时不知道素材多大，片段照常显示、标红写明', async () => {
  const project = withLooks(song([[0, 12000, 100]]), { 'clip-0': fullLook }), obs = fakeObs();
  const t = await live(project, obs, undefined, true, 'test', new BrokenOwnLooks(new Set(['drop'])));
  await t.play(0, 1000, true);
  expect(filterRequests(obs)).toEqual([]);
  expect(obs.view().decoder).toBe('主');
  await t.session.stop();
  const logo = withLooks(withLogo(song([[0, 4000, 100]]), [0, 4000]), { 'logo-clip': { ...leftLook, crop: { top: 0.5, right: 0, bottom: 0, left: 0 }, opacity: 0.5 } });
  const other = fakeObs(), shown = await live(logo, other);
  const event = new SceneOutputTimeline(logo, 'song').at(0).media.find(entry => entry.clipId === 'logo-clip')!;
  expect(event.sourceSize).toEqual({ width: 512, height: 512 });
  const unknown = { ...event }; delete unknown.sourceSize;
  await expect(shown.scenes.execute(unknown, 'C:/shows/assets/logo.png')).rejects.toThrow(lookFailure({ assetName: '台标' }, '不知道素材原来有多大，没法裁剪'));
  expect(other.decoder(event.sourceName).enabled).toBe(true);
  expect(filterRequests(other)).toEqual([]);
});
