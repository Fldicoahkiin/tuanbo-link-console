import type { LinkProject } from '@tb/schema';
import type { PreflightReport } from '@tb/core/link';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { PlayerViewStore } from './stores/player-view-store';
import { PlaybackMidiInput } from '../registry/playback-midi-input';
import { InternalPlaybackController, emptyInternalPlayerState, type InternalPlayerDependencies } from './runtime/internal-playback-controller';
import { toUserErrorMessage } from '@tb/core/link';
import { RemoteNativeProgramPlayer } from './runtime/remote-native-program-player';
import type { ProgramPlayerControls } from './runtime/program-player-controls';
import type { LinkRuntimeCoordinator } from './runtime/link-runtime-coordinator';
import { useDocumentStore } from './stores/document-store';
import { useIntegrationStore } from './stores/integration-store';
import { linkDesktopViewModel as desktop } from './view-models/link-desktop-view-model';
import { runDesktopPreflight } from './view-models/link-preflight-view-model';
import { useRuntimeStore } from './stores/runtime-store';
import { useMa2AutoSyncStore } from './runtime/use-ma2-auto-sync';
import { useDisplayPreferences } from './stores/display-preferences-store';
import { useSelectedProgram } from './useSelectedProgram';

export function useInternalPlayer(coordinator: LinkRuntimeCoordinator | null, ready: boolean, project: LinkProject | null) {
  const path = useDocumentStore((state) => state.path);
  const [controller, setController] = useState<ProgramPlayerControls | null>(null);
  const [view] = useState(() => new PlayerViewStore());
  const state = useSyncExternalStore(view.subscribeControl, view.readControl);
  const profile = useIntegrationStore((value) => value.profile);
  const obsStatus = useIntegrationStore(value => value.obs.status);
  const notifySelection = useCallback((message: string) => controller?.reportUnavailable(message), [controller]);
  const [selectedItemId] = useSelectedProgram(notifySelection);
  useEffect(() => {
    if (controller instanceof RemoteNativeProgramPlayer && obsStatus === 'connected' && selectedItemId) controller.preloadSelected(selectedItemId);
  }, [controller, obsStatus, selectedItemId]);
  const requestedEngine = profile?.internalPlayer?.audioEngine ?? 'browser';
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
      if (key === 'Ctrl+KeyM') { event.preventDefault(); controller.toggleMtc(); return; }
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
      prepare: async (itemId, positionMs, { reuseSession, mtcOutputEnabled, signal }) => {
        if (useMa2AutoSyncStore.getState().status === 'writing') throw new Error('MA2 正在同步并回读，请完成后播放');
        if (!path) throw new Error('请先保存工程，再播放正式音频');
        if (useIntegrationStore.getState().obs.status !== 'connected') {
          prepared = null;
          throw new Error('OBS 未连接；可用顶部“一键连接”恢复画面联动');
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
      notice: (message, itemId) => {
        void desktop.recordLog({ level: 'warning', category: 'state', message, projectId: project.projectId,
          ...(itemId ? { itemId } : {}), device: '正式播放器' })
          .catch((error: unknown) => console.error('正式播放通道提示未能保存到日志', error));
      },
      failed: (message, itemId) => {
        void desktop.recordLog({ level: 'error', category: 'state', message, projectId: project.projectId,
          ...(itemId ? { itemId } : {}), device: '正式播放器', result: 'failed' })
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
    const unsubscribeObs = useIntegrationStore.subscribe((next, previous) => {
      if (audioConfiguration.engine !== 'native' && previous.obs.status === 'connected' && next.obs.status !== 'connected' && useRuntimeStore.getState().state !== 'idle') {
        prepared = null;
        player.runtimeUnavailable('OBS 连接中断；音频继续播放，画面与 OBS 动作已停止。');
        void coordinator.stopAndWait(false, 'OBS 连接断开').catch((error: unknown) => player.reportUnavailable(`OBS 清理失败：${String(error)}`));
      }
    });
    setController(player); view.publish(emptyInternalPlayerState);
    return () => {
      unsubscribe(); unsubscribeObs(); coordinator.onInternalStop(null);
      if (player instanceof RemoteNativeProgramPlayer) void player.dispose().catch(error => dependencies.notice?.(`关闭播放器失败：${toUserErrorMessage(error)}`, null));
      else player.dispose();
    };
  }, [coordinator, project, path, ready, audioConfiguration, view]);
  return useMemo(() => ({ controller, state, view }), [controller, state, view]);
}
