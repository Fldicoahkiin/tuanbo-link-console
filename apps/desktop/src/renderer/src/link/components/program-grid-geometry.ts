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
