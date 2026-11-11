import { useEffect, useState, type PointerEvent } from 'react';
import { DragSession } from './drag-session';
import { keyRouter } from '../keys/key-router';

/**
 * A drag on the timeline (`DragSession`), drawn by the component that holds it. `begin` takes the pointer for the
 * pressed element; `current` reads the drag going on inside an event, before the next drawing.
 */
export function useDragSession<T>(): {
  drag: T | null;
  current: () => T | null;
  begin: (event: PointerEvent<Element>, value: T) => void;
  update: (value: T) => void;
  end: () => void;
} {
  const [drag, setDrag] = useState<T | null>(null);
  // The window in the app; the session only listens once a drag begins, so drawing without a window (tests) works.
  // The key router leaves Escape to the session while it goes on.
  const [session] = useState(() => new DragSession<T>(globalThis, value => setDrag(() => value), keyRouter));
  useEffect(() => () => session.dispose(), [session]);
  return {
    drag,
    current: () => session.current(),
    begin: (event, value) => session.begin(event.currentTarget, event.pointerId, value),
    update: value => session.update(value),
    end: () => session.end()
  };
}
