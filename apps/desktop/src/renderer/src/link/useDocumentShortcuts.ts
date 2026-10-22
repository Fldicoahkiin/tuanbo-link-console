import { useEffect } from 'react';
import { useDocumentStore } from './stores/document-store';

type DocumentShortcut = 'save' | 'save-as' | 'undo' | 'redo';
const nonTextInputs = new Set(['button', 'checkbox', 'color', 'file', 'radio', 'range', 'reset', 'submit']);

/** Ctrl+Z/Y inside a text field belongs to that field's own history, not to project commands. */
export function documentShortcut(event: Pick<KeyboardEvent, 'ctrlKey' | 'shiftKey' | 'key'>, editingText: boolean): DocumentShortcut | null {
  if (!event.ctrlKey) return null;
  const key = event.key.toLowerCase();
  if (key === 's') return event.shiftKey ? 'save-as' : 'save';
  if (editingText) return null;
  if (key === 'z' && !event.shiftKey) return 'undo';
  if (key === 'y' || key === 'z' && event.shiftKey) return 'redo';
  return null;
}

/** Saving never waits for playback to stop. Save As changes the project path, so it waits; while
 * playing, only lighting steps can be undone or redone. */
export function runDocumentShortcut(action: DocumentShortcut, locked: boolean, history: { undoScope: string | undefined; redoScope: string | undefined },
  actions: { save(): void; saveAs(): void; undo(): void; redo(): void }): void {
  if (action === 'save') actions.save();
  else if (action === 'save-as') { if (!locked) actions.saveAs(); }
  else if (action === 'undo') { if (!locked || history.undoScope === 'lighting') actions.undo(); }
  else if (!locked || history.redoScope === 'lighting') actions.redo();
}

function isTextEditing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement) return !nonTextInputs.has(target.type);
  return target instanceof HTMLTextAreaElement || target.isContentEditable;
}

export function useDocumentShortcuts(locked: boolean, save: () => Promise<void>, saveAs: () => Promise<void>): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const action = documentShortcut(event, isTextEditing(event.target));
      if (!action) return;
      event.preventDefault();
      const state = useDocumentStore.getState();
      runDocumentShortcut(action, locked, { undoScope: state.past.at(-1)?.command.scope, redoScope: state.future.at(-1)?.command.scope },
        { save: () => void save(), saveAs: () => void saveAs(), undo: () => state.undo(), redo: () => state.redo() });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [locked, save, saveAs]);
}
