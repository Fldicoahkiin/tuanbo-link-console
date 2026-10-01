import type { LinkProject } from '@tb/schema';
import type { PreflightReport } from '@tb/core/link';
import { useEffect, useState } from 'react';
import { PlaybackMidiInput } from '../registry/playback-midi-input';
import { InternalPlaybackController, emptyInternalPlayerState } from './runtime/internal-playback-controller';
import type { LinkRuntimeCoordinator } from './runtime/link-runtime-coordinator';
import { useDocumentStore } from './stores/document-store';
import { useIntegrationStore } from './stores/integration-store';
import { linkDesktopViewModel as desktop } from './view-models/link-desktop-view-model';
import { runDesktopPreflight } from './view-models/link-preflight-view-model';
import { useRuntimeStore } from './stores/runtime-store';
import { useMa2AutoSyncStore } from './runtime/use-ma2-auto-sync';

export function useInternalPlayer(coordinator: LinkRuntimeCoordinator | null, ready: boolean, project: LinkProject | null) {
  const path = useDocumentStore((state) => state.path);
  const [controller, setController] = useState<InternalPlaybackController | null>(null);
  const [state, setState] = useState(emptyInternalPlayerState);
  const profile = useIntegrationStore((value) => value.profile);
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
      setController(null); setState(emptyInternalPlayerState); return;
    }
    let prepared: { report: PreflightReport; profile: ReturnType<typeof useIntegrationStore.getState>['profile']; mtcOutputEnabled: boolean } | null = null;
    const player = new InternalPlaybackController(project, {
      prepare: async (itemId, positionMs, { reuseSession, mtcOutputEnabled }) => {
        if (useMa2AutoSyncStore.getState().status === 'writing') throw new Error('MA2 正在同步并回读，请完成后播放');
        if (!path) throw new Error('请先保存工程，再播放正式音频');
        if (useIntegrationStore.getState().obs.status !== 'connected') {
          prepared = null;
          throw new Error('OBS 未连接；可用顶部“一键连接”恢复画面联动');
        }
        await coordinator.prepareInternal(itemId, async () => {
          if (reuseSession && prepared?.profile === useIntegrationStore.getState().profile && prepared.mtcOutputEnabled === mtcOutputEnabled) {
            coordinator.beginPreflight(prepared.report.mode);
            await coordinator.applyPreflight(prepared.report); return prepared.report;
          }
          const report = await runDesktopPreflight(coordinator, 'live', 'internal', false, { internalMtcOutputEnabled: mtcOutputEnabled });
          prepared = report.passed ? { report, profile: useIntegrationStore.getState().profile, mtcOutputEnabled } : null;
          return report;
        }, positionMs);
      },
      ingest: (positionMs) => coordinator.ingestInternal(positionMs),
      started: (positionMs) => coordinator.startInternalClock(positionMs),
      scrub: project.obsOutputMode === 'scenes' ? (positionMs) => coordinator.seekInternal(positionMs) : undefined,
      pause: () => coordinator.pauseInternal(), stop: () => coordinator.stopAndWait(false),
      resolveAudio: (relativePath) => {
        if (!path) throw new Error('请先保存工程');
        return desktop.resolveReferenceAudioUrl({ projectPath: path, relativePath });
      },
      configuration: () => {
        const profile = useIntegrationStore.getState().profile;
        const id = profile?.internalPlayer?.mtcOutputPortProfileId;
        const port = id ? profile?.midiPortProfiles.find((entry) => entry.id === id && entry.direction === 'output') : null;
        return { lightingProfile: profile, outputDeviceId: profile?.internalPlayer?.audioOutputDeviceId ?? 'default', audioSampleRate: profile?.internalPlayer?.audioSampleRate ?? 48000, mtcPortName: port?.portName ?? null,
          preload: profile?.internalPlayer?.preload ?? true, fadeInMs: profile?.internalPlayer?.fadeInMs ?? 0, fadeOutMs: profile?.internalPlayer?.fadeOutMs ?? 500 };
      }, changed: setState
    });
    coordinator.onInternalStop(() => player.externalStop());
    const unsubscribe = useRuntimeStore.subscribe((next, previous) => {
      if (next.state !== previous.state && ['error', 'timecodeLost'].includes(next.state)) player.runtimeUnavailable(next.reason ?? '联动已中断');
    });
    const unsubscribeObs = useIntegrationStore.subscribe((next, previous) => {
      if (previous.obs.status === 'connected' && next.obs.status !== 'connected' && useRuntimeStore.getState().state !== 'idle') {
        prepared = null;
        player.runtimeUnavailable('OBS 连接中断；音频继续播放，画面与 OBS 动作已停止。');
        void coordinator.stopAndWait(false).catch((error: unknown) => player.reportUnavailable(`OBS 清理失败：${String(error)}`));
      }
    });
    setController(player); setState(emptyInternalPlayerState);
    return () => { unsubscribe(); unsubscribeObs(); coordinator.onInternalStop(null); player.dispose(); };
  }, [coordinator, project, path, ready, profile?.internalPlayer?.audioSampleRate, profile?.internalPlayer?.audioOutputDeviceId]);
  return { controller, state };
}
