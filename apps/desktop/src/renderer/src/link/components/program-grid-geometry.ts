/**
 * Where things are drawn on the home rundown (2026-11-11). The selection box and the insertion marker are placed in
 * the list's own scrolled content, never in window coordinates: `.app-workspace` has CSS `contain`, which makes it
 * the box of anything `position: fixed` inside it, so a box drawn at the pointer's window position sat lower and
 * further right than the pointer by the title bar and the sidebar (0.5.8 field report).
 */
export type Point = { x: number; y: number };
export type Rectangle = { left: number; top: number; width: number; height: number };
/** The list element as the browser measures it: its window box, border, scroll position and scrolled size. */
export type ScrollBox = {
  left: number; top: number; clientLeft: number; clientTop: number;
  scrollLeft: number; scrollTop: number; scrollWidth: number; scrollHeight: number;
};

export function scrollBoxOf(element: HTMLElement): ScrollBox {
  const bounds = element.getBoundingClientRect();
  return { left: bounds.left, top: bounds.top, clientLeft: element.clientLeft, clientTop: element.clientTop,
    scrollLeft: element.scrollLeft, scrollTop: element.scrollTop, scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight };
}

/** A window position as a position in the list's content, kept inside the content so the box never adds scrolling. */
export function contentPoint(clientX: number, clientY: number, box: ScrollBox): Point {
  return {
    x: Math.max(0, Math.min(box.scrollWidth, clientX - box.left - box.clientLeft + box.scrollLeft)),
    y: Math.max(0, Math.min(box.scrollHeight, clientY - box.top - box.clientTop + box.scrollTop))
  };
}

/** The box between where the button went down and where the pointer is now, both in content positions. */
export function selectionRectangle(start: Point, current: Point): Rectangle {
  const left = Math.min(start.x, current.x), top = Math.min(start.y, current.y);
  return { left, top, width: Math.abs(current.x - start.x), height: Math.abs(current.y - start.y) };
}

/** A card's window box in content positions, to compare with the selection box. */
export function contentRectangle(client: { left: number; top: number; width: number; height: number }, box: ScrollBox): Rectangle {
  return { left: client.left - box.left - box.clientLeft + box.scrollLeft, top: client.top - box.top - box.clientTop + box.scrollTop, width: client.width, height: client.height };
}

export function intersects(a: Rectangle, b: Rectangle): boolean {
  return a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;
}

/** Cards are side by side, so the half of the card decides; list rows are stacked, so the upper or lower half. */
export function dropPlacement(clientX: number, clientY: number, card: { left: number; top: number; width: number; height: number }, view: 'list' | 'cards'): 'before' | 'after' {
  return view === 'cards' ? clientX < card.left + card.width / 2 ? 'before' : 'after' : clientY < card.top + card.height / 2 ? 'before' : 'after';
}

/** How deep the band along the top and bottom edge of a list is in which a held drag scrolls it, and how fast. */
export const EDGE_SCROLL_ZONE = 48;
export const EDGE_SCROLL_MIN_SPEED = 120;
export const EDGE_SCROLL_MAX_SPEED = 1200;

/**
 * While a card or a playlist is dragged near the top or bottom edge of the list holding it, the list scrolls
 * (2026-11-11). Returns pixels per second, negative upward: zero outside the band, growing towards the edge, fastest
 * on and just beyond it. The band reaches `EDGE_SCROLL_ZONE` px inside and outside each edge and only counts while
 * the pointer is over the list's width, so moving away to another part of the window stops the scrolling.
 */
export function edgeScrollSpeed(pointer: Point, list: { left: number; top: number; width: number; height: number }): number {
  if (pointer.x < list.left || pointer.x > list.left + list.width) return 0;
  // A list lower than two bands splits its height between them, so the middle never scrolls.
  const zone = Math.min(EDGE_SCROLL_ZONE, list.height / 2);
  if (zone <= 0) return 0;
  const speed = (depth: number): number => EDGE_SCROLL_MIN_SPEED + (EDGE_SCROLL_MAX_SPEED - EDGE_SCROLL_MIN_SPEED) * Math.min(1, Math.max(0, (zone - depth) / zone));
  const fromTop = pointer.y - list.top, fromBottom = list.top + list.height - pointer.y;
  if (fromTop < zone && fromTop >= -EDGE_SCROLL_ZONE) return -speed(fromTop);
  if (fromBottom < zone && fromBottom >= -EDGE_SCROLL_ZONE) return speed(fromBottom);
  return 0;
}
