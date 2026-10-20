import { create } from 'zustand';
import { useDocumentStore } from '../stores/document-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { reportCoordinatorError } from './runtime-action-log';

export const useMa2LocalSaveStore = create<{ saving: boolean; error: string | null }>(() => ({ saving: false, error: null }));
let saving = false;
let failedRevision = '';

/** Local durability runs independently of console availability and synchronization. */
export async function savePendingMa2Edits(): Promise<void> {
  const state = useDocumentStore.getState();
  if (!state.dirty && useMa2LocalSaveStore.getState().error) useMa2LocalSaveStore.setState({ error: null });
  if (saving || !state.project || !state.path || !state.dirty || !state.project.rundown.some(item => item.lighting)) return;
  const revision = `${state.documentId}:${state.revision}`;
  if (failedRevision === revision) return;
  saving = true;
  useMa2LocalSaveStore.setState({ saving: true, error: null });
  try {
    const path = await linkDesktopViewModel.saveProject(state.path, state.project);
    if (!path) throw new Error('工程保存未完成，当前修改仍在内存中');
    useDocumentStore.getState().markSaved(path, state.revision, state.documentId);
    failedRevision = '';
  } catch (cause) {
    failedRevision = revision;
    const message = `本地保存未完成：${cause instanceof Error ? cause.message : String(cause)}`;
    if (useDocumentStore.getState().documentId === state.documentId) useMa2LocalSaveStore.setState({ error: message });
    reportCoordinatorError(message, reason => useMa2LocalSaveStore.setState({ error: reason }));
  } finally {
    saving = false;
    useMa2LocalSaveStore.setState({ saving: false });
  }
}
