import { useEffect } from 'react';
import type { LinkRuntimeCoordinator } from './runtime/link-runtime-coordinator';
import { runDesktopPreflight } from './view-models/link-preflight-view-model';

export function useP1AutoFollow(coordinator: LinkRuntimeCoordinator | null, ready: boolean, enabled: boolean,
  notify: (message: string, tone?: 'info' | 'error') => void): void {
  useEffect(() => {
    if (!coordinator || !ready || !enabled) return;
    void coordinator.enableP1AutoFollow(() => runDesktopPreflight(coordinator, 'live', 'awaiting-external-start', true))
      .catch((error: unknown) => notify(`P1 自动监听失败：${error instanceof Error ? error.message : String(error)}`, 'error'));
  }, [coordinator, ready, enabled, notify]);
}
