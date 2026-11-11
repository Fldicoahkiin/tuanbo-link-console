import { useDocumentStore } from './stores/document-store';
import { useKeyCommands } from './keys/useKeyCommands';

type DocumentShortcut = 'save' | 'save-as' | 'undo' | 'redo';

/**
 * The project's keys and where they act, the rule the key router follows for them (keys/key-route.ts, checked against
 * this in key-router.test.ts). Ctrl+Z/Y inside a text field belongs to that field's own history, not to project
 * commands. Nor does it undo the project behind an open dialog (`inDialog`, see `keyInDialog`): with the focus on a
 * dialog's button, Ctrl+Z took back an edit the dialog hid (0.5.9). Ctrl+S saves everywhere.
 */
export function documentShortcut(event: Pick<KeyboardEvent, 'ctrlKey' | 'shiftKey' | 'key'>, editingText: boolean, inDialog: boolean): DocumentShortcut | null {
  if (!event.ctrlKey) return null;
  const key = event.key.toLowerCase();
  if (key === 's') return event.shiftKey ? 'save-as' : 'save';
  if (editingText || inDialog) return null;
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

/** Ctrl+S, Ctrl+Shift+S, Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z, handed to the window's key router. */
export function useDocumentShortcuts(locked: boolean, save: () => Promise<void>, saveAs: () => Promise<void>): void {
  const run = (action: DocumentShortcut): void => {
    const state = useDocumentStore.getState();
    runDocumentShortcut(action, locked, { undoScope: state.past.at(-1)?.command.scope, redoScope: state.future.at(-1)?.command.scope },
      { save: () => void save(), saveAs: () => void saveAs(), undo: () => state.undo(), redo: () => state.redo() });
  };
  useKeyCommands('global', {
    'document.save': () => run('save'), 'document.saveAs': () => run('save-as'),
    'document.undo': () => run('undo'), 'document.redo': () => run('redo')
  });
}
