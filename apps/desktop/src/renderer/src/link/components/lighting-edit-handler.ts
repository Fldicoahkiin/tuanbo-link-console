import { setLightingCommand } from '@tb/core/link';
import type { LightingDocument, LinkProject } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
/** Editing only changes the saved document; the running output keeps its snapshot. */
export function lightingEditHandler({ itemId, project, notify }: { itemId: string | null; project: LinkProject | null; notify: (message: string, tone?: 'info' | 'error') => void }) {
  return (document: LightingDocument, label: string): void => {
    if (!itemId) return;
    try {
      if (useDocumentStore.getState().project !== project) throw new Error('工程在操作期间已改变，请重新修改');
      useDocumentStore.getState().execute(setLightingCommand(itemId, document, label));
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
  };
}
