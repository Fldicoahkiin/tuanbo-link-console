import { edgeScrollSpeed, type Point } from './program-grid-geometry';

/** The list being scrolled, as far as edge scrolling needs it. */
export type EdgeScroller = { scrollTop: number; getBoundingClientRect(): { left: number; top: number; width: number; height: number } };
/** The window's animation frames. */
export type FrameClock = { request(callback: (time: number) => void): number; cancel(frame: number): void };

type Active = { scroller: EdgeScroller; pointer: Point; frame: number | null; time: number | null; remainder: number };

/**
 * Scrolls the list a held drag is in while the pointer stays near its top or bottom edge (song cards and the
 * playlists on the home page, 2026-11-11), at the speed of `edgeScrollSpeed`. Each pointer move passes the pointer
 * with `follow`; the list keeps scrolling while the pointer rests in the edge band and stops once it leaves the band,
 * the list reaches its end, or `stop` is called (the drag dropped, Escape, the page left). After each step
 * `scrolled` gets the pointer again, so the insertion marker follows the content moving under it.
 */
export class DragEdgeScroll {
  private active: Active | null = null;

  constructor(private readonly frames: FrameClock, private readonly scrolled: (pointer: Point) => void) {}

  follow(scroller: EdgeScroller, pointer: Point): void {
    if (this.active && this.active.scroller !== scroller) this.stop();
    const active = this.active ?? { scroller, pointer, frame: null, time: null, remainder: 0 };
    active.pointer = pointer; this.active = active;
    if (active.frame === null && edgeScrollSpeed(pointer, scroller.getBoundingClientRect()) !== 0) active.frame = this.frames.request(this.step);
  }

  stop(): void {
    const active = this.active;
    if (active?.frame != null) this.frames.cancel(active.frame);
    this.active = null;
  }

  private readonly step = (time: number): void => {
    const active = this.active;
    if (!active) return;
    active.frame = null;
    const speed = edgeScrollSpeed(active.pointer, active.scroller.getBoundingClientRect());
    if (speed === 0) { this.rest(active); return; }
    // The first frame moves as far as one at 60 Hz; a frame held up by a busy page moves no more than 50 ms worth.
    const elapsed = active.time === null ? 1000 / 60 : Math.min(50, Math.max(0, time - active.time));
    active.time = time;
    const distance = active.remainder + speed * elapsed / 1000, whole = Math.trunc(distance);
    active.remainder = distance - whole;
    if (whole !== 0) {
      const before = active.scroller.scrollTop;
      active.scroller.scrollTop = before + whole;
      // At the end of the list: nothing more to scroll until the pointer moves again.
      if (active.scroller.scrollTop === before) { this.rest(active); return; }
      this.scrolled(active.pointer);
    }
    active.frame = this.frames.request(this.step);
  };

  private rest(active: Active): void {
    active.time = null; active.remainder = 0;
  }
}
