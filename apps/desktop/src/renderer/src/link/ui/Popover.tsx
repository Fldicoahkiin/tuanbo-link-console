import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Space kept between a panel and the window edge, and between a panel and its button. */
const MARGIN = 8;
const GAP = 6;

/**
 * `below-end`: under the button, right edges lined up. `below-start`: under it, left edges lined up.
 * `right-end`: beside it, bottom edges lined up.
 */
export type PopoverPlacement = 'below-end' | 'below-start' | 'right-end';
type Box = { left: number; top: number; right: number; bottom: number };
export type PopoverPlace = { left: number; top: number; maxHeight: number };

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(value, high));

/** Where a panel of `size` goes next to the button at `anchor`, always inside the window. */
export function popoverPlace(anchor: Box, size: { width: number; height: number }, screen: { width: number; height: number }, placement: PopoverPlacement): PopoverPlace {
  switch (placement) {
    case 'below-end': {
      const top = anchor.bottom + GAP;
      return { left: clamp(anchor.right - size.width, MARGIN, screen.width - size.width - MARGIN), top, maxHeight: Math.max(0, screen.height - top - MARGIN) };
    }
    case 'below-start': {
      const top = anchor.bottom + GAP;
      return { left: clamp(anchor.left, MARGIN, screen.width - size.width - MARGIN), top, maxHeight: Math.max(0, screen.height - top - MARGIN) };
    }
    case 'right-end': {
      const maxHeight = Math.max(0, screen.height - 2 * MARGIN);
      const height = Math.min(size.height, maxHeight);
      return { left: clamp(anchor.right + GAP, MARGIN, screen.width - size.width - MARGIN), top: clamp(anchor.bottom - height, MARGIN, screen.height - height - MARGIN), maxHeight };
    }
  }
}

/**
 * A panel that opens from a button and stays beside it (2026-10-30 interface rework): the connection
 * details under the top bar, the sync details beside the lighting sidebar. It is not modal: Escape, a
 * click outside it or the button again close it. It is mounted on the page body, so the layout it
 * opens from cannot clip it.
 */
export function Popover({ anchor, label, placement = 'below-end', className, onClose, children }: {
  anchor: HTMLElement | null;
  label: string;
  placement?: PopoverPlacement;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}): JSX.Element {
  const panel = useRef<HTMLElement>(null);
  const [place, setPlace] = useState<PopoverPlace | null>(null);
  useLayoutEffect(() => {
    const measure = (): void => {
      const element = panel.current;
      if (!anchor || !element) return;
      const next = popoverPlace(anchor.getBoundingClientRect(), { width: element.offsetWidth, height: element.scrollHeight }, { width: window.innerWidth, height: window.innerHeight }, placement);
      setPlace(current => current && current.left === next.left && current.top === next.top && current.maxHeight === next.maxHeight ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
  }, [anchor, placement]);
  useEffect(() => {
    const away = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && (panel.current?.contains(target) || anchor?.contains(target))) return;
      onClose();
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
      anchor?.focus();
    };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', escape); };
  }, [anchor, onClose]);
  return createPortal(<section ref={panel} role="dialog" aria-modal="false" aria-label={label} className={className ? `ui-popover ${className}` : 'ui-popover'}
    style={place ? { left: place.left, top: place.top, maxHeight: place.maxHeight } : { visibility: 'hidden' }}>{children}</section>, document.body);
}
