import { dirname } from 'node:path';
import { stat, statfs } from 'node:fs/promises';
import { firstTimeWarning, millisecondsToFrameNumber, preciseSeekAssetIds, preflightLogEntries, projectFromObsSnapshot, runLinkPreflight, SceneOutputTimeline, type LinkActionExecutor, type ManagedMediaEvent, type ManagedMediaOutcome, type ObsProgramSessionDependencies } from '@tb/core/link';
import type { NativeObsPrepare } from '@tb/schema';
import type { ObsWebSocketAdapter } from './obs-websocket-adapter';
import { MediaOnAirError, MediaOutOfStepError, type ObsMediaScenes } from './obs-media-scenes';
import { ObsRequestNotSent, ObsRequestUnanswered } from './obs-request-scheduler';
import type { LinkProjectService } from './link-project-service';
import type { MediaPreviewService } from './media-preview-service';
import type { SecureProfileStore } from './secure-profile-store';
import type { ObsNativeSeek } from './obs-native-seek';
import type { NativePlayerService } from './native-player-service';
import type { LinkRunLogger } from './run-logger';
import { redactValue } from './run-logger';
import { ObsMediaPreload, ObsPreparationNotNeeded, type HeldPictures } from './obs-media-preload';
import { obsMediaDecodeTargets } from './obs-media-decode';
import { obsMediaCachePaths } from './obs-media-paths';
import { PreparationSteps, SLOW_PREPARATION_STEP_MS } from './preparation-log';

/** A picture preparation superseded by another song or a stop; not a failed output. */
export class ObsPreparationCancelled extends Error {}

export type NativeObsOutputs = Omit<ObsProgramSessionDependencies, 'state' | 'cueReport' | 'mediaReport' | 'fault'> & {
  preloadResources: (assertCurrent: () => void, phase?: 'idle' | 'playback' | 'background' | 'reconnect') => Promise<void>;
  /** OBS forgot this song's owned scenes after a reconnect: prepare them again, without warming any decoder. */
  restoreScenes: (assertCurrent: () => void) => Promise<void>;
  holdOutputs: NonNullable<ObsProgramSessionDependencies['holdOutputs']>;
  /** After the song stopped: the decoders holding its last frame, each with the clip it holds (R14). */
  heldDecoders: () => ReadonlyMap<string, string>;
  /** A later song takes `sourceName` over (`HeldPictures.takeOver`): from then on this song's cleanup leaves it alone. */
  handOver: (sourceName: string, reuse: boolean) => Promise<void>;
};

type Services = {
  obs: ObsWebSocketAdapter; projects: LinkProjectService; media: MediaPreviewService;
  profiles: SecureProfileStore; seek: ObsNativeSeek; logger: LinkRunLogger;
  audioIdentity: () => NativePlayerService['audioCaptureIdentity'];
  logFailure: (error: Error) => void;
  /** Advisories and repeated warnings already recorded in this run of the software (preflightLogEntries, firstTimeWarning). */
  seenNotices: Set<string>;
  /** What a stopped song left on its last frame, which this song's decoders take over (R14). */
  held?: HeldPictures;
};

/** What a song's picture actions reach: OBS, and the decoders the song's materials take turns on. */
type PictureObs = Pick<ObsWebSocketAdapter, 'supports' | 'execute' | 'setSourceEnabledInProgramScene'> & Pick<LinkActionExecutor, 'id'>;
/** Where the executor records an action it did not send. */
type PictureLog = { record: ObsProgramSessionDependencies['recordLog']; projectId: string; itemId: string };
type PictureDecoders = Pick<ObsMediaPreload, 'resolveSource' | 'onAirSource'>;

/** The OBS executor of a song's picture. An action naming a material's input
 * reaches the decoder that stands for the material's clip now. A pause or resume
 * of a material with nothing on air (its start was refused or failed before OBS
 * showed it) reaches no decoder: it is not sent, not a failure, and the run log
 * gets one line. A name that is not one of the song's materials (the user's own
 * OBS input) passes as it is. */
export function pictureExecutor(obs: PictureObs, decoders: PictureDecoders, log: PictureLog): LinkActionExecutor {
  return { id: obs.id, supports: action => obs.supports(action),
    execute: action => {
      // Program snapshots exist only in full-scene mode: show/hide acts on the scene on program.
      if (action.kind === 'obs.setSceneItemEnabled') return obs.setSourceEnabledInProgramScene(decoders.resolveSource(action.sourceName), action.enabled);
      if (action.kind === 'obs.mediaAction') {
        const inputName = decoders.onAirSource(action.inputName);
        if (inputName !== null) return obs.execute({ ...action, inputName });
        const what = action.action === 'pause' ? '素材暂停' : action.action === 'start' ? '素材继续播放' : '素材动作';
        void log.record({ level: 'info', category: 'action', device: 'obs', projectId: log.projectId, itemId: log.itemId, actionId: action.id,
          message: `${what}没有发给 OBS：这个素材这时没有画面在播，不用处理`, result: 'skipped', details: { inputName: action.inputName, action: action.action } })
          .catch((error: unknown) => console.error('没有发给 OBS 的素材动作未能记入日志', error));
        return Promise.resolve();
      }
      return obs.execute('inputName' in action ? { ...action, inputName: decoders.resolveSource(action.inputName) }
        : 'sourceName' in action ? { ...action, sourceName: decoders.resolveSource(action.sourceName) } : action);
    } };
}

/** The drift check of a song's picture (recovery rule B), on the decoder of the
 * material's clip on air now; none when nothing of the material is on air. */
export function pictureDriftCheck(scenes: Pick<ObsMediaScenes, 'correctDrift'>, decoders: Pick<ObsMediaPreload, 'onAirSource'>): NonNullable<NativeObsOutputs['correctMediaDrift']> {
  return (event, mayCorrect) => {
    const sourceName = decoders.onAirSource(event.sourceName);
    if (sourceName === null) return Promise.resolve(null);
    const received = performance.now();
    return scenes.correctDrift({ ...event, sourceName }, () => event.sourceOffsetMs + performance.now() - received, mayCorrect);
  };
}

/** A clip shown from the middle and located (a start from the middle, a seek, a rebuild). A look that could not be set
 * (0.5.9 E16) leaves the clip shown and located as OBS has it: it counts as located, nothing is sent again, and the
 * run log gets one line with the clip's red text. */
export function pictureSeekStep(decoders: Pick<ObsMediaPreload, 'seek'>, log: PictureLog): (event: ManagedMediaEvent, path: string) => Promise<void> {
  return async (event, path) => {
    const problem = await decoders.seek(event, path);
    if (problem === null) return;
    void log.record({ level: 'error', category: 'device', device: '后台画面', projectId: log.projectId, itemId: log.itemId,
      message: problem, result: 'failed', details: { clipId: event.clipId } })
      .catch((error: unknown) => console.error('素材样子没有设好未能记入日志', error));
  };
}

/** The lookahead of a song's picture (ObsMediaPreload.upcoming). A clip whose
 * preparation failed once it already played on from the decoder of the clip it
 * continues needs nothing: the program is not told (its red text would say the
 * clip may not play, while it is on air), and the run log gets one line. */
export function pictureUpcoming(decoders: Pick<ObsMediaPreload, 'upcoming'>, log: PictureLog): (frame: number, assertCurrent: () => void) => Promise<ManagedMediaEvent | null> {
  return async (frame, assertCurrent) => {
    try { return await decoders.upcoming(frame, assertCurrent); }
    catch (error) {
      if (!(error instanceof ObsPreparationNotNeeded)) throw error;
      void log.record({ level: 'warning', category: 'device', device: '后台画面', projectId: log.projectId, itemId: log.itemId,
        message: `准备素材没成功：${error.event.assetName}。这一段已经接着上一段往下播，画面照常。原因：${error.reason}。不用处理，后面的素材照常播`, result: 'failed',
        details: { clipId: error.event.clipId, inputName: error.decoder, error: error.reason } })
        .catch((failure: unknown) => console.error('没用上的素材准备失败未能记入日志', failure));
      return null;
    }
  };
}

/** The error and the errors it was raised from (`cause`), outermost first. */
function errorChain(error: unknown): Error[] {
  const chain: Error[] = [];
  for (let current = error; current instanceof Error && chain.length < 8 && !chain.includes(current); current = current.cause) chain.push(current);
  return chain;
}

/** What a media step that threw came to, by the error's type and the types it was raised
 * from, never by its wording. `sent`: one of the step's requests went out to OBS. */
export function mediaStepOutcome(error: unknown, sent: boolean): Exclude<ManagedMediaOutcome, { kind: 'done' }> {
  const reason = error instanceof Error ? error.message : String(error), chain = errorChain(error);
  const unanswered = chain.some(item => item instanceof ObsRequestUnanswered);
  if (!sent && (unanswered || chain.some(item => item instanceof ObsRequestNotSent))) return { kind: 'withdrawn', reason };
  if (unanswered) return { kind: 'unanswered', reason };
  const onAir = chain.find(item => item instanceof MediaOnAirError);
  return { kind: 'failed', reason, onAir: onAir !== undefined, outOfStep: onAir instanceof MediaOutOfStepError, sent };
}

/** The clip events of a song's picture, on the decoders its materials take turns on. Resolves with
 * what the step came to, for the picture session's ledger; the report and the run log read as they
 * did when this threw. Watching the step's requests go out sends nothing and changes no guard. */
export function pictureMediaStep(obs: Pick<ObsWebSocketAdapter, 'guardPlaybackOperation' | 'getRequestDiagnostics'>, decoders: Pick<ObsMediaPreload, 'execute'>,
  projectPath: string, resolve: (relativePath: string) => string, log: { record: LinkRunLogger['record']; projectId: string; itemId: string }): NativeObsOutputs['executeManagedMediaEvent'] {
  return async (payload): Promise<ManagedMediaOutcome> => {
    if (payload.projectPath !== projectPath) return { kind: 'failed', reason: '画面素材和当前工程对不上', onAir: false, outOfStep: false, sent: false };
    let sent = false;
    try {
      await obs.guardPlaybackOperation(() => true, () => decoders.execute(payload.event, resolve(payload.event.relativePath)), () => { sent = true; });
      return { kind: 'done' };
    } catch (error) {
      await log.record({ level: 'error', category: 'device', device: '后台画面', projectId: log.projectId,
        itemId: log.itemId, message: '素材动作失败的请求耗时', result: 'failed',
        details: { clipId: payload.event.clipId, error: error instanceof Error ? error.message : String(error),
          ...obs.getRequestDiagnostics() } });
      return mediaStepOutcome(error, sent);
    }
  };
}

async function runAll(cleanup: readonly (() => Promise<void>)[]): Promise<void> {
  const errors: string[] = [];
  for (const release of cleanup) {
    try { await release(); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  if (errors.length) throw new Error(`画面没有清理干净：${errors.join('；')}`);
}

export type PictureHold = { release: () => Promise<void>; hold: (clips: readonly { sourceName: string; clipId: string }[]) => Promise<void>;
  decoders: () => ReadonlyMap<string, string>; handOver: (sourceName: string, reuse: boolean) => Promise<void> };
/** What a song's picture lets go of at its stop and at its release (R14). The stop: the decoders of the clips on air
 * (and images shown) stay, holding the last frame, the program scene with them; everything else goes, with `finish`
 * (the run log, the music's capture). The release: what still holds the last frame, less what a later song took over
 * (that song's now, as is anything else of the same names it uses). Neither touches what another stopped song still
 * holds and this song did not take over (it used the other decoder of the pair, or was cancelled meanwhile). */
export function pictureHold(preload: Pick<ObsMediaPreload, 'close' | 'hold' | 'decoderOf' | 'forget' | 'giveWay'>, scenes: Pick<ObsMediaScenes, 'releasePrimed' | 'releaseImages'>,
  materials: readonly { sourceName: string; image: boolean }[], held: HeldPictures | undefined, finish: readonly (() => Promise<void>)[]): PictureHold {
  const imageNames = new Set(materials.filter(material => material.image).map(material => material.sourceName));
  const decoderNames = materials.flatMap(material => [material.sourceName, `${material.sourceName}·预备`]);
  const kept = new Map<string, string>(), handedOver = new Set<string>();
  let holding = false;
  const others = (): ReadonlyMap<string, string> => held?.decoders() ?? new Map<string, string>();
  const release = (owned: (name: string) => boolean, closing: () => Promise<void>): Promise<void> => runAll([closing,
    () => scenes.releasePrimed(decoderNames.filter(owned)), () => scenes.releaseImages([...imageNames].filter(owned)), ...finish]);
  return {
    release: () => {
      if (holding) return release(name => kept.has(name) && !handedOver.has(name), () => preload.close());
      const theirs = others();
      return release(name => !theirs.has(name), () => preload.close());
    },
    hold: clips => {
      const theirs = others();
      holding = true;
      for (const { sourceName, clipId } of clips) {
        const decoder = imageNames.has(sourceName) ? sourceName : preload.decoderOf(sourceName);
        if (decoder !== null) kept.set(decoder, clipId);
      }
      const keep = new Set(kept.keys());
      return release(name => !keep.has(name) && !theirs.has(name), () => preload.hold(keep));
    },
    decoders: () => new Map([...kept].filter(([name]) => !handedOver.has(name))),
    handOver: async (sourceName, reuse) => {
      if (handedOver.has(sourceName) || !kept.has(sourceName)) return;
      handedOver.add(sourceName);
      if (reuse || imageNames.has(sourceName)) preload.forget(sourceName);
      else await preload.giveWay(sourceName);
    }
  };
}

/** Per-program adapters. Original documents are neither rewritten nor reread;
 * only this immutable snapshot's referenced resources are prepared. */
export function createNativeObsOutputs(request: NativeObsPrepare, services: Services, positionMs: number): NativeObsOutputs {
  const { obs, projects, profiles, seek, logger } = services;
  const project = projectFromObsSnapshot(request.snapshot), path = request.projectPath;
  // Leave decode-engine headroom for the standby slot. Remaining live layers
  // use fast CPU lossless caches instead of adding more hardware sessions.
  const materialTargets = obsMediaDecodeTargets(project);
  const preciseAssets = preciseSeekAssetIds(request.snapshot, positionMs);
  let address: string | null = null, capture: NativePlayerService['audioCaptureIdentity'] | null = null;
  let prepared = false;
  let captureNotice: string | null = null;
  const identities = new Map<string, { size: number; mtimeMs: number; ctimeMs: number; ino: number }>();
  const preload = new ObsMediaPreload(project, request.snapshot.item.id, obs.mediaScenes, {
    prime: async (name, retained, kind) => { if (!address) throw new Error('画面连接还没准备好'); await seek.prime(address, name, retained, kind); },
    seek: async (name, position) => { if (!address) throw new Error('画面连接还没准备好'); await seek.seek(address, name, position); }
  }, services.held);
  const releaseCapture = async (): Promise<void> => {
    const target = capture;
    if (!target) return;
    await obs.setInternalAudioCapture(false, target.executable, target.title, target.audioDeviceId, undefined, target.windowClass);
    capture = null;
  };
  const hold = pictureHold(preload, obs.mediaScenes, materialTargets.map(target => ({ sourceName: target.sourceName, image: target.asset.kind === 'image' })),
    services.held, [() => logger.flush(), releaseCapture]);
  const recordLog: NativeObsOutputs['recordLog'] = entry => logger.recordBuffered(entry.category === 'action' && entry.result === 'failed'
    ? { ...entry, details: { ...entry.details, obsRequests: obs.getRequestDiagnostics() } } : entry, services.logFailure);
  const pictureLog: PictureLog = { record: recordLog, projectId: project.projectId, itemId: request.snapshot.item.id };
  const upcoming = pictureUpcoming(preload, pictureLog);
  const seekStep = pictureSeekStep(preload, pictureLog);
  const outputs: NativeObsOutputs = {
    outputNotice: () => captureNotice,
    now: () => performance.now(), executor: pictureExecutor(obs, preload, pictureLog),
    guardOutput: (canSend, operation, dispatched) => obs.guardPlaybackOperation(canSend, operation, dispatched),
    recordLog,
    preloadResources: async (assertCurrent, preparationPhase = 'idle') => {
      const started = performance.now(); let previous = started;
      // One 画面准备完成 entry carries every stage and asset; only a slow one is recorded as it happens.
      const reportSlow = (step: string, ms: number): void => {
        void logger.record({ level: 'info', category: 'preflight', device: '后台画面', projectId: project.projectId, itemId: request.snapshot.item.id,
          message: `画面准备较慢：${step} 用了 ${(ms / 1000).toFixed(1)} 秒`, result: 'succeeded', details: { phase: preparationPhase, ms: Math.round(ms) } })
          .catch((error: unknown) => console.error('画面准备计时日志未能保存', error));
      };
      const steps = new PreparationSteps(reportSlow);
      const preparedAssets: Record<string, unknown>[] = [];
      const measure = (stage: string): void => {
        const now = performance.now();
        steps.add(stage, now - previous);
        previous = now;
      };
      assertCurrent();
      if (obs.getSnapshot().status !== 'connected') throw new Error('OBS 没有连接，这一首不联动画面');
      const profile = await profiles.loadProfile(); assertCurrent();
      if (!profile) throw new Error('本机连接设置还没保存');
      address = profile.obs.webSocketUrl;
      const opening = new SceneOutputTimeline(project, request.snapshot.item.id).at(millisecondsToFrameNumber(positionMs, request.snapshot.frameRate));
      const openingDecoders = new Map(opening.media.filter(event => event.assetKind !== 'image')
        .map(event => [event.sourceName, event]));
      // Selection can warm quietly in sequence. At an explicit cold playback
      // admission, two independent decoders overlap so four layers do not
      // consume the entire one-second window before the structure is ready.
      // Live lookahead remains single-file and staggered by ObsMediaPreload.
      const primeTails = Array.from({ length: preparationPhase === 'playback' ? 2 : 1 }, () => Promise.resolve());
      let nextPrimeSlot = 0;

      // Each input is verified before OBS opens it. Pipeline disk work and OBS
      // decoding across eight independent layers instead of waiting for every
      // video digest before preparing the opening images.
      const batchSize = preparationPhase === 'background' ? 1 : 8;
      for (let offset = 0; offset < materialTargets.length; offset += batchSize) {
        const results = await Promise.allSettled(materialTargets.slice(offset, offset + batchSize).map(async target => {
          const { asset } = target;
          const { hardwareDecode } = target;
          const assetStarted = performance.now(); let phase = '文件校验';
          const timings = [{ phase, atMs: 0 }];
          try {
            const inspected = await projects.inspectMediaAssets(path, [asset]); assertCurrent();
            if (!inspected[asset.id]?.fileAvailable) throw new Error(`素材文件读不了：${asset.name}`);
            phase = '文件身份'; timings.push({ phase, atMs: performance.now() - assetStarted });
            const absolute = projects.resolveMediaAsset(path, asset.relativePath);
            const identity = await stat(absolute);
            if (!identity.isFile()) throw new Error(`素材文件读不了：${asset.name}`);
            identities.set(absolute, identity);
            assertCurrent();
            phase = '画面缓存检查'; timings.push({ phase, atMs: performance.now() - assetStarted });
            const playbackPath = request.preciseSeeking && asset.kind === 'video' && preciseAssets.has(asset.id)
              ? await services.media.ensureObsSeekVideo(path, asset.relativePath, asset.sha256, hardwareDecode ? 'hardware' : 'software') : absolute;
            assertCurrent();
            phase = '来源准备'; timings.push({ phase, atMs: performance.now() - assetStarted });
            await obs.mediaScenes.prepare(project.projectId, asset, absolute, playbackPath,
              obsMediaCachePaths(path, asset.sha256), target, hardwareDecode);
            preload.register(project.projectId, asset, absolute, target.sourceName);
            assertCurrent();
            // After a reconnect the picture is rebuilt at the current position, not the opening one.
            const openingEvent = preparationPhase === 'reconnect' ? undefined : openingDecoders.get(target.sourceName);
            if (openingEvent) {
              phase = '解码预热'; timings.push({ phase, atMs: performance.now() - assetStarted });
              const primeSlot = nextPrimeSlot++ % primeTails.length;
              const priming = primeTails[primeSlot]!.then(async () => {
                assertCurrent();
                await seek.prepare(profile.obs.webSocketUrl); assertCurrent();
                await preload.prime(openingEvent, assertCurrent);
                // The idle selected-program preparation has no one-second
                // participation deadline. A cold auto-next song prepares only
                // its opening here; its successor uses the regular lookahead.
                if (preparationPhase === 'idle') await preload.primeFollowing(openingEvent, assertCurrent);
              });
              // This slot is only a barrier; the owning asset retains the error.
              primeTails[primeSlot] = priming.then(() => undefined, () => undefined);
              await priming;
              assertCurrent();
            }
            const assetMs = performance.now() - assetStarted;
            preparedAssets.push({ assetId: asset.id, name: asset.name, hardwareDecode, ms: Math.round(assetMs), timings });
            if (assetMs >= SLOW_PREPARATION_STEP_MS) reportSlow(`素材 ${asset.name}`, assetMs);
          } catch (error) {
            if (!(error instanceof ObsPreparationCancelled)) await logger.record({ level: 'error', category: 'preflight', device: '后台画面', projectId: project.projectId,
              itemId: request.snapshot.item.id, message: `素材没有准备好：${asset.name}`, result: 'failed',
              details: { assetId: asset.id, phase, elapsedMs: performance.now() - assetStarted, timings,
                error: error instanceof Error ? error.message : String(error) } });
            throw error;
          }
        }));
        const failure = results.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        assertCurrent(); measure(`检查并准备素材 ${offset + 1}–${Math.min(offset + batchSize, materialTargets.length)}`);
      }
      const assets = await projects.inspectAssets(path, project); assertCurrent();
      measure('检查文件状态');
      const actions = project.rundown.flatMap(item => item.cues.filter(cue => cue.enabled).flatMap(cue => cue.actions));
      // Name indexes remain complete, but prior songs' thousands of source
      // details must not be reread on each playback boundary. A screenshot can
      // reference an otherwise unlisted group, so that case needs scene lookup.
      const inventory = await obs.readInventory({
        scenes: actions.some(action => action.kind === 'obs.saveSourceScreenshot') ? null
          : new Set(actions.flatMap(action => 'sceneName' in action ? [action.sceneName] : [])),
        inputs: new Set(actions.flatMap(action => 'inputName' in action ? [action.inputName]
          : 'sourceName' in action ? [action.sourceName] : []))
      }); assertCurrent();
      measure('读取目录');
      const password = await profiles.loadCredential(profile.obs.credentialId); assertCurrent();
      const redacted = JSON.stringify(redactValue({ password }, password ? [password] : []));
      const disk = await statfs(dirname(path)); assertCurrent();
      const report = runLinkPreflight({ mode: 'live', mtcRequirement: 'internal', internalMtcOutputEnabled: false,
        project, profile, currentItemId: request.snapshot.item.id,
        referenceAssets: assets.referenceAudio, mediaAssets: assets.media,
        obs: { authenticated: obs.getSnapshot().status === 'connected', version: obs.getSnapshot().obsVersion, ...inventory },
        midi: { ports: [], mtcUpdating: false, mtcStable: false, detectedFrameRate: null },
        processes: { p1: { running: false, version: null } },
        availableDiskBytes: disk.bavail * disk.bsize, minimumDiskBytes: 1_073_741_824,
        credentialsDecryptable: true, logRedactionReady: !password || !redacted.includes(password)
      });
      for (const entry of preflightLogEntries(report.checks, services.seenNotices, project.projectId)) {
        await logger.record({ ...entry, category: 'preflight', device: '后台画面', projectId: project.projectId, itemId: request.snapshot.item.id });
        assertCurrent();
      }
      if (!report.passed) throw new Error(report.checks.filter(check => check.status === 'blocking').map(check => check.detail).join('；'));
      measure('开播前检查');
      const upcoming = [...new Set([
        ...request.snapshot.item.cues.filter(cue => cue.enabled).flatMap(cue => cue.actions.flatMap(action =>
          action.kind === 'obs.setProgramScene' ? [action.sceneName] : [])),
        ...materialTargets.map(target => target.sceneName)
      ])];
      const prepareStructure = async (): Promise<void> => {
        for (const entry of opening.cues) for (const action of entry.cue.actions) {
          if (action.kind !== 'obs.setProgramScene' || !action.sceneLayers) continue;
          await obs.mediaScenes.prepareComposition(action.sceneName, action.sceneLayers, upcoming.filter(name => name !== action.sceneName));
          assertCurrent();
        }
      };
      await prepareStructure(); assertCurrent(); measure('机位结构');
      await logger.record({ level: 'info', category: 'preflight', device: '后台画面', projectId: project.projectId, itemId: request.snapshot.item.id,
        message: '画面准备完成', result: 'succeeded',
        details: { phase: preparationPhase, totalMs: Math.round(performance.now() - started), steps: steps.take(), assets: preparedAssets } });
      prepared = true;
    },
    restoreScenes: async assertCurrent => { await outputs.preloadResources(assertCurrent, 'reconnect'); await preload.restoreStandby(assertCurrent); },
    prepareOutputs: async assertCurrent => {
      if (!prepared) await outputs.preloadResources(assertCurrent, 'playback');
      assertCurrent();
      if (obs.getSnapshot().status !== 'connected') throw new Error('OBS 已断开，准备好的画面不能用了');
      // A prepared decoder must not conceal an edited/deleted source file.
      for (const [file, identity] of identities) {
        const actual = await stat(file); assertCurrent();
        if (actual.size !== identity.size || actual.mtimeMs !== identity.mtimeMs || actual.ctimeMs !== identity.ctimeMs || actual.ino !== identity.ino) {
          throw new Error('准备好的素材有变化，请重新导入后再准备节目');
        }
      }
      const scenes = [...new Set([...request.snapshot.item.cues.filter(cue => cue.enabled)
        .flatMap(cue => cue.actions.flatMap(action => action.kind === 'obs.setProgramScene' ? [action.sceneName] : [])),
      ...materialTargets.map(target => target.sceneName)])];
      capture = services.audioIdentity();
      try { await obs.setInternalAudioCapture(true, capture.executable, capture.title, capture.audioDeviceId, scenes, capture.windowClass); }
      catch (error) {
        assertCurrent();
        captureNotice = `OBS 还没准备好接收音乐：${error instanceof Error ? error.message : String(error)}。本机音频和画面动作照常进行，请在 OBS 混音器里确认是否收到音乐。`;
        // Repeats song after song until fixed: a warning the first time, then info.
        await logger.record({ level: firstTimeWarning(services.seenNotices, captureNotice), category: 'device', device: 'OBS 音乐采集',
          projectId: project.projectId, itemId: request.snapshot.item.id, message: captureNotice, result: 'failed' });
      }
      assertCurrent();
    },
    prepareUpcoming: (frame, assertCurrent) => obs.preparePlaybackMedia(() => upcoming(frame, assertCurrent)),
    releaseOutputs: () => hold.release(),
    holdOutputs: clips => hold.hold(clips),
    heldDecoders: () => hold.decoders(),
    heldClipIds: () => new Set(hold.decoders().values()),
    handOver: (sourceName, reuse) => hold.handOver(sourceName, reuse),
    executeManagedMediaEvent: pictureMediaStep(obs, preload, path, relativePath => projects.resolveMediaAsset(path, relativePath),
      { record: entry => logger.record(entry), projectId: project.projectId, itemId: request.snapshot.item.id }),
    // The drift check runs inside the picture session's own queue, where the next cut waits for it: it stays at the
    // `program` tier of the material scenes, so a cut never ends up waiting behind a screenshot through it.
    correctMediaDrift: pictureDriftCheck(obs.mediaScenes, preload),
    // The picture session decides, by the counts in output-recovery.ts, whether a failed preparation goes again.
    prepareAgain: clipId => preload.prepareAgain(clipId),
    connected: () => obs.getSnapshot().status === 'connected',
    seekMedia: async event => {
      if (!address) throw new Error('画面连接还没准备好');
      const target = address;
      await seek.prepare(target);
      await seekStep(event, projects.resolveMediaAsset(path, event.relativePath));
    }
  };
  return outputs;
}
