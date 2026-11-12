import type { LinkProject } from '@tb/schema';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { PlayerViewStore } from './stores/player-view-store';
import { PlaybackMidiInput } from '../registry/playback-midi-input';
import { emptyInternalPlayerState, firstTimeWarning, mtcOutputSettings, toUserErrorMessage } from '@tb/core/link';
import { RemoteNativeProgramPlayer, type RemotePlayerDependencies } from './runtime/remote-native-program-player';
import { programVersionKey, type ProgramDocument } from './runtime/program-document-feed';
import { programDocumentCodec } from './stores/project-codec';
import { playerEngineLabel } from './view-models/internal-audio-engine';
import type { LinkRuntimeCoordinator } from './runtime/link-runtime-coordinator';
import { useDocumentStore } from './stores/document-store';
import { useIntegrationStore } from './stores/integration-store';
import { linkDesktopViewModel as desktop } from './view-models/link-desktop-view-model';
import { useRuntimeStore } from './stores/runtime-store';
import { useDisplayPreferences } from './stores/display-preferences-store';
import { useSelectedProgram } from './useSelectedProgram';
import { useKeyCommands, useSongShortcuts } from './keys/useKeyCommands';
import { programPlays } from './program-attachment';

/** Player notices already logged as warnings in this window. */
const notedNotices = new Set<string>();

/** The device settings the program plays with, as they are now. The program keeps a song's sound card until the song
 * ends (NativeProgramPlayer.runOutput), so a change made while one plays is heard from the next song on. */
export function programConfiguration(): ReturnType<RemotePlayerDependencies['configuration']> {
  const profile = useIntegrationStore.getState().profile;
  const mtc = mtcOutputSettings(profile);
  return { lightingProfile: profile, outputDeviceId: profile?.internalPlayer?.nativeAudioOutputDeviceId ?? 'default',
    audioSampleRate: profile?.internalPlayer?.audioSampleRate ?? 48000, mtcPortName: mtc.portName, mtcSendMode: mtc.sendMode,
    preload: profile?.internalPlayer?.preload ?? true, fadeInMs: profile?.internalPlayer?.fadeInMs ?? 0, fadeOutMs: profile?.internalPlayer?.fadeOutMs ?? 500 };
}

/** The window's project as the program gets it (the document store, 0.5.9 S7); null when it follows P1 or none is open. */
export function programDocument(): ProgramDocument | null {
  const { project, path, sessionId, revision } = useDocumentStore.getState();
  return project?.playbackSource === 'internal' ? { project, path: path ?? '', sessionId, revision } : null;
}

/** The whole project for the program, off the window's thread (0.5.9 S9). A worker that stopped (it failed or took too
 * long, said in red with that send) starts again at the next send, which the operator's next edit or play makes. */
export function encodeProgramDocument(project: LinkProject): Promise<string> {
  if (programDocumentCodec.failureReason() !== null) programDocumentCodec.restart();
  return programDocumentCodec.encode(project);
}

/** `project`: the project the window shows the player with (LinkApp keeps it until 停止); the program itself gets every
 * version from the document store (RemoteNativeProgramPlayer.documentChanged). */
export function useInternalPlayer(coordinator: LinkRuntimeCoordinator | null, ready: boolean, project: LinkProject | null) {
  const [controller, setController] = useState<RemoteNativeProgramPlayer | null>(null);
  const [view] = useState(() => new PlayerViewStore());
  const state = useSyncExternalStore(view.subscribeControl, view.readControl);
  // The versions the program last named (NativeProgramEvent.documentVersion and pictureVersion), and how many opens it answered.
  const [programVersion, setProgramVersion] = useState<string | null>(null);
  const [attachments, setAttachments] = useState(0);
  const plays = programPlays(controller, programVersion, attachments);
  const profile = useIntegrationStore((value) => value.profile);
  const obsStatus = useIntegrationStore(value => value.obs.status);
  const notifySelection = useCallback((message: string) => controller?.reportUnavailable(message), [controller]);
  const [selectedItemId] = useSelectedProgram(notifySelection);
  useEffect(() => {
    // Also each time the program takes a newer version: the selected song is prepared as it is now.
    if (obsStatus === 'connected' && selectedItemId) controller?.preloadSelected(selectedItemId);
  }, [controller, obsStatus, selectedItemId, programVersion]);
  useEffect(() => {
    if (!controller) return;
    // The device settings changed: the program plays the next song with them (a song held keeps its sound card).
    let last = JSON.stringify(programConfiguration());
    return useIntegrationStore.subscribe(() => {
      const next = JSON.stringify(programConfiguration());
      if (next !== last) { last = next; controller.configure(); }
    });
  }, [controller]);
  const controlInputName = profile?.midiPortProfiles.find((entry) => entry.id === profile.internalPlayer?.controlInputPortProfileId)?.portName;
  useEffect(() => {
    if (!controller || !controlInputName) return;
    const input = new PlaybackMidiInput((bytes) => controller.receiveMidi(bytes), (message) => controller.reportUnavailable(`播放控制 MIDI 不可用：${message}`));
    void input.connect(controlInputName).catch((error: unknown) => controller.reportUnavailable(`播放控制 MIDI 不可用：${String(error)}`));
    return () => input.dispose();
  }, [controller, controlInputName]);
  // The window's playback keys while 联动台播放 plays the show (keys/key-router.ts): Escape stops, Space presses the
  // play button of the page on screen (its own registration; a page without one does nothing), ↑↓ go to the previous or
  // next song when that is turned on, a song's own shortcut plays that song.
  const keys = controller && project ? { controller } : null;
  useKeyCommands('global', keys && {
    'transport.stop': () => void keys.controller.stop(),
    'transport.playPause': () => undefined
  });
  useKeyCommands('global', keys && {
    'home.prevSong': () => void keys.controller.skip(-1),
    'home.nextSong': () => void keys.controller.skip(1)
  }, () => useIntegrationStore.getState().profile?.internalPlayer?.arrowKeyPlayback === true);
  // A song's shortcut as the window has it now (0.5.9 S8a): `project` stays the one shown until 停止, and a song deleted,
  // turned off or given another key meanwhile must not be played by its old key.
  useSongShortcuts(keys && {
    find: key => useDocumentStore.getState().project?.rundown.find((entry) => entry.enabled && entry.playback?.shortcut === key)?.id,
    play: itemId => void keys.controller.play(itemId)
  });
  const internal = coordinator !== null && project?.playbackSource === 'internal';
  // One program per window page (0.5.9 S7): opened once, sent each newer version of the project, so editing never closes
  // or opens it. It closes when the window leaves 联动台播放 (P1, no project, or the page goes).
  useEffect(() => {
    if (!internal || !ready) {
      setController(null); setProgramVersion(null); view.publish(emptyInternalPlayerState); return;
    }
    // The main-process program host prepares audio, OBS, MIDI and lighting; this window only configures and observes it.
    const dependencies: RemotePlayerDependencies = {
      configuration: programConfiguration, changed: view.publish, document: programDocument, encode: encodeProgramDocument,
      // A channel that cannot join repeats song after song until fixed: a warning the first time, then info.
      notice: (message, itemId) => {
        const projectId = useDocumentStore.getState().project?.projectId;
        void desktop.recordLog({ level: firstTimeWarning(notedNotices, message), category: 'state', message, ...(projectId ? { projectId } : {}),
          ...(itemId ? { itemId } : {}), device: '播放器' })
          .catch((error: unknown) => console.error('正式播放通道提示未能保存到日志', error));
      },
      preciseSeeking: () => useDisplayPreferences.getState().preciseSeeking,
      attached: () => setAttachments(value => value + 1)
    };
    const player = new RemoteNativeProgramPlayer(dependencies, desktop, event => {
      setProgramVersion(`${programVersionKey(event.documentVersion)} ${programVersionKey(event.pictureVersion)}`);
      const runtime = useRuntimeStore.getState();
      const status = event.state.status === 'playing' ? 'running' : event.state.status === 'stopped' ? 'idle'
        : event.state.status === 'preparing' ? 'preflight' : event.state.status;
      if (runtime.state !== status || runtime.currentItemId !== event.state.itemId || runtime.currentCueId !== event.currentCueId) {
        runtime.setState({ state: status, currentItemId: event.state.itemId, currentCueId: event.currentCueId, mode: 'live', reason: event.state.error });
      }
    });
    const unsubscribeDocument = useDocumentStore.subscribe(() => player.documentChanged());
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
    setController(player); setProgramVersion(null); view.publish(emptyInternalPlayerState);
    return () => {
      unsubscribeDocument(); unsubscribe(); unsubscribeFaults();
      void player.dispose().catch(error => dependencies.notice(`关闭播放器失败：${toUserErrorMessage(error)}`, null));
    };
  }, [internal, ready, view]);
  // The coordinator is made again with each project the window shows; the program stays (0.5.9 S7).
  useEffect(() => {
    if (!coordinator || !controller) return;
    coordinator.onInternalStop(() => controller.externalStop());
    return () => coordinator.onInternalStop(null);
  }, [coordinator, controller]);
  const engine = playerEngineLabel(profile, project);
  // `programProject`: the newest version the program holds; `pictureProject`: the one the song on stage follows (0.5.9 S8a).
  const { outdated, project: programProject, pictureProject } = plays;
  return useMemo(() => ({ controller, state, view, engine, outdated, programProject, pictureProject }), [controller, state, view, engine, outdated, programProject, pictureProject]);
}
