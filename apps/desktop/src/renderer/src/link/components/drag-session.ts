/** The window, as far as a drag listens to it. */
export type DragWindow = Pick<Window, 'addEventListener' | 'removeEventListener'>;
/** The pressed element, which captures the pointer for the drag. */
export type DragHandle = {
  setPointerCapture(pointerId: number): void;
  hasPointerCapture(pointerId: number): boolean;
  contains(other: EventTarget | null): boolean;
};

/**
 * The window's key router (keys/key-router.ts), told while a drag goes on: Escape cancels it there (`escape`), and is
 * only taken once it is `cancelled`, until the pointer is let go. The result says the drag is over.
 */
export type DragKeys = { beginDrag(drag: { escape: () => void; cancelled: () => boolean }): () => void };

/**
 * The drag going on; `drawn` until the component that holds it leaves; `cancelled` once Escape gave it up while the
 * pointer is still held.
 */
type Active<T> = { element: DragHandle; pointerId: number; value: T; drawn: boolean; cancelled: boolean };

/**
 * One drag or trim on the timeline: a clip, a Cue point, a lighting point, a box selection, a track. The element that
 * was pressed drops or cancels it from its own pointer events. Until the pointer is let go, Escape only cancels it and
 * goes no further, also once the element went away (0.5.9): a Cue point dragged out of view was left out of the page,
 * and Escape pressed to give up the move stopped the show instead. A cancelled drag waits for the pointer to be let go
 * all the same, so Escape pressed again to make sure does nothing either: it stopped the show (0.5.9).
 *
 * Escape is the window's key router's (04 设计 4.6, K5): told the drag is going on, it cancels it and keeps the key
 * from everything after it, the timeline's and the window's Escape that stops the show included. The window watches
 * the release, in the capture phase. With 顺序连播 the editor moves on to the next song under the pointer, the element goes away,
 * and its own pointerup never comes; a drag left over swallowed the first Escape after the release, so the show only
 * stopped on the second press (0.5.9). The release ends such a drag wherever it lands, and a cancelled one too, which
 * its element has nothing to drop for; so does leaving the window. The next Escape stops the show as usual.
 */
export class DragSession<T> {
  private active: Active<T> | null = null;
  private keysDone: (() => void) | null = null;

  /** `keys`: the window's key router, which cancels the drag on Escape. */
  constructor(private readonly view: DragWindow, private readonly changed: (value: T | null) => void, private readonly keys: DragKeys) {}

  /** Starts a drag from `element`, which takes the pointer; a drag still going is dropped without a word. */
  begin(element: DragHandle, pointerId: number, value: T): void {
    this.unwatch();
    element.setPointerCapture(pointerId);
    this.active = { element, pointerId, value, drawn: true, cancelled: false };
    this.view.addEventListener('pointerup', this.release, true);
    this.view.addEventListener('pointercancel', this.release, true);
    this.view.addEventListener('blur', this.leave);
    this.keysDone = this.keys.beginDrag({ escape: () => this.cancel(), cancelled: () => this.active?.cancelled === true });
    this.changed(value);
  }

  /** The drag going on, or null; a cancelled one is not going on. */
  current(): T | null {
    const active = this.active;
    return active && !active.cancelled ? active.value : null;
  }

  /** The drag moved on to `value`. */
  update(value: T): void {
    const active = this.active;
    if (!active || active.cancelled) return;
    active.value = value;
    this.changed(value);
  }

  /** The drag is over: dropped, or let go after Escape cancelled it or its element went away. */
  end(): void {
    const active = this.active;
    if (!active) return;
    this.unwatch();
    if (active.drawn && !active.cancelled) this.changed(null);
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
    this.view.removeEventListener('pointerup', this.release, true);
    this.view.removeEventListener('pointercancel', this.release, true);
    this.view.removeEventListener('blur', this.leave);
    this.keysDone?.();
    this.keysDone = null;
  }

  /** Escape while the pointer is held gives the drag up at once (the key router); pressed again before the release, it is only taken. */
  private cancel(): void {
    const active = this.active;
    if (!active || active.cancelled) return;
    active.cancelled = true;
    if (active.drawn) this.changed(null);
  }

  /**
   * A release the element will not drop the drag for: it went away, or lost the pointer and the release landed
   * elsewhere, or Escape cancelled the drag and there is nothing to drop.
   */
  private readonly release = (event: PointerEvent): void => {
    const active = this.active;
    if (!active || event.pointerId !== active.pointerId) return;
    if (!active.cancelled && (active.element.hasPointerCapture(active.pointerId) || active.element.contains(event.target))) return;
    this.end();
  };

  private readonly leave = (): void => this.end();
}
