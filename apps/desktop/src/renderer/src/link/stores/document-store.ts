/// <reference types="vite/client" />
import { create, type StateCreator } from 'zustand';
import { shareProjectStructure } from './share-project-structure';
import { isWorkerValidatedProject } from './project-codec';
import { subscribeWithSelector } from 'zustand/middleware';
import { parseLinkProject, type LinkProject } from '@tb/schema';
import { initializeProjectVisualLayersCommand, needsProjectVisualLayers, setObsOutputModeCommand, withInitialVisualLayers, withMa2PairingValidation, type LinkCommand } from '@tb/core/link';

type HistoryFrame = {
  command: LinkCommand;
  before: LinkProject;
  /** Content identity before and after this step; undo and redo restore them. */
  beforeStateId: string;
  stateId: string;
  rebases?: ReadonlyMap<string, (project: LinkProject) => LinkProject>;
};

function rebaseFrame(frame: HistoryFrame, project: LinkProject): LinkProject {
  let next = project;
  for (const rebase of frame.rebases?.values() ?? []) next = rebase(next);
  return next;
}

/** How a project entered the editor: as read from disk, upgraded in memory, or restored unsaved content. */
export type DocumentOpening = { upgraded?: boolean; restored?: boolean };

export type DocumentStoreState = {
  project: LinkProject | null;
  path: string | null;
  /** The current content differs from the project file (or, unnamed, from the new document). */
  dirty: boolean;
  documentId: number;
  revision: number;
  /** Identity of the current content; undo and redo bring back an earlier identity. */
  stateId: string;
  /** Identity whose content is the project file on disk; null when no undo position matches it. */
  savedStateId: string | null;
  /** Random per opened document; owns its recovery copy across renderer reloads. */
  sessionId: string;
  /** The file was upgraded in memory on open; the first save over it keeps the original as a .bak. */
  upgradeBackupPending: boolean;
  /** Unsaved edits have already been written to the MA2 console. */
  consoleSynced: boolean;
  past: HistoryFrame[];
  future: HistoryFrame[];
  error: string | null;
  setProject: (project: LinkProject | null, path: string | null, opening?: DocumentOpening) => void;
  markSaved: (path: string, stateId: string, documentId: number) => void;
  markConsoleSynced: (documentId: number) => void;
  execute: (command: LinkCommand) => void;
  executeForDocument: (documentId: number, command: LinkCommand) => void;
  undo: () => void;
  redo: () => void;
  clearError: () => void;
};

const MAX_HISTORY = 100;

const documentState: StateCreator<DocumentStoreState> = (set, get) => {
  const initialState = crypto.randomUUID();
  return {
    project: null,
    path: null,
    dirty: false,
    documentId: 0,
    revision: 0,
    stateId: initialState,
    savedStateId: initialState,
    sessionId: crypto.randomUUID(),
    upgradeBackupPending: false,
    consoleSynced: false,
    past: [],
    future: [],
    error: null,
    setProject: (project, path, opening = {}) => {
      set((state) => {
        const parsed = project ? isWorkerValidatedProject(project) ? project : parseLinkProject(project) : null;
        let prepared = parsed;
        if (prepared && needsProjectVisualLayers(prepared)) prepared = initializeProjectVisualLayersCommand().execute(prepared);
        // The single scene workflow is the document's opening baseline, before user edits.
        if (prepared && prepared.obsOutputMode !== 'scenes') prepared = withMa2PairingValidation(withInitialVisualLayers(setObsOutputModeCommand('scenes'))).execute(prepared);
        // Only a file can be upgraded; a new unnamed document has nothing on disk to differ from.
        const upgraded = path !== null && (opening.upgraded === true || prepared !== parsed);
        const stateId = crypto.randomUUID();
        const savedStateId = opening.restored || upgraded ? null : stateId;
        return {
          project: prepared,
          path,
          dirty: stateId !== savedStateId,
          documentId: state.documentId + 1,
          revision: 0,
          stateId,
          savedStateId,
          sessionId: crypto.randomUUID(),
          upgradeBackupPending: upgraded,
          consoleSynced: false,
          past: [],
          future: [],
          error: null
        };
      });
    },
    markSaved: (path, stateId, documentId) => set((state) => documentId !== state.documentId
      ? state
      : { path, savedStateId: stateId, dirty: state.stateId !== stateId, upgradeBackupPending: false, consoleSynced: false, error: null }),
    markConsoleSynced: (documentId) => {
      if (get().documentId !== documentId) throw new Error('当前工程已切换，控台同步结果不属于当前工程');
      set({ consoleSynced: true });
    },
    execute: (command) => {
      const state = get();
      if (!state.project) throw new Error('尚未打开工程');
      try {
        const prepared = withMa2PairingValidation(withInitialVisualLayers(command));
        const next = shareProjectStructure(state.project, prepared.execute(state.project));
        const rebase = prepared.rebaseHistory;
        const stateId = crypto.randomUUID();
        if (rebase) {
          if (!prepared.historyRebaseKey) throw new Error('同步回读缺少历史基线标识');
          const updateFrame = (frame: HistoryFrame): HistoryFrame => ({
            ...frame, before: rebase(frame.before),
            rebases: new Map([...frame.rebases ?? [], [prepared.historyRebaseKey!, rebase]])
          });
          // Rebased history no longer contains the content on disk at any position.
          set({ project: next, dirty: true, revision: state.revision + 1, stateId, savedStateId: null,
            past: state.past.map(updateFrame), future: state.future.map(updateFrame), error: null });
          return;
        }
        const last = state.past.at(-1);
        const grouped = prepared.historyGroup && prepared.historyGroup === last?.command.historyGroup;
        const frame: HistoryFrame = grouped
          ? { command: prepared, before: last.before, beforeStateId: last.beforeStateId, stateId }
          : { command: prepared, before: state.project, beforeStateId: state.stateId, stateId };
        const past = [...(grouped ? state.past.slice(0, -1) : state.past), frame].slice(-MAX_HISTORY);
        set({ project: next, dirty: stateId !== state.savedStateId, revision: state.revision + 1, stateId, past, future: [], error: null });
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
      const restored = shareProjectStructure(frame.before, rebaseFrame(frame, frame.command.undo(frame.before)));
      set({
        project: restored,
        dirty: frame.beforeStateId !== state.savedStateId,
        revision: state.revision + 1,
        stateId: frame.beforeStateId,
        past: state.past.slice(0, -1),
        future: [...state.future, frame],
        error: null
      });
    },
    redo: () => {
      const state = get();
      const frame = state.future.at(-1);
      if (!frame || !state.project) return;
      const applied = shareProjectStructure(state.project, rebaseFrame(frame, frame.command.execute(state.project)));
      set({
        project: applied,
        dirty: frame.stateId !== state.savedStateId,
        revision: state.revision + 1,
        stateId: frame.stateId,
        past: [...state.past, { ...frame, before: state.project }].slice(-MAX_HISTORY),
        future: state.future.slice(0, -1),
        error: null
      });
    },
    clearError: () => set({ error: null })
  };
};

function createDocumentStore() {
  return create<DocumentStoreState>()(subscribeWithSelector(documentState));
}

// Every importer must keep the same store, including older React refresh
// boundaries and running controllers. Update actions without replacing the
// document, its subscriptions, session identity or unsaved command history.
const hotData = import.meta.hot?.data as { documentStore?: ReturnType<typeof createDocumentStore> } | undefined;
export const useDocumentStore = hotData?.documentStore ?? createDocumentStore();
if (import.meta.hot && hotData) {
  if (hotData.documentStore) {
    const { project, path, dirty, documentId, revision, stateId, savedStateId, sessionId, upgradeBackupPending, consoleSynced, past, future, error } = useDocumentStore.getState();
    const actions = documentState(useDocumentStore.setState, useDocumentStore.getState, useDocumentStore);
    useDocumentStore.setState({ ...actions, project, path, dirty, documentId, revision, stateId, savedStateId, sessionId, upgradeBackupPending, consoleSynced, past, future, error }, true);
  }
  hotData.documentStore = useDocumentStore;
  import.meta.hot.accept();
}

export const selectCanUndo = (state: DocumentStoreState): boolean => state.past.length > 0;
export const selectCanRedo = (state: DocumentStoreState): boolean => state.future.length > 0;

export function assertDocumentSession(documentId: number): DocumentStoreState {
  const state = useDocumentStore.getState();
  if (state.documentId !== documentId) throw new Error('当前工程已切换，已取消上一工程尚未完成的操作');
  return state;
}
