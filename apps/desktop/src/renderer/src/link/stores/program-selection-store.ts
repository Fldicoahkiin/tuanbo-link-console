import { create } from 'zustand';

/** The program open in each project for this session; `useSelectedProgram` also remembers it on this computer. */
export const useProgramSelectionStore = create<{ byProject: Record<string, string | null>; set: (projectId: string, itemId: string | null) => void }>((set) => ({
  byProject: {},
  set: (projectId, itemId) => set((state) => ({ byProject: { ...state.byProject, [projectId]: itemId } }))
}));
