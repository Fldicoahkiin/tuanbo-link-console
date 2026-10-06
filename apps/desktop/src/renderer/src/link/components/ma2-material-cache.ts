import { saveMa2MaterialLibraryCommand } from '@tb/core/link';
import type { Ma2CatalogRequest, Ma2EffectLibrary } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';

type MaterialCache = { source: string; library: Ma2EffectLibrary };

export function loadMa2MaterialCache(projectId: string): MaterialCache | null {
  const project = useDocumentStore.getState().project;
  if (project?.projectId !== projectId) return null;
  const cache = project.ma2MaterialLibrary;
  const scan = project.ma2ReadState;
  if (cache && scan && (cache.source !== scan.source || cache.library.directory.show !== scan.catalog.directory.show || cache.library.directory.generation !== scan.catalog.directory.generation)) return null;
  return cache ?? null;
}

export function rememberMa2MaterialCache(projectId: string, source: Ma2CatalogRequest, library: Ma2EffectLibrary): void {
  const current = useDocumentStore.getState();
  if (current.project?.projectId !== projectId) throw new Error('工程已切换，素材未写入其他工程');
  current.execute(saveMa2MaterialLibraryCommand(source.network ? `${source.network.host}:${source.network.port}` : '本机 onPC', library));
}
