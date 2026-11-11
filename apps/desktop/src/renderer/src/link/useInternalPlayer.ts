import type { LinkProject } from '@tb/schema';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { PlayerViewStore } from './stores/player-view-store';
import { PlaybackMidiInput } from '../registry/playback-midi-input';
import { emptyInternalPlayerState, firstTimeWarning, mtcOutputSettings, toUserErrorMessage } from '@tb/core/link';
import { RemoteNativeProgramPlayer, type RemotePlayerDependencies } from './runtime/remote-native-program-player';
import { songVolumeSync } from './runtime/song-volume-sync';
import { playerEngineLabel } from './view-models/internal-audio-engine';
import { holdsSong } from './view-models/picture-on-air';
import type { LinkRuntimeCoordinator } from './runtime/link-runtime-coordinator';
import { useDocumentStore } from './stores/document-store';
import { useIntegrationStore } from './stores/integration-store';
import { linkDesktopViewModel as desktop } from './view-models/link-desktop-view-model';
import { useRuntimeStore } from './stores/runtime-store';
import { useDisplayPreferences } from './stores/display-preferences-store';
import { useSelectedProgram } from './useSelectedProgram';
import { handlePlaybackKey, keyTarget, modalDialogOpen } from './playback-keys';
import { followAudioConfiguration, openAnswer, playsOutdated, reopensShown, type OpenAnswer } from './program-attachment';

/** Player notices already logged as warnings in this window. */
const notedNotices = new Set<string>();

/** `settingsOpen`: the settings or connection page is on screen, and the window's playback keys wait until it closes. */
export function useInternalPlayer(coordinator: LinkRuntimeCoordinator | null, ready: boolean, project: LinkProject | null, settingsOpen: boolean) {
  const path = useDocumentStore((state) => state.path);
  const [controller, setController] = useState<RemoteNativeProgramPlayer | null>(null);
  const [view] = useState(() => new PlayerViewStore());
  const state = useSyncExternalStore(view.subscribeControl, view.readControl);
  const [generation, setGeneration] = useState(0);
  // The background program answers the open after the state it sends; kept per controller, so it shows while paused
  // too. Null until the controller heard it (program-attachment).
  const [answer, setAnswer] = useState<OpenAnswer<RemoteNativeProgramPlayer> | null>(null);
  const outdated = playsOutdated(controller, answer);
  useEffect(() => {
    // A program taken over after a window reload may play an older document; once it stops, open the shown one.
    if (reopensShown(outdated, state.status)) setGeneration(value => value + 1);
  }, [outdated, state.status]);
  const profile = useIntegrationStore((value) => value.profile);
  const obsStatus = useIntegrationStore(value => value.obs.status);
  const notifySelection = useCallback((message: string) => controller?.reportUnavailable(message), [controller]);
  const [selectedItemId] = useSelectedProgram(notifySelection);
  useEffect(() => {
    if (obsStatus === 'connected' && selectedItemId) controller?.preloadSelected(selectedItemId);
  }, [controller, obsStatus, selectedItemId]);
  const requestedDevice = profile?.internalPlayer?.nativeAudioOutputDeviceId ?? 'default';
  const requestedRate = profile?.internalPlayer?.audioSampleRate ?? 48000;
  const [audioConfiguration, setAudioConfiguration] = useState({ deviceId: requestedDevice, sampleRate: requestedRate });
  // While rendering, not in an effect: the program below must open with the configured output the first time.
  const followed = followAudioConfiguration(audioConfiguration, { deviceId: requestedDevice, sampleRate: requestedRate }, holdsSong(state.status));
  if (followed !== audioConfiguration) setAudioConfiguration(followed);
  const controlInputName = profile?.midiPortProfiles.find((entry) => entry.id === profile.internalPlayer?.controlInputPortProfileId)?.portName;
  useEffect(() => {
    if (!controller || !controlInputName) return;
    const input = new PlaybackMidiInput((bytes) => controller.receiveMidi(bytes), (message) => controller.reportUnavailable(`播放控制 MIDI 不可用：${message}`));
    void input.connect(controlInputName).catch((error: unknown) => controller.reportUnavailable(`播放控制 MIDI 不可用：${String(error)}`));
    return () => input.dispose();
  }, [controller, controlInputName]);
  useEffect(() => {
    if (!controller || !project) return;
    // Volume-only stand-in for the version stream (song-volume-sync): a saved song volume reaches the program at once.
    const sync = songVolumeSync(project, (itemId, volume) => controller.setSongVolume(itemId, volume));
    sync(useDocumentStore.getState().project);
    return useDocumentStore.subscribe(state => sync(state.project));
  }, [controller, project]);
  useEffect(() => {
    if (!controller || !project) return;
    const player = { play: (itemId: string) => void controller.play(itemId), stop: () => void controller.stop(), skip: (direction: -1 | 1) => void controller.skip(direction) };
    const keyboard = (event: KeyboardEvent): void => handlePlaybackKey(event, keyTarget(event), { paused: settingsOpen, modalOpen: modalDialogOpen(document),
      arrowKeys: useIntegrationStore.getState().profile?.internalPlayer?.arrowKeyPlayback === true,
      song: key => project.rundown.find((entry) => entry.enabled && entry.playback?.shortcut === key)?.id }, player);
    window.addEventListener('keydown', keyboard); return () => window.removeEventListener('keydown', keyboard);
  }, [controller, project, settingsOpen]);
  useEffect(() => {
    if (!coordinator || !project || project.playbackSource !== 'internal' || !ready) {
      setController(null); view.publish(emptyInternalPlayerState); return;
    }
    // The main-process program host prepares audio, OBS, MIDI and lighting; this window only configures and observes it.
    const dependencies: RemotePlayerDependencies = {
      configuration: () => {
        const profile = useIntegrationStore.getState().profile;
        const mtc = mtcOutputSettings(profile);
        return { lightingProfile: profile, outputDeviceId: audioConfiguration.deviceId, audioSampleRate: audioConfiguration.sampleRate, mtcPortName: mtc.portName, mtcSendMode: mtc.sendMode,
          preload: profile?.internalPlayer?.preload ?? true, fadeInMs: profile?.internalPlayer?.fadeInMs ?? 0, fadeOutMs: profile?.internalPlayer?.fadeOutMs ?? 500 };
      }, changed: view.publish,
      // A channel that cannot join repeats song after song until fixed: a warning the first time, then info.
      notice: (message, itemId) => {
        void desktop.recordLog({ level: firstTimeWarning(notedNotices, message), category: 'state', message, projectId: project.projectId,
          ...(itemId ? { itemId } : {}), device: '播放器' })
          .catch((error: unknown) => console.error('正式播放通道提示未能保存到日志', error));
      },
      preciseSeeking: () => useDisplayPreferences.getState().preciseSeeking,
      attached: () => setAnswer(openAnswer(player)),
      // The quit closed this program and the operator went back to the app: open a new one, so the next song plays.
      closed: () => setGeneration(value => value + 1)
    };
    const player = new RemoteNativeProgramPlayer(project, path ?? '', useDocumentStore.getState().revision, dependencies, desktop, event => {
      const runtime = useRuntimeStore.getState();
      const status = event.state.status === 'playing' ? 'running' : event.state.status === 'stopped' ? 'idle'
        : event.state.status === 'preparing' ? 'preflight' : event.state.status;
      if (runtime.state !== status || runtime.currentItemId !== event.state.itemId || runtime.currentCueId !== event.currentCueId) {
        runtime.setState({ state: status, currentItemId: event.state.itemId, currentCueId: event.currentCueId, mode: 'live', reason: event.state.error });
      }
    });
    coordinator.onInternalStop(() => player.externalStop());
    const unsubscribe = useRuntimeStore.subscribe((next, previous) => {
      if (next.state !== previous.state && ['error', 'timecodeLost'].includes(next.state)) player.runtimeUnavailable(next.reason ?? '联动已中断');
    });
    const unsubscribeFaults = useRuntimeStore.subscribe((next, previous) => {
      // A rebuild after a position gap carries a reason even when nothing was missed.
      if (next.state === 'running' && (next.missedCueIds.length > previous.missedCueIds.length || next.reason && next.reason !== previous.reason)) {
        const message = next.reason ?? `错过了 ${next.missedCueIds.length} 个联动 Cue，没有补发`;
        dependencies.notice(message, next.currentItemId); player.reportFault(message);
      }
      const report = next.reports !== previous.reports ? next.reports.at(-1) : undefined;
      const failed = report?.mode === 'live' ? report.results.find(result => result.status === 'failed') : undefined;
      if (failed) player.reportFault(`联动动作失败：${failed.action.label} · ${failed.error ?? '未知错误'}`);
      const media = next.mediaReports !== previous.mediaReports ? next.mediaReports.at(-1) : undefined;
      if (media?.status === 'failed') player.reportFault(`素材播放失败：${media.event.assetName} · ${media.error ?? '未知错误'}`);
    });
    setController(player); view.publish(emptyInternalPlayerState);
    return () => {
      unsubscribe(); unsubscribeFaults(); coordinator.onInternalStop(null);
      void player.dispose().catch(error => dependencies.notice(`关闭播放器失败：${toUserErrorMessage(error)}`, null));
    };
  }, [coordinator, project, path, ready, audioConfiguration, view, generation]);
  const engine = playerEngineLabel(profile, project);
  return useMemo(() => ({ controller, state, view, engine, outdated }), [controller, state, view, engine, outdated]);
}
