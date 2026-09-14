import { useCallback, useEffect } from 'react';
import { create } from 'zustand';
import { useDocumentStore } from './stores/document-store';

type Notify = (message: string, tone?: 'info' | 'error') => void;
const useSelectionStore = create<{ byProject: Record<string, string | null>; set: (projectId: string, itemId: string | null) => void }>((set) => ({
  byProject: {},
  set: (projectId, itemId) => set((state) => ({ byProject: { ...state.byProject, [projectId]: itemId } }))
}));
const key = (id: string): string => `tblink.selected-program.v1.${id}`;

export function useSelectedProgram(notify: Notify): readonly [string | null, (itemId: string | null) => void] {
  const project = useDocumentStore((state) => state.project);
  const remembered = useSelectionStore((state) => project ? state.byProject[project.projectId] : undefined);
  const selected = project?.rundown.find((item) => item.id === remembered)?.id ?? project?.rundown[0]?.id ?? null;
  const select = useCallback((itemId: string | null): void => {
    const current = useDocumentStore.getState().project;
    if (!current || (itemId && !current.rundown.some((item) => item.id === itemId))) return;
    useSelectionStore.getState().set(current.projectId, itemId);
    try { if (itemId) localStorage.setItem(key(current.projectId), itemId); else localStorage.removeItem(key(current.projectId)); }
    catch (error) { notify(`保存当前节目失败：${String(error)}`, 'error'); }
  }, [notify]);
  useEffect(() => {
    if (!project) return;
    if (remembered !== undefined) {
      if (remembered !== selected) select(selected);
      return;
    }
    let saved: string | null = null;
    try { saved = localStorage.getItem(key(project.projectId)); }
    catch (error) { notify(`恢复上次节目失败：${String(error)}`, 'error'); }
    useSelectionStore.getState().set(project.projectId, project.rundown.find((item) => item.id === saved)?.id ?? project.rundown[0]?.id ?? null);
  }, [notify, project, remembered, select, selected]);
  return [selected, select] as const;
}
