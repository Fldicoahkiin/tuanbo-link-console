import { useEffect, useState, type PointerEvent } from 'react';
import { CapturedDrag } from './captured-drag';
import { keyRouter } from '../keys/key-router';

/**
 * Tells the window's key router about the drags under an element that Escape cannot give up (`CapturedDrag`): spread
 * on the element around them, it hears the pointer they take and let go, which bubble up to it. Their own pointer
 * handling is not touched.
 */
export function useCapturedDrag(): { onGotPointerCapture: (event: PointerEvent<Element>) => void; onLostPointerCapture: (event: PointerEvent<Element>) => void } {
  const [drag] = useState(() => new CapturedDrag(globalThis, keyRouter));
  useEffect(() => () => drag.clear(), [drag]);
  return { onGotPointerCapture: event => drag.got(event.pointerId), onLostPointerCapture: event => drag.lost(event.pointerId) };
}
