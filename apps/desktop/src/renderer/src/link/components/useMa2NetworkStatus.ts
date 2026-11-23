import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ma2NetworkStatusSchema, type Ma2NetworkSettings, type Ma2NetworkStatus } from '@tb/schema';

export function useMa2NetworkStatus(revision: number, onSettings: (settings: Ma2NetworkSettings) => void,
  failed: (message: string) => void) {
  const [status, setStatus] = useState<Ma2NetworkStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pluginReady, setPluginReady] = useState(false);
  const callbacks = useRef({ onSettings, failed });
  useLayoutEffect(() => { callbacks.current = { onSettings, failed }; }, [onSettings, failed]);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<void> => {
      try {
        const next = ma2NetworkStatusSchema.parse(await window.tbLink.getMa2NetworkStatus());
        if (!alive) return;
        setStatus(next);
        if (next.settings) callbacks.current.onSettings(next.settings);
        setLoaded(true);
        // Poll status only; never issue another connection or plugin probe.
        setPluginReady(next.state === 'connected' && Boolean(next.capabilities?.plugin && next.capabilities.objects && next.capabilities.files));
        timer = setTimeout(() => void read(), 1000);
      } catch (error) {
        if (alive) { setStatus(null); setPluginReady(false); setLoaded(false); callbacks.current.failed(`读取 MA2 连接状态失败：${error instanceof Error ? error.message : String(error)}`); }
      }
    };
    void read();
    return () => { alive = false; clearTimeout(timer); };
  }, [revision]);
  return { status, setStatus, loaded, pluginReady, setPluginReady };
}
