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
  const assets = project?.mediaAssets;
  useEffect(() => {
    let cancelled = false;
    setAvailability(null);
    if (!projectPath || !assets) return;
    const inspect = async (): Promise<void> => {
      const result: LinkProjectAssetInspection['media'] = {};
      for (let offset = 0; offset < assets.length && !cancelled; offset += 128) {
        const chunk = assets.slice(offset, offset + 128).map(({ id, relativePath, sha256, name }) => ({ id, relativePath, sha256, name }));
        Object.assign(result, await linkDesktopViewModel.inspectMediaAssets({ projectPath, assets: chunk }));
        if (!cancelled) setAvailability({ ...result });
      }
    };
    void inspect()
      .catch((error: unknown) => {
        if (!cancelled) notify(`资源可用性检查失败：${error instanceof Error ? error.message : String(error)}`, 'error');
      });
    return () => { cancelled = true; };
  }, [notify, assets, projectPath]);
  return availability;
}
