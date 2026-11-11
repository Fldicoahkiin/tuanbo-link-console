/*
 * Whether something on the timeline is moving under the user's hand (0.5.9 E6): a part held and dragged or trimmed
 * (DragPreview, so useTimelineItemDrag, useContentTrim and useFramedDrag), the viewport scrolled or zoomed
 * (useTimelineViewport). The OBS live canvas reads it to draw fewer frames meanwhile, so the drag keeps the main
 * thread. A report is one number written, no React state and no listener; the reader asks when it needs to know.
 */

/** How long after the last report the timeline still counts as moving. */
export const TIMELINE_REST_MS = 300;

export type MotionReport = { moved(): void };

export class TimelineMotion implements MotionReport {
  private last = Number.NEGATIVE_INFINITY;

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** Something on the timeline moved just now. */
  moved(): void { this.last = this.now(); }

  /** Whether it moved within the last 300 ms. */
  moving(): boolean { return this.now() - this.last < TIMELINE_REST_MS; }
}

/** The editor's timeline: the drags and the viewport report to it, the OBS live canvas reads it. */
export const timelineMotion = new TimelineMotion();
