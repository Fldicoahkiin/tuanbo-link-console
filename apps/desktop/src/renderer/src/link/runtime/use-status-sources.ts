import { useEffect } from 'react';
import { loopMidiStatusSchema, ma2NetworkStatusSchema } from '@tb/schema';
import { toUserErrorMessage } from '@tb/core/link';
import { useMa2ModeStore } from '../stores/ma2-mode-store';
import { useIntegrationStore } from '../stores/integration-store';
import { useConnectionCheckStore } from '../stores/connection-check-store';
import { useMa2NetworkStatusStore } from '../stores/ma2-network-status-store';
import { linkDesktopViewModel as desktop } from '../view-models/link-desktop-view-model';
import { assertAudioOutputAvailable } from '../view-models/audio-output-route';

/**
 * The readings behind the status center, taken once for the whole window (they used to be taken by
 * the top bar itself): the console network every second while it is the connection method, the
 * audio output whenever Windows reports a device change, and loopMIDI when its setting changes.
 */
export function useStatusSources(): void {
  const method = useMa2ModeStore(state => state.method);
  const running = useConnectionCheckStore(state => state.running);
  const audioRoute = useIntegrationStore(state => state.profile?.internalPlayer);
  const loopAutoStart = useIntegrationStore(state => state.profile?.loopMidi?.autoStart);
  useEffect(() => {
    if (method !== 'network') { useMa2NetworkStatusStore.setState({ status: null, error: null }); return; }
    let alive = true; let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<void> => {
      try {
        const status = ma2NetworkStatusSchema.parse(await desktop.getMa2NetworkStatus());
        if (!alive) return;
        useMa2NetworkStatusStore.setState({ status, error: null });
        timer = setTimeout(() => void read(), 1000);
      } catch (error) { if (alive) useMa2NetworkStatusStore.setState({ error: toUserErrorMessage(error) }); }
    };
    void read(); return () => { alive = false; clearTimeout(timer); };
  }, [method, running]);
  useEffect(() => {
    let alive = true;
    const inspect = async (): Promise<void> => {
      try {
        await assertAudioOutputAvailable(audioRoute);
        if (!alive || useConnectionCheckStore.getState().running) return;
        useConnectionCheckStore.getState().finish('audio', 'ready', '音频设备可用，播放时开始输出');
      } catch (error) { if (alive && !useConnectionCheckStore.getState().running) useConnectionCheckStore.getState().finish('audio', 'error', toUserErrorMessage(error)); }
    };
    const changed = (): void => { void inspect(); };
    changed(); navigator.mediaDevices.addEventListener('devicechange', changed);
    return () => { alive = false; navigator.mediaDevices.removeEventListener('devicechange', changed); };
  }, [audioRoute]);
  useEffect(() => {
    let alive = true;
    void desktop.loopMidi('detect').then(value => {
      const status = loopMidiStatusSchema.parse(value);
      if (alive && !useConnectionCheckStore.getState().running) useConnectionCheckStore.getState().finish('loop', status.state === 'running' ? 'ready' : loopAutoStart ? 'error' : 'skipped', status.state === 'running' ? 'loopMIDI 已运行，端口另外检查' : loopAutoStart ? '虚拟 MIDI 未启动，点“一键连接”启动' : '没有开启虚拟 MIDI 自动启动；用实体 MIDI 接口不受影响');
    }).catch((error: unknown) => { if (alive && !useConnectionCheckStore.getState().running) useConnectionCheckStore.getState().finish('loop', 'error', toUserErrorMessage(error)); });
    return () => { alive = false; };
  }, [loopAutoStart]);
}
