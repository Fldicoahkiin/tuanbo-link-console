import { cancelDragOnEscape } from '../playback-keys';

/** The window, as far as a drag listens to it. */
export type DragWindow = Pick<Window, 'addEventListener' | 'removeEventListener'>;
/** The pressed element, which captures the pointer for the drag. */
export type DragHandle = {
  readonly isConnected: boolean;
  setPointerCapture(pointerId: number): void;
  hasPointerCapture(pointerId: number): boolean;
  contains(other: EventTarget | null): boolean;
};

type Active<T> = { element: DragHandle; pointerId: number; value: T };

/**
 * One drag or trim on the timeline: a clip, a Cue point, a lighting point, a box selection, a track. The element that
 * was pressed drops or cancels it from its own pointer events. While it lasts, Escape only cancels it and goes no
 * further (0.5.9).
 *
 * The window watches the rest, in the capture phase so that it comes before the timeline's and the window's Escape
 * that stops the show. A drag whose element went away is over: with 顺序连播 the editor moves on to the next song
 * under the pointer, the element's own pointerup never comes, and the leftover drag swallowed the first Escape
 * afterwards, so the show only stopped on the second press (0.5.9). The release ends such a drag, and an Escape while
 * the element is gone stops the show as usual. Leaving the window ends a drag too.
 */
export class DragSession<T> {
  private active: Active<T> | null = null;

  constructor(private readonly view: DragWindow, private readonly changed: (value: T | null) => void) {}

  /** Starts a drag from `element`, which takes the pointer; a drag still going is dropped without a word. */
  begin(element: DragHandle, pointerId: number, value: T): void {
    this.unwatch();
    element.setPointerCapture(pointerId);
    this.active = { element, pointerId, value };
    this.view.addEventListener('keydown', this.escape, true);
    this.view.addEventListener('pointerup', this.release, true);
    this.view.addEventListener('pointercancel', this.release, true);
    this.view.addEventListener('blur', this.leave);
    this.changed(value);
  }

  /** The drag going on, or null. */
  current(): T | null {
    return this.active?.value ?? null;
  }

  /** The drag moved on to `value`. */
  update(value: T): void {
    if (!this.active) return;
    this.active.value = value;
    this.changed(value);
  }

  /** The drag is over: dropped, cancelled, or its element went away. */
  end(): void {
    if (!this.active) return;
    this.unwatch();
    this.changed(null);
  }

  /** The component leaves: stop watching, without drawing anything. */
  dispose(): void {
    this.unwatch();
  }

  private unwatch(): void {
    this.active = null;
    this.view.removeEventListener('keydown', this.escape, true);
    this.view.removeEventListener('pointerup', this.release, true);
    this.view.removeEventListener('pointercancel', this.release, true);
    this.view.removeEventListener('blur', this.leave);
  }

  private readonly escape = (event: KeyboardEvent): void => {
    const active = this.active;
    if (!active || event.key !== 'Escape') return;
    if (active.element.isConnected) cancelDragOnEscape(event, true, () => this.end());
    else this.end();
  };

  /** A release the element will not see: it went away, or lost the pointer and the release landed elsewhere. */
  private readonly release = (event: PointerEvent): void => {
    const active = this.active;
    if (!active || event.pointerId !== active.pointerId) return;
    if (active.element.hasPointerCapture(active.pointerId) || active.element.contains(event.target)) return;
    this.end();
  };

  private readonly leave = (): void => this.end();
}
