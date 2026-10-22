import type { LinkProjectFile } from '@tb/core/link';
import { useDocumentStore } from './stores/document-store';
import { linkDesktopViewModel } from './view-models/link-desktop-view-model';

/** Shows an opened file; a recovery copy with unsaved edits is offered first. */
export async function showOpenedProject(file: LinkProjectFile): Promise<'opened' | 'restored'> {
  const restored = await linkDesktopViewModel.resolveRecoveryCopy({ version: 1, projectPath: file.path, projectId: file.project.projectId });
  if (restored) {
    useDocumentStore.getState().setProject(restored, file.path, { restored: true });
    return 'restored';
  }
  useDocumentStore.getState().setProject(file.project, file.path);
  return 'opened';
}

/** At startup, before reopening the last file: an unnamed project's unsaved edits, if the operator restores them. */
export async function restoreUnnamedProject(): Promise<string | null> {
  const restored = await linkDesktopViewModel.resolveRecoveryCopy({ version: 1, projectPath: null });
  if (!restored) return null;
  useDocumentStore.getState().setProject(restored, null, { restored: true });
  return restored.name;
}
