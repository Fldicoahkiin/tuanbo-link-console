import type { LinkProject } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { projectCodec } from '../stores/project-codec';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';

/** The archive's path, or null when automatic archiving is switched off on this computer. */
export async function archiveMa2Project(documentId: number, project: LinkProject, reason: 'manual' | 'before-sync' = 'before-sync'): Promise<string | null> {
  const state = useDocumentStore.getState();
  if (state.documentId !== documentId || !state.path) throw new Error('请先保存当前工程，再同步或创建存档');
  const content = await projectCodec.encode(project);
  if (useDocumentStore.getState().documentId !== documentId) throw new Error('工程已切换，存档已取消');
  const result = await linkDesktopViewModel.projectArchives({ version: 1, action: 'create', projectPath: state.path, content, reason });
  if (result.disabled) return null;
  if (!result.createdPath) throw new Error('存档没有确认，还没写入控台');
  return result.createdPath;
}
