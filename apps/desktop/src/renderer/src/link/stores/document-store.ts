import { create } from 'zustand';
import { shareProjectStructure } from './share-project-structure';
import { isWorkerValidatedProject } from './project-codec';
import { subscribeWithSelector } from 'zustand/middleware';
import { parseLinkProject, type LinkProject } from '@tb/schema';
import { initializeProjectVisualLayersCommand, needsProjectVisualLayers, setObsOutputModeCommand, withInitialVisualLayers, withMa2PairingValidation, type LinkCommand } from '@tb/core/link';

type HistoryFrame = {
  command: LinkCommand;
  before: LinkProject;
};

export type DocumentStoreState = {
  project: LinkProject | null;
  path: string | null;
  dirty: boolean;
  documentId: number;
  revision: number;
  past: HistoryFrame[];
  future: HistoryFrame[];
  error: string | null;
  setProject: (project: LinkProject | null, path: string | null) => void;
  markSaved: (path?: string, revision?: number, documentId?: number) => void;
  execute: (command: LinkCommand) => void;
  executeForDocument: (documentId: number, command: LinkCommand) => void;
  undo: () => void;
  redo: () => void;
  clearError: () => void;
};

const MAX_HISTORY = 100;

export const useDocumentStore = create<DocumentStoreState>()(
  subscribeWithSelector((set, get) => ({
    project: null,
    path: null,
    dirty: false,
    documentId: 0,
    revision: 0,
    past: [],
    future: [],
    error: null,
    setProject: (project, path) => {
      set((state) => {
      const parsed = project ? isWorkerValidatedProject(project) ? project : parseLinkProject(project) : null;
      const needsLayers = parsed ? needsProjectVisualLayers(parsed) : false;
      return {
        project: parsed && needsLayers ? initializeProjectVisualLayersCommand().execute(parsed) : parsed,
        path,
        dirty: needsLayers,
        documentId: state.documentId + 1,
        revision: 0,
        past: [],
        future: [],
        error: null
      };
      });
      if (get().project && get().project?.obsOutputMode !== 'scenes') {
        get().execute(setObsOutputModeCommand('scenes'));
        // The single scene workflow is the document's opening baseline, before user edits.
        set({ past: [], future: [], revision: 0 });
      }
    },
    markSaved: (path, revision, documentId) => set((state) => documentId !== undefined && documentId !== state.documentId
      ? state
      : {
          dirty: revision === undefined || revision === state.revision ? false : state.dirty,
          ...(path !== undefined ? { path } : {}),
          error: null,
          revision: state.revision
        }),
    execute: (command) => {
      const state = get();
      if (!state.project) throw new Error('尚未打开工程');
      try {
        const prepared = withMa2PairingValidation(withInitialVisualLayers(command));
        const next = shareProjectStructure(state.project, prepared.execute(state.project));
        const last = state.past.at(-1);
        const grouped = prepared.historyGroup && prepared.historyGroup === last?.command.historyGroup;
        const past = [...(grouped ? state.past.slice(0, -1) : state.past), { command: prepared, before: grouped ? last.before : state.project }].slice(-MAX_HISTORY);
        set({ project: next, dirty: true, revision: state.revision + 1, past, future: [], error: null });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set({ error: message });
        throw error;
      }
    },
    executeForDocument: (documentId, command) => {
      const state = get();
      if (state.documentId !== documentId) throw new Error('当前工程已切换，已取消上一工程尚未完成的修改');
      state.execute(command);
    },
    undo: () => {
      const state = get();
      const frame = state.past.at(-1);
      if (!frame || !state.project) return;
      const restored = shareProjectStructure(frame.before, frame.command.undo(frame.before));
      set({
        project: restored,
        dirty: true,
        revision: state.revision + 1,
        past: state.past.slice(0, -1),
        future: [...state.future, frame],
        error: null
      });
    },
    redo: () => {
      const state = get();
      const frame = state.future.at(-1);
      if (!frame || !state.project) return;
      const applied = shareProjectStructure(state.project, frame.command.execute(state.project));
      set({
        project: applied,
        dirty: true,
        revision: state.revision + 1,
        past: [...state.past, { command: frame.command, before: state.project }].slice(-MAX_HISTORY),
        future: state.future.slice(0, -1),
        error: null
      });
    },
    clearError: () => set({ error: null })
  }))
);

export const selectCanUndo = (state: DocumentStoreState): boolean => state.past.length > 0;
export const selectCanRedo = (state: DocumentStoreState): boolean => state.future.length > 0;

export function assertDocumentSession(documentId: number): DocumentStoreState {
  const state = useDocumentStore.getState();
  if (state.documentId !== documentId) throw new Error('当前工程已切换，已取消上一工程尚未完成的操作');
  return state;
}
