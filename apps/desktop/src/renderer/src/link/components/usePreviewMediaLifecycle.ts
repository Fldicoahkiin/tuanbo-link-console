import { useEffect, type RefObject } from 'react';

/** A detached media element can keep its decoder and network stream alive until
 * GC. Release this preview's source explicitly, without touching a replacement. */
export function usePreviewMediaLifecycle(ref: RefObject<HTMLMediaElement>, source: string | null | undefined): void {
  useEffect(() => {
    const element = ref.current;
    if (!element || !source) return;
    return () => {
      if (element.getAttribute('src') !== source) return;
      element.pause();
      element.removeAttribute('src');
      element.load();
    };
  }, [ref, source]);
}
