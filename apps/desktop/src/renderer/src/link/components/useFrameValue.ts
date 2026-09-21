import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

/** Keep pointer input at display cadence; release commits the final value immediately. */
export function useFrameValue<T>(apply: (value: T) => void) {
  const callback = useRef(apply);
  useLayoutEffect(() => { callback.current = apply; });
  const frame = useRef<number | null>(null);
  const pending = useRef<{ value: T } | null>(null);
  const cancel = useCallback((): void => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null; pending.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);
  return {
    cancel,
    flush: (value: T): void => { cancel(); callback.current(value); },
    push: (value: T): void => {
      pending.current = { value };
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        const latest = pending.current; pending.current = null;
        if (latest) callback.current(latest.value);
      });
    }
  };
}
