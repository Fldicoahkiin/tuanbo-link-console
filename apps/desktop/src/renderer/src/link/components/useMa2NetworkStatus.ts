import { useEffect, useRef, useState } from 'react';
import { ma2NetworkStatusSchema, type Ma2NetworkSettings, type Ma2NetworkStatus } from '@tb/schema';

export function useMa2NetworkStatus(revision: number, initialize: (settings: Ma2NetworkSettings) => void,
  failed: (message: string) => void) {
  const [status, setStatus] = useState<Ma2NetworkStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pluginReady, setPluginReady] = useState(false);
  const callbacks = useRef({ initialize, failed });
  useEffect(() => { callbacks.current = { initialize, failed }; }, [initialize, failed]);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (initial: boolean): Promise<void> => {
      try {
        const next = ma2NetworkStatusSchema.parse(await window.tbLink.getMa2NetworkStatus());
        if (!alive) return;
        setStatus(next);
        if (initial) { if (next.settings) callbacks.current.initialize(next.settings); setLoaded(true); }
        // Poll status only; never issue another connection or plugin probe.
        setPluginReady(next.state === 'connected' && Boolean(next.capabilities?.plugin && next.capabilities.objects && next.capabilities.files));
        timer = setTimeout(() => void read(false), 1000);
      } catch (error) {
        if (alive) callbacks.current.failed(`读取 MA2 连接状态失败：${error instanceof Error ? error.message : String(error)}`);
      }
    };
    void read(true);
    return () => { alive = false; clearTimeout(timer); };
  }, [revision]);
  return { status, setStatus, loaded, pluginReady, setPluginReady };
}
