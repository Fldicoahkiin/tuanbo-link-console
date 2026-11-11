import { useReducer } from 'react';

/** A property field in an inspector: it shows the project's value, except while
 * the operator is typing in it. Then it keeps what they typed, so an outside
 * change (playback, an undo elsewhere) never interrupts the edit; when the field
 * is left the project's value shows again, which is the committed one.
 * A field that only has the focus, with nothing typed yet, still follows the
 * project: leaving it then finds nothing changed and commits nothing, so a value
 * that moved meanwhile (the console, an undo) is never put back by a stale field. */
export type FieldDraft = { editing: false } | { editing: true; text: string };
export type FieldDraftEvent = { type: 'type'; text: string } | { type: 'end' };

export function fieldDraft(draft: FieldDraft, event: FieldDraftEvent): FieldDraft {
  switch (event.type) {
    case 'type': return { editing: true, text: event.text };
    case 'end': return draft.editing ? { editing: false } : draft;
  }
}

/** What the field shows for the project's value `value`. */
export function shownDraft(draft: FieldDraft, value: string): string {
  return draft.editing ? draft.text : value;
}

export function useFieldDraft(value: string): { shown: string; type: (text: string) => void; end: () => void } {
  const [draft, dispatch] = useReducer(fieldDraft, { editing: false });
  return {
    shown: shownDraft(draft, value),
    type: text => dispatch({ type: 'type', text }),
    end: () => dispatch({ type: 'end' })
  };
}
