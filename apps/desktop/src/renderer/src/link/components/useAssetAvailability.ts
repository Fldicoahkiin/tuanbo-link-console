import { useEffect, useState } from 'react';
import type { LinkProjectAssetInspection } from '@tb/core/link';
import type { LinkProject } from '@tb/schema';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';

export function useAssetAvailability(
  projectPath: string | null,
  project: LinkProject | null,
  notify: (message: string, tone?: 'info' | 'error') => void
): LinkProjectAssetInspection['media'] | null {
  const [availability, setAvailability] = useState<LinkProjectAssetInspection['media'] | null>(null);
  useEffect(() => {
    let cancelled = false;
    setAvailability(null);
    if (!projectPath || !project) return;
    void linkDesktopViewModel.inspectProjectAssets(projectPath, project)
      .then((inspection) => { if (!cancelled) setAvailability(inspection.media); })
      .catch((error: unknown) => {
        if (!cancelled) notify(`资源可用性检查失败：${error instanceof Error ? error.message : String(error)}`, 'error');
      });
    return () => { cancelled = true; };
  }, [notify, project, projectPath]);
  return availability;
}
