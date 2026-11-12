/// <reference types="vite/client" />
import { useMemo } from 'react';
import { create, type StateCreator } from 'zustand';
import { shareProjectStructure } from './share-project-structure';
import { isWorkerValidatedProject } from './project-codec';
import { subscribeWithSelector } from 'zustand/middleware';
import { parseLinkProject, validateLinkProjectRelations, type LinkProject } from '@tb/schema';
import { migrateSongMusic, normalizeContentTimeline, obsSceneOutputCommand, showGate, songStructureChanges, toUserErrorMessage, withContentTimeline, withMa2Pairings,
  type DroppedSongBeats, type LinkCommand, type ShowState } from '@tb/core/link';
import { useShowStateStore } from './show-state-store';

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

/** What undo (`frame` is the last of `past`) or redo (the last of `future`) makes of `project`. */
function historyStep(project: LinkProject, frame: HistoryFrame, direction: 'undo' | 'redo'): LinkProject {
  return direction === 'undo' ? shareProjectStructure(frame.before, rebaseFrame(frame, frame.command.undo(frame.before)))
    : shareProjectStructure(project, rebaseFrame(frame, frame.command.execute(project)));
}

/**
 * A song on stage plays on with the version it started with (0.5.9 S8a, design 02 §3.5): an edit that changes its audio
 * itself (songAudioStructureKey) or deletes or disables it waits until it stops. The wait in showGate's words, with
 * the show as `show` has it; null when `next` may be committed. Only 联动台播放 holds a version: P1 follow and the
 * editor's preview keep the rules they had before (onInternalStage).
 */
function stageWait(before: LinkProject, next: LinkProject, show: ShowState): string | null {
  if (!onInternalStage(show)) return null;
  const changes = songStructureChanges(before, next);
  const wait = (op: 'song.remove' | 'song.audio.edit', itemId: string): string | null => {
    const gate = showGate(op, show, itemId);
    return gate.kind === 'wait' ? gate.message : null;
  };
  for (const itemId of changes.removed) { const message = wait('song.remove', itemId); if (message) return message; }
  for (const itemId of changes.audio) { const message = wait('song.audio.edit', itemId); if (message) return message; }
  return null;
}
const currentShow = (): ShowState => useShowStateStore.getState().show;
/** 联动台播放 holds a song (preparing, playing, paused, ended or stopping): the only show whose song keeps the version
 * it started with. */
function onInternalStage(show: ShowState): boolean { return show.phase !== 'idle' && show.source === 'internal'; }

/** How a project entered the editor: as read from disk, upgraded in memory, or restored unsaved content. */
export type DocumentOpening = { upgraded?: boolean; restored?: boolean };
/** What opening the project did to its songs' beats (core migrateSongMusic): how many songs had theirs moved to the
 * new place, and the simple detection beats not kept where a song had two. Shown and logged once by the opener. */
export type SongMusicOpening = { moved: number; dropped: DroppedSongBeats[] };

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
  /** Set when opening moved old beats; the project is then unsaved and becomes schema 3 on its first save. */
  songMusicOpening: SongMusicOpening | null;
  past: HistoryFrame[];
  future: HistoryFrame[];
  /** What went wrong with the last edit, or what it waits for (a wait reads as one, isShowWait): shown once. */
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
    songMusicOpening: null,
    past: [],
    future: [],
    error: null,
    setProject: (project, path, opening = {}) => {
      set((state) => {
        const parsed = project ? isWorkerValidatedProject(project) ? project : parseLinkProject(project) : null;
        // Beats saved before 0.5.9 move to the song, the only place they are kept since (schema 3). Here only: it marks the
        // project unsaved, and the first save over an older file asks first and keeps that file (project-document.ts, main process).
        const music = parsed ? migrateSongMusic(parsed) : null;
        if (music?.moved) validateLinkProjectRelations(music.project);
        // Older projects open under the content timeline rules, playing what they played.
        let prepared = music && normalizeContentTimeline(music.project);
        // Projects from before the single scene workflow open in it, before user edits.
        if (prepared && prepared.obsOutputMode !== 'scenes') prepared = withMa2Pairings(obsSceneOutputCommand()).execute(prepared);
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
          songMusicOpening: music?.moved ? { moved: music.moved, dropped: music.dropped } : null,
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
      if (get().documentId !== documentId) throw new Error('工程已切换，这次控台同步的结果属于之前的工程，没有应用');
      set({ consoleSynced: true });
    },
    execute: (command) => {
      const state = get();
      if (!state.project) throw new Error('还没打开工程');
      try {
        const prepared = withMa2Pairings(withContentTimeline(command));
        const next = shareProjectStructure(state.project, prepared.execute(state.project));
        // Not committed: the song on stage cannot take it. Said as a wait, and thrown like any edit that was not made.
        const wait = stageWait(state.project, next, currentShow());
        if (wait) throw new Error(wait);
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
      if (state.documentId !== documentId) throw new Error('工程已切换，上一个工程还没完成的修改已取消');
      state.execute(command);
    },
    undo: () => {
      const state = get();
      const frame = state.past.at(-1);
      if (!frame || !state.project) return;
      const restored = historyStep(state.project, frame, 'undo');
      // The song on stage cannot take it: said as a wait, the step stays where it is (the button says it beforehand).
      const wait = stageWait(state.project, restored, currentShow());
      if (wait) { set({ error: wait }); return; }
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
      const applied = historyStep(state.project, frame, 'redo');
      const wait = stageWait(state.project, applied, currentShow());
      if (wait) { set({ error: wait }); return; }
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
    const { project, path, dirty, documentId, revision, stateId, savedStateId, sessionId, upgradeBackupPending, consoleSynced, songMusicOpening, past, future, error } = useDocumentStore.getState();
    const actions = documentState(useDocumentStore.setState, useDocumentStore.getState, useDocumentStore);
    useDocumentStore.setState({ ...actions, project, path, dirty, documentId, revision, stateId, savedStateId, sessionId, upgradeBackupPending, consoleSynced, songMusicOpening, past, future, error }, true);
  }
  hotData.documentStore = useDocumentStore;
  import.meta.hot.accept();
}

export const selectCanUndo = (state: DocumentStoreState): boolean => state.past.length > 0;
export const selectCanRedo = (state: DocumentStoreState): boolean => state.future.length > 0;

/** Why undo (or redo) waits now: its step would change a song on stage in a way it cannot take (0.5.9 S8a), in
 * showGate's words; null when it may run. Worked out only while a song is on stage; a step that cannot be worked out
 * then says why instead. Undo brings back the project as it was before its step (`frame.before`, which a rebase keeps
 * up to date), so the buttons compare with that instead of running the step: running it after every edit made while a
 * song plays cost a large project over 100 ms (a lighting edit validates the whole project). undo() itself still runs
 * the step and checks what it makes; redo, which only follows an undo, runs it here too. */
export function historyWait(state: Pick<DocumentStoreState, 'project' | 'past' | 'future'>, direction: 'undo' | 'redo', show: ShowState): string | null {
  const frame = direction === 'undo' ? state.past.at(-1) : state.future.at(-1);
  if (!frame || !state.project || !onInternalStage(show) || showGate('song.remove', show).kind === 'allow') return null;
  if (direction === 'undo') return stageWait(state.project, frame.before, show);
  let next: LinkProject;
  try { next = historyStep(state.project, frame, direction); } catch (error) { return toUserErrorMessage(error); }
  return stageWait(state.project, next, show);
}
/** `historyWait` for the undo and redo buttons: worked out again when the step, the project or the show changes. */
export function useHistoryWait(direction: 'undo' | 'redo'): string | null {
  const frame = useDocumentStore(state => direction === 'undo' ? state.past.at(-1) : state.future.at(-1));
  const project = useDocumentStore(state => state.project);
  const show = useShowStateStore(state => state.show);
  return useMemo(() => frame && project ? historyWait({ project, past: [frame], future: [frame] }, direction, show) : null, [frame, project, show, direction]);
}

export function assertDocumentSession(documentId: number): DocumentStoreState {
  const state = useDocumentStore.getState();
  if (state.documentId !== documentId) throw new Error('工程已切换，上一个工程还没完成的操作已取消');
  return state;
}
