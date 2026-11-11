import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { DragSession } from './drag-session';
import { keyRouter } from '../keys/key-router';

/**
 * A drag on the timeline (`DragSession`), drawn by the component that holds it. `begin` takes the pointer for the
 * pressed element (or `element`, the part pressed inside a track that hears the events for it); `current` reads the
 * drag going on inside an event, before the next drawing. `heard` hears every change as it happens, the end too
 * (dropped, Escape, the window left): a drag moved in the DOM (drag-preview.ts) stops writing there with it.
 */
export function useDragSession<T>(heard?: (value: T | null) => void): {
  drag: T | null;
  current: () => T | null;
  begin: (event: PointerEvent<Element>, value: T, element?: Element) => void;
  update: (value: T) => void;
  end: () => void;
} {
  const [drag, setDrag] = useState<T | null>(null);
  const listener = useRef(heard);
  useLayoutEffect(() => { listener.current = heard; });
  // The window in the app; the session only listens once a drag begins, so drawing without a window (tests) works.
  // The key router cancels the drag on Escape while it goes on.
  const [session] = useState(() => new DragSession<T>(globalThis, value => { listener.current?.(value); setDrag(() => value); }, keyRouter));
  useEffect(() => () => session.dispose(), [session]);
  // The same functions on every drawing, so that effects can depend on them.
  const [actions] = useState(() => ({
    current: () => session.current(),
    begin: (event: PointerEvent<Element>, value: T, element: Element = event.currentTarget) => session.begin(element, event.pointerId, value),
    update: (value: T) => session.update(value),
    end: () => session.end()
  }));
  return { drag, ...actions };
}
