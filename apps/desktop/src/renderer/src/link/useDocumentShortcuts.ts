import { useEffect } from 'react';
import { useDocumentStore } from './stores/document-store';

export function useDocumentShortcuts(locked: boolean, save: () => Promise<void>): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.ctrlKey) return;
      const key = event.key.toLowerCase();
      const state = useDocumentStore.getState();
      if (key === 's') { event.preventDefault(); if (!locked) void save(); }
      else if (key === 'z' && !event.shiftKey) {
        event.preventDefault(); if (!locked || state.past.at(-1)?.command.scope === 'lighting') state.undo();
      } else if (key === 'y' || key === 'z' && event.shiftKey) {
        event.preventDefault(); if (!locked || state.future.at(-1)?.command.scope === 'lighting') state.redo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [locked, save]);
}
