import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Space kept between a menu and the window edge. */
const MARGIN = 8;

/**
 * Where a menu of `size` opened at the pointer goes: at the pointer, flipped to the other side of it
 * when it would cross the window edge, and never outside the window.
 */
export function floatingMenuPlace(pointer: { x: number; y: number }, size: { width: number; height: number }, screen: { width: number; height: number }): { left: number; top: number } {
  const axis = (at: number, length: number, room: number): number => {
    if (at + length + MARGIN <= room) return at;
    const flipped = at - length;
    return Math.max(MARGIN, Math.min(flipped, room - length - MARGIN));
  };
  return { left: axis(pointer.x, size.width, screen.width), top: axis(pointer.y, size.height, screen.height) };
}

/**
 * A right-click menu at the pointer. It is mounted on the page body, so a workspace that contains its
 * layout cannot move it away from the pointer (2026-10-28, picture 11). Presses and clicks in it stay in
 * it: React passes them up its tree to the timeline or stage that opened the menu otherwise.
 */
export function FloatingMenu({ x, y, className, label, children }: { x: number; y: number; className: string; label: string; children: ReactNode }): JSX.Element {
  const menu = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const box = menu.current?.getBoundingClientRect();
    if (box) setPlace(floatingMenuPlace({ x, y }, box, { width: window.innerWidth, height: window.innerHeight }));
  }, [x, y]);
  return createPortal(<div ref={menu} role="menu" aria-label={label} className={className} style={place} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onContextMenu={event => event.preventDefault()}>{children}</div>, document.body);
}
