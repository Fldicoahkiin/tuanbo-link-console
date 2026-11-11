import type { DragWindow } from './drag-session';
import type { KeyDragEntry } from '../keys/key-router';

/** The window's key router, as far as a drag it cannot cancel tells it (keys/key-router.ts). */
export type CapturedDragKeys = { beginDrag(drag: KeyDragEntry): () => void };

/**
 * A drag Escape cannot give up, told to the window's key router while it goes on (04 设计 4.6, K5): the stage's
 * media and OBS layers and OBS's live canvas, which move what they drag as the pointer moves, OBS's sources in OBS
 * itself. Their own pointer handling stays as it is; this only watches the pointer they hold (`gotpointercapture`)
 * until it is let go. Meanwhile Escape is taken and does nothing, instead of stopping the show, and no key changes the
 * project (undo, delete) halfway through.
 *
 * It ends when the element lets the pointer go (`lostpointercapture`), and also on any release of that pointer, the
 * system cancelling it or the window losing the focus, so that a capture lost without a word never keeps Escape from
 * stopping the show.
 */
export class CapturedDrag {
  private readonly held = new Map<number, () => void>();

  constructor(private readonly view: DragWindow, private readonly keys: CapturedDragKeys) {}

  /** The element took pointer `pointerId` for a drag. */
  got(pointerId: number): void {
    if (this.held.has(pointerId)) return;
    if (this.held.size === 0) {
      this.view.addEventListener('pointerup', this.release, true);
      this.view.addEventListener('pointercancel', this.release, true);
      this.view.addEventListener('blur', this.clear);
    }
    this.held.set(pointerId, this.keys.beginDrag({ escape: null, cancelled: () => true }));
  }

  /** Pointer `pointerId` was let go. */
  lost(pointerId: number): void {
    const done = this.held.get(pointerId);
    if (!done) return;
    done();
    this.held.delete(pointerId);
    if (this.held.size === 0) this.unwatch();
  }

  /** Every drag is over: the window lost the focus, or the component leaves. */
  readonly clear = (): void => {
    for (const pointerId of [...this.held.keys()]) this.lost(pointerId);
  };

  private unwatch(): void {
    this.view.removeEventListener('pointerup', this.release, true);
    this.view.removeEventListener('pointercancel', this.release, true);
    this.view.removeEventListener('blur', this.clear);
  }

  private readonly release = (event: PointerEvent): void => this.lost(event.pointerId);
}
