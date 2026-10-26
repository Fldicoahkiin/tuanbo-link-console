import { useIntegrationStore } from './stores/integration-store';
import { linkDesktopViewModel as desktop } from './view-models/link-desktop-view-model';

export function subscribeObsSceneSync(notify: (message: string, tone?: 'info' | 'error') => void): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let version = 0;
  const refresh = (): void => {
    const requestVersion = ++version;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (cancelled || useIntegrationStore.getState().obs.status !== 'connected') return;
      void desktop.readObsInventory().then((inventory) => {
        if (!cancelled && requestVersion === version) useIntegrationStore.getState().setInventory(inventory);
      }).catch((error: unknown) => {
        if (cancelled || requestVersion !== version) return;
        useIntegrationStore.getState().setInventory(null);
        const message = `OBS 场景同步失败：${error instanceof Error ? error.message : String(error)}。请检查 OBS 连接后点“刷新”。`;
        notify(message, 'error');
        void desktop.recordLog({ level: 'error', category: 'device', device: 'obs', result: 'failed', message })
          .catch((logError: unknown) => { if (!cancelled) notify(`场景同步日志写入失败：${String(logError)}`, 'error'); });
      });
    }, 100);
  };
  const unsubscribeInventory = desktop.onObsInventoryChanged(refresh);
  const unsubscribeStatus = desktop.onObsStatus((snapshot) => {
    if (snapshot.status === 'connected') refresh();
    else { ++version; useIntegrationStore.getState().setInventory(null); }
  });
  return () => { cancelled = true; if (timer) clearTimeout(timer); unsubscribeInventory(); unsubscribeStatus(); };
}
