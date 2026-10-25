import { useEffect, useState } from 'react';
import type { LinkUpdateStatus } from '@tb/core/link';

/**
 * A newer version this machine can install, or null. It marks 设置 › 外观与更新 › 软件更新 with a dot
 * until the update is installed; a version the license does not cover is not marked.
 */
export function pendingUpdateVersion(status: LinkUpdateStatus | null): string | null {
  if (!status || status.installBlockedReason) return null;
  return status.phase === 'available' || status.phase === 'downloading' || status.phase === 'downloaded' ? status.availableVersion : null;
}

export function usePendingUpdate(): string | null {
  const [status, setStatus] = useState<LinkUpdateStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const desktop = window.tbLink;
    const unsubscribe = desktop.onUpdateStatus(next => { if (alive) setStatus(next); });
    // A status pushed while the first read is in flight is newer than that read.
    desktop.getUpdateStatus().then(next => { if (alive) setStatus(current => current ?? next); },
      (error: unknown) => console.warn('读取更新状态失败，设置里的新版本提示暂不显示', error));
    return () => { alive = false; unsubscribe(); };
  }, []);
  return pendingUpdateVersion(status);
}
