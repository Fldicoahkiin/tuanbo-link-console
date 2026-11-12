import type { OBSWebSocket } from 'obs-websocket-js';
import { afterEach, expect, it, vi } from 'vitest';
import { clockFromNativeStatus, createObsProgramSnapshot, ManagedOutputRuntime, ObsProgramSession, projectFromObsSnapshot, SceneOutputTimeline, type LinkDesktopApi, type ManagedMediaOutcome } from '@tb/core/link';
import { createEmptyLinkProject, parseLinkProject, type NativeObsPrepare, type NativePlayerStatus } from '@tb/schema';
import { NativeObsHost } from './native-obs-host';
import { mediaStepOutcome, pictureMediaStep } from './native-obs-outputs';
import { ObsMediaPreload } from './obs-media-preload';
import { MediaOnAirError, MediaOutOfStepError, ObsMediaScenes } from './obs-media-scenes';
import { ObsRequestNotSent, ObsRequestScheduler, ObsRequestUnanswered } from './obs-request-scheduler';

/** Watches each clip event's step: the report the picture session's output() gets from
 * sendMedia, and what output() hands its ledger writes (settle; the originals still run). */
afterEach(() => { vi.restoreAllMocks(); });
let watched: { reports: { mock: { results: Array<{ value: unknown }> } }; settles: { mock: { calls: unknown[][] } } } | null = null;
function watchSteps(): void {
  watched = { reports: vi.spyOn(ManagedOutputRuntime.prototype, 'sendMedia'),
    settles: vi.spyOn(ObsProgramSession.prototype as unknown as { settle: (writes: unknown, outcome: unknown) => void }, 'settle') };
}

type Batch = Array<{ requestType: string; requestData?: Record<string, unknown> }>;
type Input = { scene: string; item: number; state: string; base: number; since: number };
/** OBS with each input's own state. `sent` lists every request as OBS received it. `mode`:
 * `hold` never answers the batch that switches the scene; `refuse` fails showing the clip;
 * `behind` reports a playing decoder 2 s behind where it plays. */
function fakeObs() {
  const inputs = new Map<string, Input>(), scenes = new Set<string>(), sent: string[] = [];
  let item = 1, mode: 'normal' | 'hold' | 'refuse' | 'behind' = 'normal';
  const input = (name: unknown): Input => {
    const found = inputs.get(String(name));
    if (!found) throw new Error(`OBS 里没有这个来源：${String(name)}`);
    return found;
  };
  const cursor = (target: Input): number => target.state === 'OBS_MEDIA_STATE_PLAYING' ? target.base + performance.now() - target.since : target.base;
  const handle = (type: string, data: Record<string, unknown>): unknown => {
    switch (type) {
      case 'GetSceneList': return { scenes: [...scenes].map(sceneName => ({ sceneName })) };
      case 'CreateScene': scenes.add(String(data.sceneName)); return {};
      case 'CreateInput': inputs.set(String(data.inputName), { scene: String(data.sceneName), item: item++, state: 'OBS_MEDIA_STATE_STOPPED', base: 0, since: 0 }); return { sceneItemId: item - 1 };
      case 'GetVideoSettings': return { baseWidth: 1080, baseHeight: 1920 };
      case 'GetSceneItemTransform': return { sceneItemTransform: { sourceWidth: 1080, sourceHeight: 1920 } };
      case 'GetSourceScreenshot': return { imageData: 'data:image/png;base64,x' };
      case 'SetSceneItemTransform': case 'SetInputMute': case 'SetCurrentProgramScene': return {};
      case 'SetSceneItemEnabled':
        if (mode === 'refuse' && data.sceneItemEnabled === true) throw new Error('OBS 没能显示这个来源');
        return {};
      case 'GetMediaInputStatus': {
        const target = input(data.inputName), playing = target.state === 'OBS_MEDIA_STATE_PLAYING';
        return { mediaState: target.state, mediaCursor: Math.round(cursor(target) - (mode === 'behind' && playing ? 2000 : 0)), mediaDuration: 60000 };
      }
      case 'TriggerMediaInputAction': {
        const target = input(data.inputName), action = String(data.mediaAction).replace('OBS_WEBSOCKET_MEDIA_INPUT_ACTION_', '');
        target.base = cursor(target); target.since = performance.now();
        target.state = action === 'PAUSE' ? 'OBS_MEDIA_STATE_PAUSED' : action === 'STOP' ? 'OBS_MEDIA_STATE_STOPPED' : 'OBS_MEDIA_STATE_PLAYING';
        if (action === 'STOP' || action === 'RESTART') target.base = 0;
        return {};
      }
      default: throw new Error(`假 OBS 不认识 ${type}`);
    }
  };
  const client = {
    call: (type: string, data: Record<string, unknown> = {}) => {
      sent.push(type);
      try { return Promise.resolve(handle(type, data)); } catch (error) { return Promise.reject(error instanceof Error ? error : new Error(String(error))); }
    },
    callBatch: (batch: Batch) => {
      sent.push(`[${batch.map(entry => entry.requestType === 'TriggerMediaInputAction' ? String(entry.requestData?.mediaAction).replace('OBS_WEBSOCKET_MEDIA_INPUT_ACTION_', '') : entry.requestType).join(' ')}]`);
      if (mode === 'hold' && batch.some(entry => entry.requestType === 'SetCurrentProgramScene')) return new Promise<never>(() => undefined);
      const results: Array<{ requestType: string; requestStatus: { result: boolean; code: number; comment?: string } }> = [];
      for (const entry of batch) {
        try { handle(entry.requestType, entry.requestData ?? {}); results.push({ requestType: entry.requestType, requestStatus: { result: true, code: 100 } }); }
        catch (error) { results.push({ requestType: entry.requestType, requestStatus: { result: false, code: 500, comment: error instanceof Error ? error.message : String(error) } }); break; }
      }
      return Promise.resolve(results);
    }
  };
  return { client: client as unknown as OBSWebSocket, sent, set: (next: typeof mode): void => { mode = next; },
    native: {
      prime: (name: string): Promise<void> => { const target = input(name); target.state = 'OBS_MEDIA_STATE_PAUSED'; target.base = 0; return Promise.resolve(); },
      seek: (name: string, positionMs: number): Promise<void> => { input(name).base = positionMs; return Promise.resolve(); }
    } };
}

/** One video clip from the song's start, 5 s into its file, played by the program on the fake OBS
 * through the production chain of a clip event: NativeObsHost, its picture session, the media step
 * of native-obs-outputs.ts, the decoders (ObsMediaPreload, ObsMediaScenes) and the request
 * scheduler. Prepared as the playback preparation does: the material's scene, then its first clip
 * primed. A material request waits for what `beforeRequest` returns before it goes to the scheduler. */
function setup() {
  const project = parseLinkProject({ ...createEmptyLinkProject('素材结果'), playbackSource: 'internal', obsOutputMode: 'scenes',
    mediaAssets: [{ id: 'video', name: '视频', kind: 'video', relativePath: 'assets/video.mp4', sha256: 'a'.repeat(64), byteLength: 1, durationMs: 60000, width: 1920, height: 1080 }],
    rundown: [{ id: 'song', title: '歌曲', visualLayers: [{ id: 'video-layer', name: '视频' }],
      referenceMediaClips: [{ id: 'clip', assetId: 'video', layerId: 'video-layer', label: '视频', startTimecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, durationMs: 3000, sourceOffsetMs: 5000 }],
      cues: [] }] });
  const obs = fakeObs(), scheduler = new ObsRequestScheduler(200, () => undefined);
  scheduler.connect();
  let audio: NativePlayerStatus = { version: 1, sessionId: '64f37673-7a65-4c81-b5b4-09c1b9f94cb3', generation: 1, itemId: 'song', status: 'ready',
    positionMs: 0, offsetMs: 480000, sampleRate: 48000, enginePid: 1, engineTitle: '测试', mtcPortName: null, mtcSent: 0,
    audioError: null, mtcError: null, underruns: 0, mtcInterruptions: 0, gain: 1, analysis: null };
  const request: NativeObsPrepare = { version: 1, sessionId: audio.sessionId, generation: 1, preciseSeeking: false, projectPath: 'C:/shows/test.tblink', snapshot: createObsProgramSnapshot(project, 'song', 4) };
  const failures: string[] = [], logs: string[] = [];
  const recordLog = (entry: Parameters<LinkDesktopApi['recordLog']>[0]) => {
    // How late a step went out depends on how busy the test machine is, not on what came back.
    if (!entry.message.startsWith('画面动作晚了')) logs.push(`${entry.level} ${entry.message}`);
    return Promise.resolve({ ...entry, id: 'log', sessionId: 'test', timestamp: '2026-11-11T00:00:00Z', monotonicMs: 0 });
  };
  let beforeRequest: ((label: string) => Promise<void> | null) | null = null;
  const host = new NativeObsHost({ audio: () => audio, changed: () => undefined, error: message => failures.push(message),
    outputs: async snapshot => {
      const song = projectFromObsSnapshot(snapshot.snapshot), file = (relativePath: string): string => `C:/shows/${relativePath}`;
      const scenes = new ObsMediaScenes(obs.client, (operation, label) => {
        const wait = beforeRequest?.(label) ?? null;
        return wait ? wait.then(() => scheduler.request(operation, label)) : scheduler.request(operation, label);
      }, operation => scheduler.run('program', operation));
      const preload = new ObsMediaPreload(song, 'song', scenes, obs.native), asset = song.mediaAssets[0]!;
      await scenes.prepare(song.projectId, asset, file(asset.relativePath)); preload.register(song.projectId, asset, file(asset.relativePath));
      await preload.prime(new SceneOutputTimeline(song, 'song').at(0).media[0]!, () => undefined);
      obs.sent.length = 0;
      return { executor: { id: 'obs', supports: () => true, execute: () => Promise.resolve() },
        guardOutput: <T>(canSend: () => boolean, operation: () => Promise<T>, dispatched?: () => void) => scheduler.guarded(canSend, operation, dispatched),
        prepareOutputs: () => Promise.resolve(), releaseOutputs: () => Promise.resolve(), now: () => performance.now(),
        seekMedia: () => Promise.resolve(), recordLog,
        executeManagedMediaEvent: pictureMediaStep({ guardPlaybackOperation: (canSend, operation, dispatched) => scheduler.guarded(canSend, operation, dispatched),
          getRequestDiagnostics: () => ({ stats: scheduler.getStats(), timings: [] }) }, preload, snapshot.projectPath, file,
        { record: entry => { logs.push(`${entry.level} ${entry.message}`); return Promise.resolve({ ...entry, id: 'log', sessionId: 'test', timestamp: '2026-11-11T00:00:00Z', monotonicMs: 0 }); },
          projectId: song.projectId, itemId: 'song' }) };
    } });
  /** The music plays from the start: the clip's start goes out. */
  const play = async (): Promise<void> => {
    await host.prepare(request);
    audio = { ...audio, status: 'playing', generation: 2, positionMs: 0 };
    host.observe(clockFromNativeStatus(audio, (process.hrtime.bigint() / 100n).toString()));
  };
  return { host, obs, failures, logs, play, audio: () => audio, before: (hook: (label: string) => Promise<void> | null): void => { beforeRequest = hook; } };
}
/** Until `done` holds, at most 4 s. */
async function until(done: () => boolean): Promise<void> {
  for (let spent = 0; !done() && spent < 4000; spent += 10) await new Promise(resolve => setTimeout(resolve, 10));
}
const failedStart = (logs: readonly string[]): string | undefined => logs.find(line => line.startsWith('error 播放素材 · 视频 · failed'));

const STOPPED = '[STOP SetInputMute SetSceneItemEnabled]', STARTED = '[SetSceneItemEnabled SetInputMute SetCurrentProgramScene PLAY]';

it('OBS 照常执行：素材开始播放，到会话的结果是成功（2026-11-11 R3b）', async () => {
  watchSteps(); const test = setup();
  await test.play(); await until(() => test.logs.some(line => line.includes('播放素材 · 视频 · succeeded'))); await test.host.stop();
  expect(test.obs.sent).toEqual(['GetMediaInputStatus', STARTED, 'GetMediaInputStatus', STOPPED]);
  expect(test.logs).toEqual(['info 播放素材 · 视频 · succeeded', 'info 停止素材 · 视频 · succeeded']);
  expect(test.host.status?.fault).toBeUndefined();
  expect(test.failures).toEqual([]);
  await expectSteps([{ kind: 'done' }], [{ kind: 'done' }]);
});

it('开始素材的请求超时：会话收到“没回应”；发出的请求、红字和日志和以前一样（2026-11-11 R3b）', async () => {
  watchSteps(); const test = setup(); test.obs.set('hold');
  await test.play(); await until(() => failedStart(test.logs) !== undefined); await test.host.stop();
  // The timeout ends the connection: the song's stop sends nothing more.
  expect(test.obs.sent).toEqual(['GetMediaInputStatus', STARTED]);
  const reason = 'OBS 素材场景批量控制 请求超时（200 ms）；不确定是否已执行，请检查 OBS 后重新连接';
  expect(test.logs).toEqual(['error 素材动作失败的请求耗时', `error 播放素材 · 视频 · failed：${reason}`,
    'error 素材动作失败的请求耗时', `error 停止素材 · 视频 · failed：${reason}`]);
  expect(test.host.status?.fault).toBe(`素材播放失败：视频 · ${reason}`);
  expect(test.failures).toEqual([`画面没有清理干净：${reason}`]);
  await expectSteps([{ kind: 'unanswered', reason }], [{ kind: 'withdrawn', reason }]);
});

it('开始素材的请求还没发出就停了：会话收到“没发出去”，账上撤回这次开始，停止时不再给这个素材发停止（2026-11-10 第 2 题，R5 改）', async () => {
  watchSteps(); const test = setup();
  // The operator stops while the clip's first request is on its way to the scheduler.
  let release: (() => void) | null = null;
  test.before(label => label === '检查预热素材' && !release ? new Promise<void>(resolve => { release = resolve; }) : null);
  await test.play(); await until(() => release !== null);
  const stopping = test.host.stop(); release!(); await stopping;
  // Nothing of the start went out: the decoder is where the preparation left it, like a clip
  // the song never reached, and the song's stop leaves it to the preparation as it does those.
  expect(test.obs.sent).toEqual([]);
  const reason = 'OBS 动作已取消或已过时，没有发送：检查预热素材';
  expect(test.logs).toEqual(['error 素材动作失败的请求耗时', `error 播放素材 · 视频 · failed：${reason}`]);
  expect(test.host.status?.fault).toBe(`素材播放失败：视频 · ${reason}`);
  expect(test.failures).toEqual([]);
  await expectSteps([{ kind: 'withdrawn', reason }], []);
});

it('素材开始播放后和音乐没对齐：会话收到“失败、已上画面、没对齐”；发出的请求、红字和日志和以前一样（2026-11-11 R3b）', async () => {
  watchSteps(); const test = setup(); test.obs.set('behind');
  await test.play(); await until(() => failedStart(test.logs) !== undefined); await test.host.stop();
  expect(test.obs.sent).toEqual(['GetMediaInputStatus', STARTED, 'GetMediaInputStatus', STOPPED]);
  const line = failedStart(test.logs)!, reason = line.slice('error 播放素材 · 视频 · failed：'.length);
  expect(reason).toMatch(/^切场景后素材位置对不上：视频，按音乐应该在 5\d{3} ms，OBS 实际在 3\d{3} ms$/u);
  expect(test.logs).toEqual(['error 素材动作失败的请求耗时', line, 'info 停止素材 · 视频 · succeeded']);
  expect(test.host.status?.fault).toBe(`素材播放失败：视频 · ${reason}`);
  expect(test.failures).toEqual([]);
  await expectSteps([{ kind: 'failed', reason, onAir: true, outOfStep: true, sent: true }], [{ kind: 'done' }]);
});

it('OBS 拒绝显示素材：会话收到“失败”，不在画面上；发出的请求、红字和日志和以前一样（2026-11-11 R3b）', async () => {
  watchSteps(); const test = setup(); test.obs.set('refuse');
  await test.play(); await until(() => failedStart(test.logs) !== undefined); await test.host.stop();
  expect(test.obs.sent).toEqual(['GetMediaInputStatus', STARTED, STOPPED]);
  const reason = 'SetSceneItemEnabled：OBS 没能显示这个来源';
  expect(test.logs).toEqual(['error 素材动作失败的请求耗时', `error 播放素材 · 视频 · failed：${reason}`, 'info 停止素材 · 视频 · succeeded']);
  expect(test.host.status?.fault).toBe(`素材播放失败：视频 · ${reason}`);
  expect(test.failures).toEqual([]);
  await expectSteps([{ kind: 'failed', reason, onAir: false, outOfStep: false, sent: true }], [{ kind: 'done' }]);
});

/** The kinds the session's output() got for the clip's events, in order; every one that is not
 * done reaches the ledger writes as a failure with its kind. `cleanup`: the song's stop of the clip,
 * which goes out with the stop and not through output(). */
async function expectSteps(played: ManagedMediaOutcome[], cleanup: ManagedMediaOutcome[]): Promise<void> {
  const reports = await Promise.all(watched!.reports.mock.results.map(result => result.value as Promise<{ outcome?: ManagedMediaOutcome }>));
  expect(reports.map(report => report.outcome)).toEqual([...played, ...cleanup]);
  expect(watched!.settles.mock.calls.flatMap(([, outcome]) => typeof outcome === 'object' && outcome !== null && 'step' in outcome ? [outcome.step] : []))
    .toEqual(played.filter(step => step.kind !== 'done'));
}

it('素材动作的结果只按错误的类型分，不看文案；包过一层的错误按里面那一层分（2026-11-11 R3b）', async () => {
  const scheduler = new ObsRequestScheduler(20, () => undefined);
  scheduler.connect();
  const unanswered = await scheduler.request(() => new Promise<never>(() => undefined), '素材场景批量控制').catch((error: unknown) => error);
  const notSent = await scheduler.request(() => Promise.resolve(), '确认素材实际状态').catch((error: unknown) => error);
  scheduler.connect();
  const cancelled = await scheduler.guarded(() => false, () => scheduler.request(() => Promise.resolve(), '检查预热素材')).catch((error: unknown) => error);
  expect(unanswered).toBeInstanceOf(ObsRequestUnanswered); expect(notSent).toBeInstanceOf(ObsRequestNotSent); expect(cancelled).toBeInstanceOf(ObsRequestNotSent);
  const text = (error: unknown): string => error instanceof Error ? error.message : String(error);
  expect(mediaStepOutcome(unanswered, true)).toEqual({ kind: 'unanswered', reason: text(unanswered) });
  // After a timeout ended the connection, a step that sent nothing was not carried out; one that sent some may have been.
  expect(text(notSent)).toBe(text(unanswered));
  expect(mediaStepOutcome(notSent, false)).toEqual({ kind: 'withdrawn', reason: text(notSent) });
  expect(mediaStepOutcome(notSent, true)).toEqual({ kind: 'unanswered', reason: text(notSent) });
  expect(mediaStepOutcome(cancelled, false)).toEqual({ kind: 'withdrawn', reason: text(cancelled) });
  // Part of the step went out before the rest was cancelled: OBS carried that part out.
  expect(mediaStepOutcome(cancelled, true)).toEqual({ kind: 'failed', reason: text(cancelled), onAir: false, outOfStep: false, sent: true });
  const outOfStep = new MediaOutOfStepError('切场景后素材位置对不上');
  expect(mediaStepOutcome(new Error('画面接着上一段往下播，切到了这一段，但和音乐没对齐', { cause: outOfStep }), true))
    .toEqual({ kind: 'failed', reason: '画面接着上一段往下播，切到了这一段，但和音乐没对齐', onAir: true, outOfStep: true, sent: true });
  expect(mediaStepOutcome(new MediaOnAirError('位置未知'), true)).toEqual({ kind: 'failed', reason: '位置未知', onAir: true, outOfStep: false, sent: true });
  // The same words without the type are an ordinary failure.
  expect(mediaStepOutcome(new Error(text(unanswered)), true)).toEqual({ kind: 'failed', reason: text(unanswered), onAir: false, outOfStep: false, sent: true });
  // Refused before any of it went out: OBS did nothing with it (R5 counts it as failed, not uncertain).
  expect(mediaStepOutcome(new Error('OBS 没能显示这个来源'), false)).toEqual({ kind: 'failed', reason: 'OBS 没能显示这个来源', onAir: false, outOfStep: false, sent: false });
});
