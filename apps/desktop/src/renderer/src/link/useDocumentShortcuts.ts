import { useEffect } from 'react';
import { useDocumentStore } from './stores/document-store';

type DocumentShortcut = 'save' | 'undo' | 'redo';
const nonTextInputs = new Set(['button', 'checkbox', 'color', 'file', 'radio', 'range', 'reset', 'submit']);

/** Ctrl+Z/Y inside a text field belongs to that field's own history, not to project commands. */
export function documentShortcut(event: Pick<KeyboardEvent, 'ctrlKey' | 'shiftKey' | 'key'>, editingText: boolean): DocumentShortcut | null {
  if (!event.ctrlKey) return null;
  const key = event.key.toLowerCase();
  if (key === 's') return 'save';
  if (editingText) return null;
  if (key === 'z' && !event.shiftKey) return 'undo';
  if (key === 'y' || key === 'z' && event.shiftKey) return 'redo';
  return null;
}

function isTextEditing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement) return !nonTextInputs.has(target.type);
  return target instanceof HTMLTextAreaElement || target.isContentEditable;
}

export function useDocumentShortcuts(locked: boolean, save: () => Promise<void>): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const action = documentShortcut(event, isTextEditing(event.target));
      if (!action) return;
      event.preventDefault();
      const state = useDocumentStore.getState();
      if (action === 'save') { if (!locked) void save(); }
      else if (action === 'undo') { if (!locked || state.past.at(-1)?.command.scope === 'lighting') state.undo(); }
      else if (!locked || state.future.at(-1)?.command.scope === 'lighting') state.redo();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [locked, save]);
}
