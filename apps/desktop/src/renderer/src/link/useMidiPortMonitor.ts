import { useEffect, useState } from 'react';
import { LinkMidiAdapter } from '../registry/link-midi-adapter';
import { useIntegrationStore } from './stores/integration-store';
import { useConnectionCheckStore } from './stores/connection-check-store';
import { toUserErrorMessage } from '@tb/core/link';
import { linkDesktopViewModel } from './view-models/link-desktop-view-model';
import { readNativeDevices } from './view-models/midi-device-inventory';

/** Observe ports for the entire application lifetime, independently of the settings page. */
export function useMidiPortMonitor(notify: (message: string, tone?: 'info' | 'error') => void): LinkMidiAdapter {
  const [monitor] = useState(() => new LinkMidiAdapter(id => useIntegrationStore.getState().profile?.midiPortProfiles.find(port => port.id === id) ?? null, (error) => notify(error.message, 'error')));
  useEffect(() => {
    let cancelled = false;
    const unsubscribe = monitor.subscribePorts((ports) => {
      useIntegrationStore.getState().setMidiPorts(ports);
      // Windows reports a MIDI interface change here; native outputs are listed separately, so read them again (enumeration only).
      void readNativeDevices().catch((error: unknown) => linkDesktopViewModel.recordLog({ level: 'warning', category: 'device', device: 'midi',
        message: `Windows MIDI 设备重新读取失败：${toUserErrorMessage(error)}`, result: 'failed' }).catch(console.error));
    });
    void monitor.initialize().then((ports) => {
      if (!cancelled) {
        useIntegrationStore.getState().setMidiPorts(ports);
        if (!useConnectionCheckStore.getState().running) useConnectionCheckStore.getState().finish('midi', 'ready', '系统 MIDI 检测通过');
      }
    }).catch((error: unknown) => {
      if (!cancelled) {
        const message = toUserErrorMessage(error);
        if (!useConnectionCheckStore.getState().running) useConnectionCheckStore.getState().finish('midi', 'error', message);
        void linkDesktopViewModel.recordLog({ level: 'warning', category: 'device', device: 'midi', message, result: 'failed' }).catch(console.error);
      }
    });
    return () => { cancelled = true; unsubscribe(); monitor.dispose(); };
  }, [monitor, notify]);
  return monitor;
}
