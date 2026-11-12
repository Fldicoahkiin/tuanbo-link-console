import type { OBSWebSocket } from 'obs-websocket-js';
import { expect, it } from 'vitest';
import { clockFromNativeStatus, createObsProgramSnapshot, materialSceneNames, obsMaterialPresentation, projectFromObsSnapshot, SceneOutputTimeline, type LinkDesktopApi } from '@tb/core/link';
import { createEmptyLinkProject, parseLinkProject, type LinkAction, type LinkProject, type NativeObsPrepare, type NativePlayerStatus, type ReferenceCanvasTransform } from '@tb/schema';
import { MemoryMaterialOwnLooks } from './obs-material-own-looks';
import { NativeObsHost } from './native-obs-host';
import { pictureExecutor, pictureHold, pictureMediaStep } from './native-obs-outputs';
import { ObsMediaPreload } from './obs-media-preload';
import { ObsMediaScenes } from './obs-media-scenes';
import { ObsRequestScheduler } from './obs-request-scheduler';

/** R14 (2026-11-12): after a stop the picture stays on its last frame until the next song's picture is on. These run the
 * production chain of a song's picture (NativeObsHost, its picture session, the media step and executor of
 * native-obs-outputs.ts, pictureHold, ObsMediaPreload and one ObsMediaScenes shared by every song, as in the main
 * process) on an OBS that keeps each scene item's visibility, and check what the program scene shows after each request. */

type Batch = Array<{ requestType: string; requestData?: Record<string, unknown> }>;
type Input = { scene: string; kind: string; item: number; enabled: boolean; look: Record<string, unknown>; created: Record<string, unknown> | null; state: string; base: number; since: number; settings: Record<string, unknown> };

function fakeObs() {
  const inputs = new Map<string, Input>(), scenes = new Set<string>(), log: string[] = [];
  /** Each look written: which decoder, and whether it was shown then. */
  const looks: string[] = [];
  /** Requests OBS refuses. */
  const refuse = new Set<string>();
  /** After each request: whether the program scene shows any of its items. */
  const blank: string[] = [];
  let item = 1, program = '机位';
  const input = (name: unknown): Input => {
    const found = inputs.get(String(name));
    if (!found) throw new Error(`OBS 里没有这个来源：${String(name)}`);
    return found;
  };
  const byItem = (id: unknown): [string, Input] => {
    const found = [...inputs].find(([, entry]) => entry.item === id);
    if (!found) throw new Error(`OBS 里没有这个场景项：${String(id)}`);
    return found;
  };
  /** `主` and `预备`: the two decoders of 视频; another material's are named after it. */
  const short = (name: string): string => `${name.includes('另一个') ? '另一个·' : ''}${name.endsWith('·预备') ? '预备' : '主'}`;
  const cursor = (target: Input): number => target.state === 'OBS_MEDIA_STATE_PLAYING' ? target.base + performance.now() - target.since : target.base;
  const handle = (type: string, data: Record<string, unknown>): unknown => {
    if (refuse.has(type)) throw new Error(`OBS 拒绝了 ${type}`);
    switch (type) {
      case 'GetSceneList': return { scenes: [...scenes].map(sceneName => ({ sceneName })) };
      case 'CreateScene': scenes.add(String(data.sceneName)); return {};
      case 'CreateInput': {
        inputs.set(String(data.inputName), { scene: String(data.sceneName), kind: String(data.inputKind), item: item++, enabled: data.sceneItemEnabled === true, look: {}, created: null, state: 'OBS_MEDIA_STATE_STOPPED', base: 0, since: 0,
          settings: { ...data.inputSettings as Record<string, unknown> } });
        return { sceneItemId: item - 1 };
      }
      case 'GetSceneItemList': return { sceneItems: [...inputs].filter(([, entry]) => entry.scene === data.sceneName).map(([sourceName, entry]) => ({ sourceName, sceneItemId: entry.item })) };
      case 'GetInputSettings': { const target = input(data.inputName); return { inputKind: target.kind, inputSettings: target.settings }; }
      case 'SetInputSettings': Object.assign(input(data.inputName).settings, data.inputSettings); return {};
      case 'GetVideoSettings': return { baseWidth: 1080, baseHeight: 1920 };
      case 'GetSceneItemTransform': return { sceneItemTransform: { sourceWidth: 1080, sourceHeight: 1920, ...byItem(data.sceneItemId)[1].look } };
      case 'GetSourceFilterList': return { filters: [] };
      case 'GetSourceScreenshot': return { imageData: 'data:image/png;base64,x' };
      case 'SetSceneItemTransform': {
        const [name, target] = byItem(data.sceneItemId);
        Object.assign(target.look, data.sceneItemTransform as Record<string, unknown>); target.created ??= { ...target.look };
        looks.push(`${short(name)} ${target.enabled ? '在画面上' : '不在画面上'}`); return {};
      }
      case 'SetInputMute': return {};
      case 'SetCurrentProgramScene': program = String(data.sceneName); log.push(`节目 ${program === '机位' ? '机位' : '素材'}`); return {};
      case 'SetSceneItemEnabled': {
        const [name, target] = byItem(data.sceneItemId);
        if (target.enabled !== (data.sceneItemEnabled === true)) log.push(`${data.sceneItemEnabled === true ? '显示' : '隐藏'} ${short(name)}`);
        target.enabled = data.sceneItemEnabled === true; return {};
      }
      case 'GetMediaInputStatus': {
        const target = input(data.inputName);
        return { mediaState: target.state, mediaCursor: Math.round(cursor(target)), mediaDuration: 60000 };
      }
      case 'SetMediaInputCursor': { const target = input(data.inputName); target.base = Number(data.mediaCursor); target.since = performance.now(); return {}; }
      case 'TriggerMediaInputAction': {
        const name = String(data.inputName), target = input(name), action = String(data.mediaAction).replace('OBS_WEBSOCKET_MEDIA_INPUT_ACTION_', '');
        target.base = cursor(target); target.since = performance.now();
        target.state = action === 'PAUSE' ? 'OBS_MEDIA_STATE_PAUSED' : action === 'STOP' ? 'OBS_MEDIA_STATE_STOPPED' : 'OBS_MEDIA_STATE_PLAYING';
        if (action === 'STOP' || action === 'RESTART') target.base = 0;
        log.push(`${action} ${short(name)}`);
        return {};
      }
      default: throw new Error(`假 OBS 不认识 ${type}`);
    }
  };
  /** The program scene shows nothing: on the camera scene it always does (the user's cameras). */
  const check = (): void => {
    if (program !== '机位' && ![...inputs.values()].some(entry => entry.scene === program && entry.enabled && (entry.kind === 'image_source' || entry.state !== 'OBS_MEDIA_STATE_STOPPED'))) blank.push(log.at(-1) ?? '');
  };
  const client = {
    call: (type: string, data: Record<string, unknown> = {}) => {
      try { const result = handle(type, data); check(); return Promise.resolve(result); } catch (error) { return Promise.reject(error instanceof Error ? error : new Error(String(error))); }
    },
    callBatch: (batch: Batch) => {
      const results: Array<{ requestType: string; requestStatus: { result: boolean; code: number; comment?: string } }> = [];
      for (const entry of batch) {
        try { handle(entry.requestType, entry.requestData ?? {}); check(); results.push({ requestType: entry.requestType, requestStatus: { result: true, code: 100 } }); }
        catch (error) { results.push({ requestType: entry.requestType, requestStatus: { result: false, code: 500, comment: error instanceof Error ? error.message : String(error) } }); break; }
      }
      return Promise.resolve(results);
    }
  };
  return { client: client as unknown as OBSWebSocket, log, looks, refuse, blank, inputs, program: () => program, call: client.call,
    native: {
      prime: (name: string): Promise<void> => { const target = input(name); target.state = 'OBS_MEDIA_STATE_PAUSED'; target.base = 0; return Promise.resolve(); },
      seek: (name: string, positionMs: number): Promise<void> => { input(name).base = positionMs; return Promise.resolve(); }
    } };
}

/** Songs `a` and `b`, each a clip of `video` from its start for 3 s; `b` uses `other` instead when `shared` is false.
 * `music` has music only: no clip, no camera, no OBS cue. */
function show(shared = true, kind: 'video' | 'image' = 'video', looks: Partial<Record<'a' | 'b', ReferenceCanvasTransform>> = {}): LinkProject {
  const asset = (id: string, name: string) => ({ id, name, kind, relativePath: `assets/${id}.mp4`, sha256: id === 'video' ? 'a'.repeat(64) : 'b'.repeat(64), byteLength: 1, durationMs: 60000, width: 1920, height: 1080 });
  const lookOf = (id: string) => { const look = looks[id as 'a' | 'b']; return look ? { canvasTransform: look, obsTransform: 'project' as const } : {}; };
  return parseLinkProject({ ...createEmptyLinkProject('停在最后一帧'), playbackSource: 'internal', obsOutputMode: 'scenes', ...Object.keys(looks).length ? { schemaVersion: 3 } : {},
    mediaAssets: [asset('video', '视频'), asset('other', '另一个')],
    rundown: [...['a', 'b'].map(id => ({ id, title: id, visualLayers: [{ id: `layer-${id}`, name: '视频' }],
      referenceMediaClips: [{ id: `clip-${id}`, assetId: id === 'b' && !shared ? 'other' : 'video', layerId: `layer-${id}`, label: '视频', startTimecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, durationMs: 3000, ...lookOf(id) }],
      cues: [] })), { id: 'music', title: '只有音乐', cues: [] }] });
}

function setup(project = show(), ownLooks = new MemoryMaterialOwnLooks()) {
  const obs = fakeObs(), scheduler = new ObsRequestScheduler(500, () => undefined);
  scheduler.connect();
  const scenes = new ObsMediaScenes(obs.client, (operation, label) => scheduler.request(operation, label), operation => scheduler.run('program', operation), ownLooks);
  let connected = true;
  /** Songs whose picture preparation OBS refuses. */
  const refused = new Set<string>();
  /** Songs whose picture preparation waits for OBS until released. */
  const stalled = new Map<string, Promise<void>>();
  let audio: NativePlayerStatus = { version: 1, sessionId: '64f37673-7a65-4c81-b5b4-09c1b9f94cb3', generation: 1, itemId: 'a', status: 'ready',
    positionMs: 0, offsetMs: 480000, sampleRate: 48000, enginePid: 1, engineTitle: '测试', mtcPortName: null, mtcSent: 0,
    audioError: null, mtcError: null, underruns: 0, mtcInterruptions: 0, gain: 1, analysis: null };
  const failures: string[] = [];
  const recordLog = (entry: Parameters<LinkDesktopApi['recordLog']>[0]) => Promise.resolve({ ...entry, id: 'log', sessionId: 'test', timestamp: '2026-11-12T00:00:00Z', monotonicMs: 0 });
  let host: NativeObsHost | null = null;
  const pictures = (): NativeObsHost => { if (!host) throw new Error('画面宿主还没建好'); return host; };
  const held = { decoders: () => pictures().heldDecoders(), takeOver: (name: string, reuse: boolean) => pictures().takeOver(name, reuse) };
  host = new NativeObsHost({ audio: () => audio, changed: () => undefined, error: message => failures.push(message),
    outputs: async request => {
      const song = projectFromObsSnapshot(request.snapshot), itemId = request.snapshot.item.id, file = (relativePath: string): string => `C:/shows/${relativePath}`;
      const clip = song.rundown.find(item => item.id === itemId)!.referenceMediaClips[0];
      const asset = clip ? song.mediaAssets.find(entry => entry.id === clip.assetId)! : null;
      const preload = new ObsMediaPreload(song, itemId, scenes, obs.native, held);
      if (asset) { await scenes.prepare(song.projectId, asset, file(asset.relativePath)); preload.register(song.projectId, asset, file(asset.relativePath)); }
      if (asset?.kind === 'video') await preload.prime(new SceneOutputTimeline(song, itemId).at(0).media[0]!, () => undefined);
      const hold = pictureHold(preload, scenes, asset ? [{ sourceName: materialSceneNames(song.projectId, asset).sourceName, image: asset.kind === 'image' }] : [], held, []);
      const log = { record: recordLog, projectId: song.projectId, itemId };
      const executor = pictureExecutor({ id: 'obs', supports: () => true, setSourceEnabledInProgramScene: () => Promise.resolve(),
        execute: async (action: LinkAction) => {
          if (action.kind === 'obs.mediaAction') await obs.call('TriggerMediaInputAction', { inputName: action.inputName, mediaAction: `OBS_WEBSOCKET_MEDIA_INPUT_ACTION_${action.action.toUpperCase()}` });
          else if (action.kind === 'obs.setProgramScene') await obs.call('SetCurrentProgramScene', { sceneName: action.sceneName });
        } }, preload, log);
      return { executor, guardOutput: <T>(canSend: () => boolean, operation: () => Promise<T>, dispatched?: () => void) => scheduler.guarded(canSend, operation, dispatched),
        prepareOutputs: (current: () => void) => refused.has(itemId) ? Promise.reject(new Error('OBS 拒绝了画面准备')) : (stalled.get(itemId) ?? Promise.resolve()).then(current), now: () => performance.now(),
        seekMedia: async event => { await preload.seek(event, file(event.relativePath)); }, recordLog, connected: () => connected,
        holdOutputs: clips => hold.hold(clips), releaseOutputs: () => hold.release(), heldDecoders: () => hold.decoders(), handOver: (name, reuse) => hold.handOver(name, reuse),
        heldClipIds: () => new Set(hold.decoders().values()),
        executeManagedMediaEvent: pictureMediaStep({ guardPlaybackOperation: (canSend, operation, dispatched) => scheduler.guarded(canSend, operation, dispatched),
          getRequestDiagnostics: () => ({ stats: scheduler.getStats(), timings: [] }) }, preload, request.projectPath, file, log) };
    } });
  let generation = 0;
  /** The song from its start: its picture prepared, then the music plays and its clip goes on air. */
  const play = async (itemId: string): Promise<void> => {
    generation += 2;
    audio = { ...audio, itemId, generation, status: 'ready', positionMs: 0 };
    const request: NativeObsPrepare = { version: 1, sessionId: audio.sessionId, generation, preciseSeeking: false, projectPath: 'C:/shows/test.tblink', snapshot: createObsProgramSnapshot(project, itemId, 4) };
    await pictures().prepare(request);
    audio = { ...audio, status: 'playing', generation: generation + 1 };
    pictures().observe(clockFromNativeStatus(audio, (process.hrtime.bigint() / 100n).toString()));
  };
  /** The song prepared at a position, paused there (a seek while stopped or paused): its frame is on, the music is not. */
  const prepareAt = async (itemId: string, positionMs: number): Promise<void> => {
    generation += 2;
    audio = { ...audio, itemId, generation, status: 'ready', positionMs };
    await pictures().prepare({ version: 1, sessionId: audio.sessionId, generation, preciseSeeking: false, projectPath: 'C:/shows/test.tblink', snapshot: createObsProgramSnapshot(project, itemId, 4) });
  };
  /** The program gives the song's picture up before it was ready (the player's one second for a song with no picture
   * work, `optionalOutputReady`), as its own stop of that picture; the music then plays. */
  const giveUp = async (itemId: string): Promise<void> => {
    let open: () => void = () => undefined;
    stalled.set(itemId, new Promise<void>(resolve => { open = resolve; }));
    generation += 2;
    audio = { ...audio, itemId, generation, status: 'ready', positionMs: 0 };
    const preparing = pictures().prepare({ version: 1, sessionId: audio.sessionId, generation, preciseSeeking: false, projectPath: 'C:/shows/test.tblink', snapshot: createObsProgramSnapshot(project, itemId, 4) })
      .then(() => null, (error: unknown) => error);
    await until(() => pictures().status?.itemId === itemId);
    const stopping = pictures().stopOwned({ version: 1, sessionId: audio.sessionId, generation }).catch((error: unknown) => error);
    open(); await preparing; await stopping;
    audio = { ...audio, status: 'playing', generation: generation + 1 };
    pictures().observe(clockFromNativeStatus(audio, (process.hrtime.bigint() / 100n).toString()));
  };
  /** One more clock of the music as it is now (a late status of the song that was playing). */
  const clockAgain = (): void => { pictures().observe(clockFromNativeStatus(audio, (process.hrtime.bigint() / 100n).toString())); };
  return { host: pictures(), obs, failures, play, prepareAt, giveUp, clockAgain, scenes, held, refused, audio: () => audio, offline: (away: boolean): void => { connected = !away; } };
}
async function until(done: () => boolean): Promise<void> {
  for (let spent = 0; !done() && spent < 4000; spent += 10) await new Promise(resolve => setTimeout(resolve, 10));
}
const count = (log: readonly string[], line: string): number => log.filter(entry => entry === line).length;

it('停止：素材原地暂停、照常显示，节目场景不动；下一首用同一素材时从另一个解码器开播，开播以后才停掉上一首的那一帧，中间没有空画面', async () => {
  const test = setup();
  await test.play('a'); await until(() => test.obs.log.includes('PLAY 主'));
  test.obs.log.length = 0;
  await test.host.stop();
  // The stop: one pause of the decoder on air, nothing hidden, no scene switched.
  expect(test.obs.log).toEqual(['PAUSE 主']);
  expect(test.obs.program()).not.toBe('机位');
  test.obs.log.length = 0;
  await test.play('b'); await until(() => count(test.obs.log, 'STOP 主') > 0);
  // The next song opens on the standby decoder, shown on top, and only then the last frame of a goes.
  const shown = test.obs.log.indexOf('显示 预备'), played = test.obs.log.indexOf('PLAY 预备'), stopped = test.obs.log.indexOf('STOP 主'), hidden = test.obs.log.indexOf('隐藏 主');
  expect(shown).toBeGreaterThanOrEqual(0); expect(played).toBeGreaterThan(shown);
  expect(stopped).toBeGreaterThan(played); expect(hidden).toBeGreaterThan(played);
  expect(test.obs.blank).toEqual([]);
  expect(test.host.heldDecoders().size).toBe(0);
  expect(test.failures).toEqual([]);
  await test.host.close();
});

it('下一首用别的素材：它的画面上了以后才停掉上一首那一帧，中间没有空画面', async () => {
  const test = setup(show(false));
  await test.play('a'); await until(() => test.obs.log.includes('PLAY 主'));
  await test.host.stop();
  test.obs.log.length = 0;
  await test.play('b'); await until(() => count(test.obs.log, '隐藏 主') === 1);
  // b's own decoder is of another material: it plays first, then a's goes.
  expect(test.obs.log).toEqual(['节目 素材', 'PLAY 另一个·主', 'STOP 主', '隐藏 主']);
  expect(test.obs.blank).toEqual([]);
  expect(test.failures).toEqual([]);
  await test.host.close();
});

it('关闭节目：停止时留下的那一帧也清理掉，和以前停止时一样', async () => {
  const test = setup();
  await test.play('a'); await until(() => test.obs.log.includes('PLAY 主'));
  await test.host.stop();
  test.obs.log.length = 0;
  await test.host.close(test.audio().sessionId);
  expect(test.obs.log).toEqual(['STOP 主', '隐藏 主']);
  expect(test.host.heldDecoders().size).toBe(0);
  // Another program's close leaves nothing more to take off.
  await test.host.close();
  expect(test.obs.log).toEqual(['STOP 主', '隐藏 主']);
  expect(test.failures).toEqual([]);
});

it('停着的时候 OBS 断开又连上：那一帧不恢复，只清理掉，不再算在画面上；下一首照常开播', async () => {
  const test = setup();
  await test.play('a'); await until(() => test.obs.log.includes('PLAY 主'));
  await test.host.stop();
  test.offline(true); test.host.disconnect('网络断开');
  test.offline(false); test.obs.log.length = 0;
  await test.host.reconnected();
  await until(() => test.host.heldDecoders().size === 0);
  expect(test.obs.log).toEqual(['STOP 主', '隐藏 主']);
  test.obs.log.length = 0;
  await test.play('b'); await until(() => test.obs.log.includes('PLAY 主'));
  expect(test.host.status).toMatchObject({ state: 'running', itemId: 'b' });
  expect(test.failures).toEqual([]);
  await test.host.close();
});

it('同一首停了又重播、马上又停：第一次停下的那一帧在重播开播后撤下；下一首从空着的主解码器开播，开播以后才撤下第二次停下的那一帧', async () => {
  const test = setup();
  await test.play('a'); await until(() => test.obs.log.includes('PLAY 主'));
  await test.host.stop();
  await test.play('a'); await until(() => count(test.obs.log, '隐藏 主') === 1);
  expect(test.obs.log.indexOf('PLAY 预备')).toBeLessThan(test.obs.log.indexOf('隐藏 主'));
  await test.host.stop();
  test.obs.log.length = 0;
  await test.play('b'); await until(() => test.obs.log.includes('隐藏 预备'));
  expect(test.obs.log).toEqual(['显示 主', '节目 素材', 'PLAY 主', 'STOP 预备', '隐藏 预备']);
  expect(test.obs.blank).toEqual([]);
  expect(test.failures).toEqual([]);
  await test.host.close();
});

it('停着的时候从中间准备下一首（暂停着定位）：它那一帧显示了以后才撤下上一首那一帧，不等音乐开始', async () => {
  const test = setup();
  await test.play('a'); await until(() => test.obs.log.includes('PLAY 主'));
  await test.host.stop();
  test.obs.log.length = 0;
  await test.prepareAt('b', 1000); await until(() => test.obs.log.includes('隐藏 主'));
  expect(test.obs.log.indexOf('显示 预备')).toBeGreaterThanOrEqual(0);
  expect(test.obs.log.indexOf('显示 预备')).toBeLessThan(test.obs.log.indexOf('STOP 主'));
  expect(test.obs.blank).toEqual([]);
  expect(test.host.heldDecoders().size).toBe(0);
  expect(test.failures).toEqual([]);
  await test.host.close();
});

it('下一首的画面准备失败：上一首那一帧照旧撤下，和以前停止时一样，不留着别的歌的画面', async () => {
  const test = setup(show(false));
  await test.play('a'); await until(() => test.obs.log.includes('PLAY 主'));
  await test.host.stop();
  test.obs.log.length = 0; test.refused.add('b');
  await expect(test.play('b')).rejects.toThrow('OBS 拒绝了画面准备');
  await until(() => test.host.heldDecoders().size === 0);
  // a's last frame, and b's own decoder it had prepared.
  expect([...test.obs.log].sort()).toEqual(['STOP 主', '隐藏 主', 'STOP 另一个·主', '隐藏 另一个·主'].sort());
  await test.host.close();
});

it.each(['video', 'image'] as const)('选中的下一首提前准备了又取消（没播）：只交还它自己用的，上一首停着的那一帧不动（%s）', async kind => {
  const project = show(true, kind);
  const test = setup(project);
  await test.play('a'); await until(() => test.obs.log.includes(kind === 'video' ? 'PLAY 主' : '节目 素材'));
  await test.host.stop();
  const song = projectFromObsSnapshot(createObsProgramSnapshot(project, 'b', 4)), asset = song.mediaAssets[0]!, path = `C:/shows/${asset.relativePath}`;
  const preload = new ObsMediaPreload(song, 'b', test.scenes, test.obs.native, test.held);
  preload.register(song.projectId, asset, path);
  if (kind === 'video') await preload.prime(new SceneOutputTimeline(song, 'b').at(0).media[0]!, () => undefined);
  test.obs.log.length = 0;
  await pictureHold(preload, test.scenes, [{ sourceName: materialSceneNames(song.projectId, asset).sourceName, image: kind === 'image' }], test.held, []).release();
  expect(test.obs.log).toEqual(kind === 'video' ? ['STOP 预备'] : []);
  expect(test.host.heldDecoders().size).toBe(1);
  await test.host.close();
});

it('下一首接着用同一张图片：图片交给下一首、接着显示，不先隐藏；关闭节目时只隐藏一次', async () => {
  const test = setup(show(true, 'image'));
  await test.play('a'); await until(() => test.obs.log.includes('节目 素材'));
  await test.host.stop();
  test.obs.log.length = 0;
  await test.play('b'); await until(() => test.host.heldDecoders().size === 0);
  expect(test.obs.log).toEqual([]);
  expect(test.obs.blank).toEqual([]);
  await test.host.close();
  expect(test.obs.log).toEqual(['隐藏 主']);
  expect(test.failures).toEqual([]);
});

it('下一首只有音乐（没有素材、机位和 OBS 动作）：它的音乐一开始就撤下上一首那一帧，不留在这首歌上', async () => {
  const test = setup();
  await test.play('a'); await until(() => test.obs.log.includes('PLAY 主'));
  await test.host.stop();
  test.obs.log.length = 0;
  await test.play('music'); await until(() => test.obs.log.includes('隐藏 主'));
  expect(test.obs.log).toEqual(['STOP 主', '隐藏 主']);
  expect(test.host.status).toMatchObject({ state: 'running', itemId: 'music' });
  expect(test.host.heldDecoders().size).toBe(0);
  expect(test.failures).toEqual([]);
  await test.host.close();
});

it('下一首的画面一秒内没准备好、被播放器放弃：音乐照常开始时撤下上一首那一帧', async () => {
  const test = setup();
  await test.play('a'); await until(() => test.obs.log.includes('PLAY 主'));
  await test.host.stop();
  test.obs.log.length = 0;
  await test.giveUp('music'); await until(() => test.obs.log.includes('隐藏 主'));
  expect(test.obs.log).toEqual(['STOP 主', '隐藏 主']);
  expect(test.host.heldDecoders().size).toBe(0);
  await test.host.close();
});

it('停下以后还收到这首歌晚到的走带消息：它自己那一帧不撤', async () => {
  const test = setup();
  await test.play('a'); await until(() => test.obs.log.includes('PLAY 主'));
  await test.host.stop();
  test.obs.log.length = 0;
  test.clockAgain(); await new Promise(resolve => setTimeout(resolve, 50));
  expect(test.obs.log).toEqual([]);
  expect(test.host.heldDecoders().size).toBe(1);
  await test.host.close();
});

/* E16 and the held frame: each decoder of the pair is its own scene item and carries its own look, so the next song's
 * look goes on the decoder it opens on, never on the one holding the last frame. */
const left: ReferenceCanvasTransform = { x: 0.25, y: 0.3, scale: 0.5, scaleX: 1, scaleY: 1, rotation: 0 };
const right: ReferenceCanvasTransform = { x: 0.75, y: 0.7, scale: 0.8, scaleX: 1.2, scaleY: 1, rotation: 15 };

it.each([
  ['两首都有自己的样子', { a: left, b: right }],
  ['上一首有样子、下一首没设', { a: left }],
  ['上一首没设、下一首有样子', { b: right }]
] as const)('同一素材、下一首样子不同（%s）：停着的那一帧不跟着换位置大小；样子只写在不在画面上的解码器；本机记下的原样是联动台改它之前的', async (_case, looks) => {
  const ownLooks = new MemoryMaterialOwnLooks(), test = setup(show(true, 'video', looks), ownLooks);
  const primary = () => test.obs.inputs.get([...test.obs.inputs.keys()].find(name => !name.endsWith('·预备'))!)!;
  const original = () => ({ ...primary().look });
  await test.play('a'); await until(() => test.obs.log.includes('PLAY 主'));
  // How the material's scene item was created, before any look of the project went to it.
  const created = primary().created!;
  await test.host.stop();
  const heldLook = original();
  test.obs.looks.length = 0;
  await test.play('b'); await until(() => test.host.heldDecoders().size === 0);
  // While a's frame was held, nothing was written to its decoder, and no look went to a decoder on air.
  expect(test.obs.looks.length).toBeGreaterThan(0);
  expect(test.obs.looks.every(line => line.startsWith('预备 不在画面上'))).toBe(true);
  expect(original()).toEqual(heldLook);
  expect(test.obs.blank).toEqual([]);
  // The own look kept on this machine is the scene item as created: neither song's project look.
  expect(ownLooks.looks.size).toBe(1);
  // b plays on the other decoder with its own look, or with the material's own look when it has none.
  const standby = test.obs.inputs.get([...test.obs.inputs.keys()].find(name => name.endsWith('·预备'))!)!;
  const kept = [...ownLooks.looks.values()][0]!;
  expect(standby.look).toMatchObject('b' in looks ? obsMaterialPresentation(looks.b, { width: 1080, height: 1920 }).sceneItemTransform : kept);
  expect(Object.keys(kept).filter(key => key in created).length).toBeGreaterThan(0);
  for (const kept of ownLooks.looks.values()) expect(kept).toMatchObject(Object.fromEntries(Object.entries(created).filter(([key]) => key in kept)));
  expect(test.failures).toEqual([]);
  await test.host.close();
});

it('停下以后的状态：停着的那一帧不算在播、不算失败，这首歌的各项不因为停在最后一帧多出任何一项；停下那首歌的失败不带到下一首', async () => {
  const clean = setup();
  await clean.play('a'); await until(() => clean.obs.log.includes('PLAY 主'));
  await clean.host.stop();
  expect(clean.host.status).toMatchObject({ state: 'stopped', itemId: 'a', items: [] });
  expect(clean.host.status?.fault).toBeUndefined();
  await clean.host.close();
  // a's cut is refused by OBS: a's own red parts, listed while a plays.
  const test = setup(show(false));
  test.obs.refuse.add('SetCurrentProgramScene');
  const red = (item: { state: string }): boolean => item.state === 'failed' || item.state === 'uncertain';
  await test.play('a'); await until(() => (test.host.status?.items ?? []).some(red));
  test.obs.refuse.clear();
  const listed = test.host.status?.items;
  expect(listed?.some(red)).toBe(true);
  await test.host.stop();
  expect(test.host.status?.state).toBe('stopped');
  expect(test.host.status?.items).toEqual(listed);
  await test.play('b'); await until(() => test.host.heldDecoders().size === 0);
  expect(test.host.status).toMatchObject({ state: 'running', itemId: 'b', items: [] });
  expect(test.host.status?.fault).toBeUndefined();
  expect(test.failures.filter(line => line.includes('清理'))).toEqual([]);
  await test.host.close();
});
