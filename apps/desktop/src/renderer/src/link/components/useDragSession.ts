import { useEffect, useState, type PointerEvent } from 'react';
import { DragSession } from './drag-session';

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
  const [session] = useState(() => new DragSession<T>(window, value => setDrag(() => value)));
  useEffect(() => () => session.dispose(), [session]);
  return {
    drag,
    current: () => session.current(),
    begin: (event, value) => session.begin(event.currentTarget, event.pointerId, value),
    update: value => session.update(value),
    end: () => session.end()
  };
}
