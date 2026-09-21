import { useEffect, useState } from 'react';
import { LinkMidiAdapter } from '../registry/link-midi-adapter';
import { useIntegrationStore } from './stores/integration-store';

/** Observe ports for the entire application lifetime, independently of the settings page. */
export function useMidiPortMonitor(notify: (message: string, tone?: 'info' | 'error') => void): LinkMidiAdapter {
  const [monitor] = useState(() => new LinkMidiAdapter(id => useIntegrationStore.getState().profile?.midiPortProfiles.find(port => port.id === id) ?? null, (error) => notify(error.message, 'error')));
  useEffect(() => {
    let cancelled = false;
    const unsubscribe = monitor.subscribePorts((ports) => useIntegrationStore.getState().setMidiPorts(ports));
    void monitor.initialize().then((ports) => {
      if (!cancelled) useIntegrationStore.getState().setMidiPorts(ports);
    }).catch((error: unknown) => {
      if (!cancelled) notify(error instanceof Error ? error.message : String(error), 'error');
    });
    return () => { cancelled = true; unsubscribe(); monitor.dispose(); };
  }, [monitor, notify]);
  return monitor;
}
