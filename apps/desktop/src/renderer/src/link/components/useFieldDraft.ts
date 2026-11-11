import { useReducer } from 'react';

/** A property field in an inspector: it shows the project's value, except while
 * the operator is typing in it. Then it keeps what they typed, so an outside
 * change (playback, an undo elsewhere) never interrupts the edit; when the field
 * is left the project's value shows again, which is the committed one. */
export type FieldDraft = { editing: false } | { editing: true; text: string };
export type FieldDraftEvent = { type: 'begin'; text: string } | { type: 'type'; text: string } | { type: 'end' };

export function fieldDraft(draft: FieldDraft, event: FieldDraftEvent): FieldDraft {
  switch (event.type) {
    case 'begin': return draft.editing ? draft : { editing: true, text: event.text };
    case 'type': return { editing: true, text: event.text };
    case 'end': return draft.editing ? { editing: false } : draft;
  }
}

/** What the field shows for the project's value `value`. */
export function shownDraft(draft: FieldDraft, value: string): string {
  return draft.editing ? draft.text : value;
}

export function useFieldDraft(value: string): { shown: string; begin: () => void; type: (text: string) => void; end: () => void } {
  const [draft, dispatch] = useReducer(fieldDraft, { editing: false });
  return {
    shown: shownDraft(draft, value),
    begin: () => dispatch({ type: 'begin', text: value }),
    type: text => dispatch({ type: 'type', text }),
    end: () => dispatch({ type: 'end' })
  };
}
