import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { DragSession } from './drag-session';
import { keyRouter } from '../keys/key-router';
import { DragPreview, animationFrames, type FrameScheduler } from './drag-preview';

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

/** What a framed drag works out: the drag from what the press kept and the pointer (pure), and what of it React draws. */
export type FramedDragWork<T, P> = { target: (start: T, pointer: P) => T; drawn: (value: T) => string };

/**
 * A drag React draws, a frame at a time (0.5.9 E3, the second half): the sound segments' and the lighting points'
 * drags. The press keeps what the drag works from (`value`); a move is worked out in the next frame from it and the
 * pointer, and React draws again only when `drawn` of the result changed. The release works out where the pointer
 * was let go at once. Escape, leaving the window and the pressed element going away end it as every DragSession
 * does, and nothing is worked out after that.
 */
export function useFramedDrag<T, P>(frames?: FrameScheduler): {
  drag: T | null;
  current: () => T | null;
  begin: (event: PointerEvent<Element>, value: T, work: FramedDragWork<T, P>) => void;
  move: (pointer: P) => void;
  release: (pointer: P) => T | null;
  end: () => void;
} {
  const preview = useRef<DragPreview<P, T> | null>(null);
  const session = useDragSession<T>((value) => { if (value === null) preview.current?.stop(); });
  useEffect(() => () => preview.current?.stop(), []);
  const [actions] = useState(() => ({
    begin: (event: PointerEvent<Element>, value: T, work: FramedDragWork<T, P>): void => {
      preview.current?.stop();
      const element = event.currentTarget;
      preview.current = new DragPreview<P, T>({
        target: (pointer) => work.target(value, pointer),
        alive: () => element.isConnected,
        paint: () => undefined,
        restore: () => undefined,
        drawn: work.drawn,
        changed: (next) => session.update(next)
      }, value, frames ?? animationFrames);
      session.begin(event, value);
    },
    move: (pointer: P): void => { if (session.current() !== null) preview.current?.move(pointer); },
    release: (pointer: P): T | null => {
      const result = session.current() !== null ? preview.current?.release(pointer) ?? null : null;
      session.end();
      return result;
    },
    end: (): void => session.end()
  }));
  return { drag: session.drag, current: session.current, ...actions };
}
