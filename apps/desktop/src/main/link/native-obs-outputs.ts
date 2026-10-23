import { dirname } from 'node:path';
import { stat, statfs } from 'node:fs/promises';
import { millisecondsToFrameNumber, preciseSeekAssetIds, projectFromObsSnapshot, runLinkPreflight, SceneOutputTimeline, type ObsProgramSessionDependencies } from '@tb/core/link';
import type { NativeObsPrepare } from '@tb/schema';
import type { ObsWebSocketAdapter } from './obs-websocket-adapter';
import type { LinkProjectService } from './link-project-service';
import type { MediaPreviewService } from './media-preview-service';
import type { SecureProfileStore } from './secure-profile-store';
import type { ObsNativeSeek } from './obs-native-seek';
import type { NativePlayerService } from './native-player-service';
import type { LinkRunLogger } from './run-logger';
import { redactValue } from './run-logger';
import { ObsMediaPreload } from './obs-media-preload';
import { obsMediaDecodeTargets } from './obs-media-decode';
import { obsMediaCachePaths } from './obs-media-paths';

/** A picture preparation superseded by another song or a stop; not a failed output. */
export class ObsPreparationCancelled extends Error {}

export type NativeObsOutputs = Omit<ObsProgramSessionDependencies, 'state' | 'cueReport' | 'mediaReport' | 'fault'> & {
  preloadResources: (assertCurrent: () => void, phase?: 'idle' | 'playback' | 'background' | 'reconnect') => Promise<void>;
  /** OBS forgot this song's owned scenes after a reconnect: prepare them again, without warming any decoder. */
  restoreScenes: (assertCurrent: () => void) => Promise<void>;
};

type Services = {
  obs: ObsWebSocketAdapter; projects: LinkProjectService; media: MediaPreviewService;
  profiles: SecureProfileStore; seek: ObsNativeSeek; logger: LinkRunLogger;
  audioIdentity: () => NativePlayerService['audioCaptureIdentity'];
  logFailure: (error: Error) => void;
};

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
    prime: async (name, retained, kind) => { if (!address) throw new Error('后台画面连接尚未准备'); await seek.prime(address, name, retained, kind); },
    seek: async (name, position) => { if (!address) throw new Error('后台画面连接尚未准备'); await seek.seek(address, name, position); }
  });
  const outputs: NativeObsOutputs = {
    outputNotice: () => captureNotice,
    now: () => performance.now(), executor: { id: obs.id, supports: action => obs.supports(action),
      // Program snapshots exist only in full-scene mode: show/hide acts on the scene on program.
      execute: action => action.kind === 'obs.setSceneItemEnabled' ? obs.setSourceEnabledInProgramScene(preload.resolveSource(action.sourceName), action.enabled)
        : obs.execute('inputName' in action ? { ...action, inputName: preload.resolveSource(action.inputName) }
          : 'sourceName' in action ? { ...action, sourceName: preload.resolveSource(action.sourceName) } : action) },
    guardOutput: (canSend, operation, dispatched) => obs.guardPlaybackOperation(canSend, operation, dispatched),
    recordLog: entry => logger.recordBuffered(entry.category === 'action' && entry.result === 'failed'
      ? { ...entry, details: { ...entry.details, obsRequests: obs.getRequestDiagnostics() } } : entry, services.logFailure),
    preloadResources: async (assertCurrent, preparationPhase = 'idle') => {
      const started = performance.now(); let previous = started;
      const measure = async (stage: string): Promise<void> => {
        const now = performance.now();
        await logger.record({ level: 'info', category: 'preflight', device: '后台画面', projectId: project.projectId,
          itemId: request.snapshot.item.id, message: `画面准备 · ${stage}`, result: 'succeeded',
          details: { stageMs: now - previous, elapsedMs: now - started } });
        previous = now;
      };
      assertCurrent();
      if (obs.getSnapshot().status !== 'connected') throw new Error('OBS 未连接，画面通道本轮不参与');
      const profile = await profiles.loadProfile(); assertCurrent();
      if (!profile) throw new Error('本机连接配置尚未保存');
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
            if (!inspected[asset.id]?.fileAvailable) throw new Error(`素材文件不可读：${asset.name}`);
            phase = '文件身份'; timings.push({ phase, atMs: performance.now() - assetStarted });
            const absolute = projects.resolveMediaAsset(path, asset.relativePath);
            const identity = await stat(absolute);
            if (!identity.isFile()) throw new Error(`素材文件不可读：${asset.name}`);
            identities.set(absolute, identity);
            assertCurrent();
            phase = '定位缓存核验'; timings.push({ phase, atMs: performance.now() - assetStarted });
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
            await logger.record({ level: 'info', category: 'preflight', device: '后台画面', projectId: project.projectId,
              itemId: request.snapshot.item.id, message: `素材准备完成：${asset.name}`, result: 'succeeded',
              details: { assetId: asset.id, hardwareDecode, elapsedMs: performance.now() - assetStarted, timings } });
          } catch (error) {
            if (!(error instanceof ObsPreparationCancelled)) await logger.record({ level: 'error', category: 'preflight', device: '后台画面', projectId: project.projectId,
              itemId: request.snapshot.item.id, message: `素材准备未完成：${asset.name}`, result: 'failed',
              details: { assetId: asset.id, phase, elapsedMs: performance.now() - assetStarted, timings,
                error: error instanceof Error ? error.message : String(error) } });
            throw error;
          }
        }));
        const failure = results.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        assertCurrent(); await measure(`校验、准备及预热素材 ${offset + 1}–${Math.min(offset + batchSize, materialTargets.length)}`);
      }
      const assets = await projects.inspectAssets(path, project); assertCurrent();
      await measure('预检文件状态');
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
      await measure('读取目录');
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
      for (const check of report.checks) {
        await logger.record({ level: check.status === 'blocking' ? 'error' : check.status === 'warning' ? 'warning' : 'info',
          category: 'preflight', device: '后台画面', projectId: project.projectId, itemId: request.snapshot.item.id,
          message: `${check.label}：${check.detail}`, result: check.status === 'blocking' ? 'failed' : 'succeeded' });
        assertCurrent();
      }
      if (!report.passed) throw new Error(report.checks.filter(check => check.status === 'blocking').map(check => check.detail).join('；'));
      await measure('预检');
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
      await prepareStructure(); assertCurrent(); await measure('机位结构');
      prepared = true;
    },
    restoreScenes: assertCurrent => outputs.preloadResources(assertCurrent, 'reconnect'),
    prepareOutputs: async assertCurrent => {
      if (!prepared) await outputs.preloadResources(assertCurrent, 'playback');
      assertCurrent();
      if (obs.getSnapshot().status !== 'connected') throw new Error('OBS 已断开，不能使用预备画面');
      // A prepared decoder must not conceal an edited/deleted source file.
      for (const [file, identity] of identities) {
        const actual = await stat(file); assertCurrent();
        if (actual.size !== identity.size || actual.mtimeMs !== identity.mtimeMs || actual.ctimeMs !== identity.ctimeMs || actual.ino !== identity.ino) {
          throw new Error('已预备的素材发生变化，请重新导入后准备节目');
        }
      }
      const scenes = [...new Set([...request.snapshot.item.cues.filter(cue => cue.enabled)
        .flatMap(cue => cue.actions.flatMap(action => action.kind === 'obs.setProgramScene' ? [action.sceneName] : [])),
      ...materialTargets.map(target => target.sceneName)])];
      capture = services.audioIdentity();
      try { await obs.setInternalAudioCapture(true, capture.executable, capture.title, capture.audioDeviceId, scenes, capture.windowClass); }
      catch (error) {
        assertCurrent();
        captureNotice = `OBS 音乐采集未就绪：${error instanceof Error ? error.message : String(error)}。本机音频与画面动作继续，OBS 是否收到音乐请检查混音器。`;
        await logger.record({ level: 'warning', category: 'device', device: 'OBS 音乐采集',
          projectId: project.projectId, itemId: request.snapshot.item.id, message: captureNotice, result: 'failed' });
      }
      assertCurrent();
    },
    prepareUpcoming: (frame, assertCurrent) => obs.preparePlaybackMedia(() => preload.upcoming(frame, assertCurrent)),
    releaseOutputs: async () => {
      const cleanup = [() => preload.close(), () => obs.mediaScenes.releasePrimed(materialTargets.flatMap(target => [target.sourceName, `${target.sourceName}·预备`])),
        () => obs.mediaScenes.releaseImages(materialTargets.filter(target => target.asset.kind === 'image').map(target => target.sourceName)), () => logger.flush()];
      const target = capture;
      if (target) cleanup.push(async () => {
        await obs.setInternalAudioCapture(false, target.executable, target.title, target.audioDeviceId, undefined, target.windowClass);
        capture = null;
      });
      const errors: string[] = [];
      for (const release of cleanup) {
        try { await release(); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
      }
      if (errors.length) throw new Error(`画面通道清理未完成：${errors.join('；')}`);
    },
    executeManagedMediaEvent: async payload => {
      if (payload.projectPath !== path) throw new Error('后台画面素材与当前工程不一致');
      try { await preload.execute(payload.event, projects.resolveMediaAsset(path, payload.event.relativePath)); }
      catch (error) {
        await logger.record({ level: 'error', category: 'device', device: '后台画面', projectId: project.projectId,
          itemId: request.snapshot.item.id, message: '素材动作失败的请求耗时', result: 'failed',
          details: { clipId: payload.event.clipId, error: error instanceof Error ? error.message : String(error),
            ...obs.getRequestDiagnostics() } });
        throw error;
      }
    },
    correctMediaDrift: event => {
      const received = performance.now();
      return obs.mediaScenes.correctDrift({ ...event, sourceName: preload.resolveSource(event.sourceName) }, () => event.sourceOffsetMs + performance.now() - received);
    },
    seekMedia: async event => {
      if (!address) throw new Error('后台画面连接尚未准备');
      const target = address;
      await seek.prepare(target);
      await preload.seek(event, projects.resolveMediaAsset(path, event.relativePath));
    }
  };
  return outputs;
}
