import type { LinkProject } from '@tb/schema';
import type { PreflightReport } from '@tb/core/link';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { PlayerViewStore } from './stores/player-view-store';
import { PlaybackMidiInput } from '../registry/playback-midi-input';
import { InternalPlaybackController, emptyInternalPlayerState, type InternalPlayerDependencies } from './runtime/internal-playback-controller';
import { firstTimeWarning, toUserErrorMessage } from '@tb/core/link';
import { RemoteNativeProgramPlayer } from './runtime/remote-native-program-player';
import type { ProgramPlayerControls } from './runtime/program-player-controls';
import { recoverInternalObs } from './runtime/internal-obs-recovery';
import { internalAudioEngine, internalAudioEngineLabel } from './view-models/internal-audio-engine';
import type { LinkRuntimeCoordinator } from './runtime/link-runtime-coordinator';
import { useDocumentStore } from './stores/document-store';
import { useIntegrationStore } from './stores/integration-store';
import { linkDesktopViewModel as desktop } from './view-models/link-desktop-view-model';
import { runDesktopPreflight } from './view-models/link-preflight-view-model';
import { useRuntimeStore } from './stores/runtime-store';
import { useMa2AutoSyncStore } from './runtime/use-ma2-auto-sync';
import { useDisplayPreferences } from './stores/display-preferences-store';
import { useSelectedProgram } from './useSelectedProgram';

/** Player notices already logged as warnings in this window. */
const notedNotices = new Set<string>();
/** The operator's "play without lighting" answers in this window; the start check asks once per song. */
const withoutLightingChoices: NonNullable<InternalPlayerDependencies['withoutLightingChoices']> = new Map();

export function useInternalPlayer(coordinator: LinkRuntimeCoordinator | null, ready: boolean, project: LinkProject | null) {
  const path = useDocumentStore((state) => state.path);
  const [controller, setController] = useState<ProgramPlayerControls | null>(null);
  const [view] = useState(() => new PlayerViewStore());
  const state = useSyncExternalStore(view.subscribeControl, view.readControl);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    // A program taken over after a window reload may play an older document; once it stops, open the shown one.
    if (controller instanceof RemoteNativeProgramPlayer && controller.outdated && !['preparing', 'playing', 'paused'].includes(state.status)) setGeneration(value => value + 1);
  }, [controller, state.status]);
  const profile = useIntegrationStore((value) => value.profile);
  const obsStatus = useIntegrationStore(value => value.obs.status);
  const notifySelection = useCallback((message: string) => controller?.reportUnavailable(message), [controller]);
  const [selectedItemId] = useSelectedProgram(notifySelection);
  useEffect(() => {
    if (controller instanceof RemoteNativeProgramPlayer && obsStatus === 'connected' && selectedItemId) controller.preloadSelected(selectedItemId);
  }, [controller, obsStatus, selectedItemId]);
  useEffect(() => {
    if (!(controller instanceof InternalPlaybackController)) return;
    return desktop.onObsMediaPreparation(progress => controller.reportPreparation(
      `正在准备 OBS 画面 ${progress.index + 1}/${progress.total} · ${progress.assetName}`));
  }, [controller]);
  const engineChoice = internalAudioEngine(profile, project), requestedEngine = engineChoice.engine;
  const requestedDevice = (requestedEngine === 'native' ? profile?.internalPlayer?.nativeAudioOutputDeviceId : profile?.internalPlayer?.audioOutputDeviceId) ?? 'default';
  const requestedRate = profile?.internalPlayer?.audioSampleRate ?? 48000;
  const [audioConfiguration, setAudioConfiguration] = useState({ deviceId: requestedDevice, sampleRate: requestedRate, engine: requestedEngine });
  useEffect(() => {
    if (['preparing', 'playing', 'paused'].includes(state.status)) return;
    setAudioConfiguration(current => current.deviceId === requestedDevice && current.sampleRate === requestedRate && current.engine === requestedEngine
      ? current : { deviceId: requestedDevice, sampleRate: requestedRate, engine: requestedEngine });
  }, [requestedDevice, requestedRate, requestedEngine, state.status]);
  const controlInputName = profile?.midiPortProfiles.find((entry) => entry.id === profile.internalPlayer?.controlInputPortProfileId)?.portName;
  useEffect(() => {
    if (!controller || !controlInputName) return;
    const input = new PlaybackMidiInput((bytes) => controller.receiveMidi(bytes), (message) => controller.reportUnavailable(`播放控制 MIDI 不可用：${message}`));
    void input.connect(controlInputName).catch((error: unknown) => controller.reportUnavailable(`播放控制 MIDI 不可用：${String(error)}`));
    return () => input.dispose();
  }, [controller, controlInputName]);
  useEffect(() => {
    if (!controller || !project) return;
    const keyboard = (event: KeyboardEvent): void => {
      if (event.metaKey || event.repeat || event.defaultPrevented || (event.target instanceof HTMLElement && (event.target.closest('input,textarea,select,button,[contenteditable="true"],[role="slider"],.reference-timeline')))) return;
      const key = [...(event.ctrlKey ? ['Ctrl'] : []), ...(event.altKey ? ['Alt'] : []), ...(event.shiftKey ? ['Shift'] : []), event.code].join('+');
      const item = project.rundown.find((entry) => entry.enabled && entry.playback?.shortcut === key);
      if (item) { event.preventDefault(); void controller.play(item.id); }
      else if (!event.ctrlKey && !event.altKey && event.code === 'Space') { event.preventDefault(); void controller.toggle(); }
      else if (!event.ctrlKey && !event.altKey && event.code === 'Escape') { event.preventDefault(); void controller.stop(); }
      else if (!event.ctrlKey && !event.altKey && useIntegrationStore.getState().profile?.internalPlayer?.arrowKeyPlayback && ['ArrowUp', 'ArrowDown'].includes(event.code)) { event.preventDefault(); void controller.skip(event.code === 'ArrowUp' ? -1 : 1); }
    };
    window.addEventListener('keydown', keyboard); return () => window.removeEventListener('keydown', keyboard);
  }, [controller, project]);
  useEffect(() => {
    if (!coordinator || !project || project.playbackSource !== 'internal' || !ready) {
      setController(null); view.publish(emptyInternalPlayerState); return;
    }
    let prepared: { report: PreflightReport; profile: ReturnType<typeof useIntegrationStore.getState>['profile']; mtcOutputEnabled: boolean } | null = null;
    const dependencies: InternalPlayerDependencies = {
      // Refused before any output is prepared; the engine is never switched here.
      refusal: () => internalAudioEngine(useIntegrationStore.getState().profile, project).blocked,
      confirmWithoutLighting: reason => desktop.confirmPlayWithoutLighting(reason), withoutLightingChoices,
      prepare: async (itemId, positionMs, { reuseSession, mtcOutputEnabled, signal }) => {
        if (useMa2AutoSyncStore.getState().status === 'writing') throw new Error('MA2 正在同步，请等同步完成后再播放');
        if (!path) throw new Error('请先保存工程，再播放');
        if (useIntegrationStore.getState().obs.status !== 'connected') {
          prepared = null;
          throw new Error('OBS 没有连接，可点顶部“一键连接”恢复画面联动');
        }
        await coordinator.prepareInternal(itemId, async (assertCurrent) => {
          if (reuseSession && prepared?.profile === useIntegrationStore.getState().profile && prepared.mtcOutputEnabled === mtcOutputEnabled) {
            coordinator.beginPreflight(prepared.report.mode);
            await coordinator.applyPreflight(prepared.report); assertCurrent(); return prepared.report;
          }
          const report = await runDesktopPreflight(coordinator, 'live', 'internal', false, { internalMtcOutputEnabled: mtcOutputEnabled }, assertCurrent);
          prepared = report.passed ? { report, profile: useIntegrationStore.getState().profile, mtcOutputEnabled } : null;
          return report;
        }, positionMs, signal, message => player.reportUnavailable(message));
      },
      ingest: (positionMs) => coordinator.ingestInternal(positionMs),
      started: (positionMs) => coordinator.startInternalClock(positionMs),
      scrub: project.obsOutputMode === 'scenes' ? (positionMs) => coordinator.seekInternal(positionMs) : undefined,
      pause: reason => coordinator.pauseInternal(reason), stop: reason => coordinator.stopAndWait(false, reason),
      resolveAudio: (relativePath) => {
        if (!path) throw new Error('请先保存工程');
        return desktop.resolveReferenceAudioUrl({ projectPath: path, relativePath });
      },
      configuration: () => {
        const profile = useIntegrationStore.getState().profile;
        const id = profile?.internalPlayer?.mtcOutputPortProfileId;
        const port = id ? profile?.midiPortProfiles.find((entry) => entry.id === id && entry.direction === 'output') : null;
        return { lightingProfile: profile, outputDeviceId: audioConfiguration.deviceId, audioSampleRate: audioConfiguration.sampleRate, mtcPortName: port?.portName ?? null,
          preload: profile?.internalPlayer?.preload ?? true, fadeInMs: profile?.internalPlayer?.fadeInMs ?? 0, fadeOutMs: profile?.internalPlayer?.fadeOutMs ?? 500 };
      }, changed: view.publish,
      // A channel that cannot join repeats song after song until fixed: a warning the first time, then info.
      notice: (message, itemId) => {
        void desktop.recordLog({ level: firstTimeWarning(notedNotices, message), category: 'state', message, projectId: project.projectId,
          ...(itemId ? { itemId } : {}), device: '播放器' })
          .catch((error: unknown) => console.error('正式播放通道提示未能保存到日志', error));
      },
      failed: (message, itemId) => {
        void desktop.recordLog({ level: 'error', category: 'state', message, projectId: project.projectId,
          ...(itemId ? { itemId } : {}), device: '播放器', result: 'failed' })
          .catch((error: unknown) => console.error('正式播放失败未能保存到日志', error));
      },
      preciseSeeking: () => useDisplayPreferences.getState().preciseSeeking,
      obsChanged: status => {
        if (status.state === 'running' || status.state === 'ready') useRuntimeStore.getState().setState({ currentCueId: status.currentCueId });
      }
    };
    const player: ProgramPlayerControls = audioConfiguration.engine === 'native'
      ? new RemoteNativeProgramPlayer(project, path ?? '', useDocumentStore.getState().revision, dependencies, desktop, event => {
        const runtime = useRuntimeStore.getState();
        const status = event.state.status === 'playing' ? 'running' : event.state.status === 'stopped' ? 'idle'
          : event.state.status === 'preparing' ? 'preflight' : event.state.status;
        if (runtime.state !== status || runtime.currentItemId !== event.state.itemId || runtime.currentCueId !== event.currentCueId) {
          runtime.setState({ state: status, currentItemId: event.state.itemId, currentCueId: event.currentCueId, mode: 'live', reason: event.state.error });
        }
      })
      : new InternalPlaybackController(project, dependencies);
    coordinator.onInternalStop(() => player.externalStop());
    const unsubscribe = useRuntimeStore.subscribe((next, previous) => {
      if (next.state !== previous.state && ['error', 'timecodeLost'].includes(next.state)) player.runtimeUnavailable(next.reason ?? '联动已中断');
    });
    // Live: an OBS loss is shown in red; OBS actions fail until the operator
    // reconnects, and MIDI cues and audio keep running.
    const unsubscribeObs = useIntegrationStore.subscribe((next, previous) => {
      if (previous.obs.status === 'connected' && next.obs.status !== 'connected') prepared = null;
      if (player instanceof InternalPlaybackController && previous.obs.status === 'connected' && next.obs.status !== 'connected' && useRuntimeStore.getState().state !== 'idle') {
        player.reportFault('OBS 连接中断，画面动作没有执行。重新连接后会按当前位置恢复画面');
      }
      if (player instanceof InternalPlaybackController && previous.obs.status !== 'connected' && next.obs.status === 'connected' && path) {
        const control = view.readControl();
        void recoverInternalObs({ project, path, status: control.status, itemId: control.itemId, positionMs: view.readClock().positionMs, coordinator, player, notice: (message, itemId) => dependencies.notice?.(message, itemId) });
      }
    });
    const unsubscribeFaults = useRuntimeStore.subscribe((next, previous) => {
      // A rebuild after a position gap carries a reason even when nothing was missed.
      if (next.state === 'running' && (next.missedCueIds.length > previous.missedCueIds.length || next.reason && next.reason !== previous.reason)) {
        const message = next.reason ?? `错过了 ${next.missedCueIds.length} 个联动 Cue，没有补发`;
        dependencies.notice?.(message, next.currentItemId); player.reportFault(message);
      }
      const report = next.reports !== previous.reports ? next.reports.at(-1) : undefined;
      const failed = report?.mode === 'live' ? report.results.find(result => result.status === 'failed') : undefined;
      if (failed) player.reportFault(`联动动作失败：${failed.action.label} · ${failed.error ?? '未知错误'}`);
      const media = next.mediaReports !== previous.mediaReports ? next.mediaReports.at(-1) : undefined;
      if (media?.status === 'failed') player.reportFault(`素材播放失败：${media.event.assetName} · ${media.error ?? '未知错误'}`);
    });
    setController(player); view.publish(emptyInternalPlayerState);
    return () => {
      unsubscribe(); unsubscribeObs(); unsubscribeFaults(); coordinator.onInternalStop(null);
      if (player instanceof RemoteNativeProgramPlayer) void player.dispose().catch(error => dependencies.notice?.(`关闭播放器失败：${toUserErrorMessage(error)}`, null));
      else player.dispose();
    };
  }, [coordinator, project, path, ready, audioConfiguration, view, generation]);
  const engine = internalAudioEngineLabel({ ...engineChoice, engine: audioConfiguration.engine });
  return useMemo(() => ({ controller, state, view, engine }), [controller, state, view, engine]);
}
