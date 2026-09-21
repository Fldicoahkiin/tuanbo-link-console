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
    const input = new PlaybackMidiInput((bytes) => controller.receiveMidi(bytes), (message) => controller.freeze(message));
    void input.connect(controlInputName).catch((error: unknown) => controller.freeze(String(error)));
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
    let prepared: { report: PreflightReport; profile: ReturnType<typeof useIntegrationStore.getState>['profile'] } | null = null;
    const player = new InternalPlaybackController(project, {
      prepare: async (itemId, positionMs, reuseSession) => {
        if (useMa2AutoSyncStore.getState().status === 'writing') throw new Error('MA2 正在同步并回读，请完成后播放');
        if (!path) throw new Error('请先保存工程，再播放正式音频');
        if (useIntegrationStore.getState().obs.status !== 'connected') {
          prepared = null;
          useIntegrationStore.getState().setProcess(await desktop.startExternalApplication('obs'));
          useIntegrationStore.getState().setObs(await desktop.connectObs());
        }
        await coordinator.prepareInternal(itemId, async () => {
          if (reuseSession && prepared?.profile === useIntegrationStore.getState().profile) {
            coordinator.beginPreflight(prepared.report.mode);
            await coordinator.applyPreflight(prepared.report); return prepared.report;
          }
          const report = await runDesktopPreflight(coordinator, 'live', 'internal');
          prepared = report.passed ? { report, profile: useIntegrationStore.getState().profile } : null;
          return report;
        }, positionMs);
      },
      ingest: (positionMs) => coordinator.ingestInternal(positionMs),
      scrub: project.obsOutputMode === 'scenes' ? (positionMs) => coordinator.seekInternal(positionMs) : undefined,
      pause: () => coordinator.pauseInternal(), stop: () => coordinator.stopAndWait(false),
      resolveAudio: (relativePath) => {
        if (!path) throw new Error('请先保存工程');
        return desktop.resolveReferenceAudioUrl({ projectPath: path, relativePath });
      },
      configuration: () => {
        const profile = useIntegrationStore.getState().profile;
        if (!profile) throw new Error('连接配置尚未加载');
        const id = profile.internalPlayer?.mtcOutputPortProfileId;
        const port = id ? profile.midiPortProfiles.find((entry) => entry.id === id && entry.direction === 'output') : null;
        if (id && !port?.portName) throw new Error('灯光 MIDI 输出未配置');
        return { lightingProfile: profile, outputDeviceId: profile.internalPlayer?.audioOutputDeviceId ?? 'default', audioSampleRate: profile.internalPlayer?.audioSampleRate ?? 48000, mtcPortName: port?.portName ?? null,
          preload: profile.internalPlayer?.preload ?? true, fadeInMs: profile.internalPlayer?.fadeInMs ?? 0, fadeOutMs: profile.internalPlayer?.fadeOutMs ?? 500 };
      }, changed: setState
    });
    coordinator.onInternalStop(() => player.externalStop());
    const unsubscribe = useRuntimeStore.subscribe((next, previous) => {
      if (next.state !== previous.state && ['error', 'timecodeLost'].includes(next.state)) player.freeze(next.reason ?? '联动已中断');
    });
    const unsubscribeObs = useIntegrationStore.subscribe((next, previous) => {
      if (previous.obs.status === 'connected' && next.obs.status !== 'connected' && useRuntimeStore.getState().state !== 'idle') {
        prepared = null;
        player.freeze('OBS 连接中断，正式音乐和灯光时间码已停止；重新连接后请明确选择歌曲重播');
        void coordinator.stopAndWait(false).catch((error: unknown) => player.freeze(`OBS 连接中断，音乐与灯光时间码已停止。请在设置中重新连接 OBS，再点停止播放后重播。清理详情：${String(error)}`));
      }
    });
    setController(player); setState(emptyInternalPlayerState);
    return () => { unsubscribe(); unsubscribeObs(); coordinator.onInternalStop(null); player.dispose(); };
  }, [coordinator, project, path, ready, profile?.internalPlayer?.audioSampleRate, profile?.internalPlayer?.audioOutputDeviceId]);
  return { controller, state };
}
