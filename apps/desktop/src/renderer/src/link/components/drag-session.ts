import { cancelDragOnEscape } from '../playback-keys';

/** The window, as far as a drag listens to it. */
export type DragWindow = Pick<Window, 'addEventListener' | 'removeEventListener'>;
/** The pressed element, which captures the pointer for the drag. */
export type DragHandle = {
  setPointerCapture(pointerId: number): void;
  hasPointerCapture(pointerId: number): boolean;
  contains(other: EventTarget | null): boolean;
};

/** The drag going on; `drawn` until the component that holds it leaves. */
type Active<T> = { element: DragHandle; pointerId: number; value: T; drawn: boolean };

/**
 * One drag or trim on the timeline: a clip, a Cue point, a lighting point, a box selection, a track. The element that
 * was pressed drops or cancels it from its own pointer events. Until the pointer is let go, Escape only cancels it and
 * goes no further, also once the element went away (0.5.9): a Cue point dragged out of view was left out of the page,
 * and Escape pressed to give up the move stopped the show instead.
 *
 * The window watches the rest, in the capture phase so that it comes before the timeline's and the window's Escape
 * that stops the show. With 顺序连播 the editor moves on to the next song under the pointer, the element goes away,
 * and its own pointerup never comes; a drag left over swallowed the first Escape after the release, so the show only
 * stopped on the second press (0.5.9). The release ends such a drag wherever it lands, and so does leaving the window;
 * the next Escape stops the show as usual.
 */
export class DragSession<T> {
  private active: Active<T> | null = null;

  constructor(private readonly view: DragWindow, private readonly changed: (value: T | null) => void) {}

  /** Starts a drag from `element`, which takes the pointer; a drag still going is dropped without a word. */
  begin(element: DragHandle, pointerId: number, value: T): void {
    this.unwatch();
    element.setPointerCapture(pointerId);
    this.active = { element, pointerId, value, drawn: true };
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

  /** The drag is over: dropped, cancelled, or let go after its element went away. */
  end(): void {
    const active = this.active;
    if (!active) return;
    this.unwatch();
    if (active.drawn) this.changed(null);
  }

  /**
   * The component leaves: nothing is drawn any more. A drag it held lasts until the pointer is let go, the same as one
   * whose element alone went away, so that Escape before that only cancels it.
   */
  dispose(): void {
    if (this.active) this.active.drawn = false;
  }

  private unwatch(): void {
    this.active = null;
    this.view.removeEventListener('keydown', this.escape, true);
    this.view.removeEventListener('pointerup', this.release, true);
    this.view.removeEventListener('pointercancel', this.release, true);
    this.view.removeEventListener('blur', this.leave);
  }

  private readonly escape = (event: KeyboardEvent): void => cancelDragOnEscape(event, this.active !== null, () => this.end());

  /** A release the element will not see: it went away, or lost the pointer and the release landed elsewhere. */
  private readonly release = (event: PointerEvent): void => {
    const active = this.active;
    if (!active || event.pointerId !== active.pointerId) return;
    if (active.element.hasPointerCapture(active.pointerId) || active.element.contains(event.target)) return;
    this.end();
  };

  private readonly leave = (): void => this.end();
}
