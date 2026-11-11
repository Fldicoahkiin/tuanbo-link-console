import { playbackFramesPerSecond, type ContentRef } from '@tb/core/link';
import type { MtcFrameRate } from '@tb/schema';
import { timelineEditTimeFromClientX, timelineInteractionTime, timelineMoveSnapPoints } from './timeline-geometry';
import { timelineMotion, type MotionReport } from './timeline-motion';

/*
 * A drag or trim on the editor's tracks without React on every move (0.5.9 E3, 05 设计 4.5). The press takes a
 * snapshot of all a move needs: where the timeline is on screen, where each track is (from the layout, not the DOM),
 * the points the part snaps to and the timeline's rules (`contentEditRules`). A move only keeps the pointer and asks
 * for a frame; in the frame `dragTarget` / `trimTarget` work out where the part goes, the same as the drag did on
 * every move before, and the part is moved straight in the DOM. React hears only when what it draws changes: the
 * target track, whether the place there is taken (a new track above), the snap guide. Let go, the last pointer is
 * worked out at once and the edit is one command, as before.
 */

/** Each track's row is this high (timeline-layout.ts). */
export const TRACK_HEIGHT = 50;

/** The timeline viewport on screen at the press: its visible box (no scrollbars), its scroll and its scale. */
export type DragViewport = {
  left: number; top: number; width: number; height: number;
  scrollLeft: number; scrollTop: number; pixelsPerSecond: number;
};

/** A track's row in the timeline's content, in pixels from the content's top. */
export type TrackBand = { layerId: string; top: number; bottom: number; locked: boolean };

/**
 * Where the tracks are: their rows, the drop area for a new track below them, and how much of the viewport's top the
 * ruler covers (it stays put while the tracks scroll under it).
 */
export type TrackLayout = { bands: readonly TrackBand[]; newTrackTop: number; coveredTop: number };

/** The rows of `layers` in the editor's grid (timeline-layout.ts `visualTracks`): the lighting row sits between them. */
export function trackLayout(layers: readonly { id: string; locked: boolean }[], tracks: { start: number; lightingIndex: number; lightingHeight: number; coveredTop: number }): TrackLayout {
  const bands = layers.map((layer, index) => {
    const top = tracks.start + index * TRACK_HEIGHT + (index >= tracks.lightingIndex ? tracks.lightingHeight : 0);
    return { layerId: layer.id, top, bottom: top + TRACK_HEIGHT, locked: layer.locked };
  });
  return { bands, newTrackTop: tracks.start + layers.length * TRACK_HEIGHT + tracks.lightingHeight, coveredTop: tracks.coveredTop };
}

/** What is under the pointer: a track, the drop area for a new track, or neither (the ruler, a sound or lighting row, outside the timeline). */
export type TrackHit = { kind: 'track'; layerId: string; locked: boolean } | { kind: 'new' } | null;

/**
 * The track at `clientY` on screen. It replaces asking the page what lies under the pointer (`elementFromPoint`),
 * which laid the page out again on every move: the rows are where the layout puts them, and the ruler covers the
 * top of the viewport. `clientX` outside the viewport (the track headings, the stage) is over no track.
 */
export function trackAtY(snapshot: { viewport: DragViewport; layout: TrackLayout }, clientY: number, clientX?: number): TrackHit {
  const { viewport, layout } = snapshot;
  if (clientX !== undefined && (clientX < viewport.left || clientX >= viewport.left + viewport.width)) return null;
  const local = clientY - viewport.top;
  if (local < layout.coveredTop || local >= viewport.height) return null;
  const y = local + viewport.scrollTop;
  const band = layout.bands.find(entry => y >= entry.top && y < entry.bottom);
  if (band) return { kind: 'track', layerId: band.layerId, locked: band.locked };
  return y >= layout.newTrackTop ? { kind: 'new' } : null;
}

/**
 * The points a part snaps to, as the drag asked for them before: the timeline's own (its start, its end, every
 * clip's and camera's edges, instant cues; `before` and `after` the playhead) and the song audio's cut points. The
 * playhead is read in the frame, so a drag while the song plays snaps to where it is now, as it did.
 */
export type DragSnap = { enabled: boolean; thresholdMs: number; before: readonly number[]; after: readonly number[]; audio: readonly number[] };

/** A clip or camera being moved, and everything about it fixed at the press. */
export type ItemDragSnapshot = {
  viewport: DragViewport;
  layout: TrackLayout;
  frameRate: MtcFrameRate;
  durationMs: number;
  snap: DragSnap;
  /** Whether a place on a track is taken (`contentEditRules`, the rule in core content-timeline.ts). */
  placeTaken: (ref: ContentRef, startMs: number, layerId: string) => boolean;
  ref: ContentRef;
  originMs: number;
  itemDurationMs: number;
  grabOffsetMs: number;
  startClientX: number;
  startClientY: number;
  originLayerId: string | undefined;
  layerMovable: boolean;
};

/** The pointer in a frame: where it is, whether it went far enough to count as a move (kept from every move), and the playhead now. */
export type DragPointer = { clientX: number; clientY: number; moved: boolean; playheadMs: number };

/** Where a moved part lands. `layerId` null: on a new track (the drop area); `taken`: the place is taken, so on a new track above. */
export type ItemDragTarget = {
  moved: boolean;
  startMs: number;
  offsetY: number;
  layerId: string | null | undefined;
  taken: boolean;
  /** The snap point the part's start or end sits on, for the guide; only for the timeline's own points. */
  snapMs: number | undefined;
};

/** Whether the pointer went far enough from the press to move the part (4 px). */
export function pointerMoved(snapshot: Pick<ItemDragSnapshot, 'startClientX' | 'startClientY'>, clientX: number, clientY: number): boolean {
  return Math.hypot(clientX - snapshot.startClientX, clientY - snapshot.startClientY) >= 4;
}

/** The time at `clientX` while editing (not held to the song's length). */
export function snapshotTimeAt(viewport: DragViewport, clientX: number): number {
  return timelineEditTimeFromClientX({ clientX, viewportLeft: viewport.left, scrollLeft: viewport.scrollLeft, pixelsPerSecond: viewport.pixelsPerSecond });
}

/** Where the moved part lands with the pointer at `pointer`: the same time, snap and track as the drag worked out before E3. */
export function dragTarget(snapshot: ItemDragSnapshot, pointer: DragPointer): ItemDragTarget {
  const { moved } = pointer;
  if (!moved) return { moved, startMs: snapshot.originMs, offsetY: 0, layerId: snapshot.originLayerId, taken: false, snapMs: undefined };
  const { snap } = snapshot;
  const timeline = [...snap.before, pointer.playheadMs, ...snap.after];
  const wantedMs = snapshotTimeAt(snapshot.viewport, pointer.clientX) - snapshot.grabOffsetMs;
  const startMs = timelineInteractionTime(wantedMs, Math.max(snapshot.durationMs, wantedMs), snapshot.frameRate, snap.enabled,
    snap.enabled ? timelineMoveSnapPoints([...timeline, ...snap.audio], snapshot.itemDurationMs) : [], snap.thresholdMs);
  const hit = snapshot.layerMovable ? trackAtY(snapshot, pointer.clientY, pointer.clientX) : null;
  const layerId = !snapshot.layerMovable || hit === null ? snapshot.originLayerId : hit.kind === 'new' ? null : hit.layerId;
  const band = typeof layerId === 'string' ? snapshot.layout.bands.find(entry => entry.layerId === layerId) : undefined;
  return {
    moved,
    startMs,
    offsetY: snapshot.layerMovable ? pointer.clientY - snapshot.startClientY : 0,
    layerId,
    taken: band !== undefined && !band.locked && snapshot.placeTaken(snapshot.ref, startMs, band.layerId),
    snapMs: snap.enabled ? timeline.find(point => Math.abs(point - startMs) < 1 || Math.abs(point - startMs - snapshot.itemDurationMs) < 1) : undefined
  };
}

/** How far a part can be trimmed: its neighbours on the track and, for video and sound, the ends of the source (core contentTrimBounds). */
export type TrimBounds = { minStartMs: number; maxEndMs: number };

/** A clip or camera being trimmed, fixed at the press. */
export type TrimSnapshot = {
  viewport: DragViewport;
  frameRate: MtcFrameRate;
  snap: Omit<DragSnap, 'audio'>;
  edge: 'start' | 'end';
  startClientX: number;
  originPointerMs: number;
  originStartMs: number;
  originDurationMs: number;
  bounds: TrimBounds;
};

/** Trimming never reaches past a day; the bounds stop it well before. */
const TRIM_LIMIT_MS = 86_399_000;

/** Where a trim lands with the dragged edge at `edgeMs`: inside the bounds and at least `minimumMs` long, the other edge staying put. */
export function trimPreview(drag: Pick<TrimSnapshot, 'edge' | 'originStartMs' | 'originDurationMs' | 'bounds'>, edgeMs: number, minimumMs: number): { startMs: number; durationMs: number } {
  const endMs = drag.originStartMs + drag.originDurationMs;
  if (drag.edge === 'start') {
    const startMs = Math.min(endMs - minimumMs, Math.max(drag.bounds.minStartMs, edgeMs));
    return { startMs, durationMs: endMs - startMs };
  }
  const end = Math.max(drag.originStartMs + minimumMs, Math.min(drag.bounds.maxEndMs, edgeMs));
  return { startMs: drag.originStartMs, durationMs: end - drag.originStartMs };
}

/** The trimmed part with the pointer at `clientX`; within 3 px of the press it stays as `previous`, as before. */
export function trimTarget(snapshot: TrimSnapshot, clientX: number, playheadMs: number, previous: { startMs: number; durationMs: number }): { startMs: number; durationMs: number } {
  if (Math.abs(clientX - snapshot.startClientX) < 3) return previous;
  const originEdgeMs = snapshot.edge === 'start' ? snapshot.originStartMs : snapshot.originStartMs + snapshot.originDurationMs;
  const edgeMs = timelineInteractionTime(originEdgeMs + snapshotTimeAt(snapshot.viewport, clientX) - snapshot.originPointerMs, TRIM_LIMIT_MS,
    snapshot.frameRate, snapshot.snap.enabled, [...snapshot.snap.before, playheadMs, ...snapshot.snap.after], snapshot.snap.thresholdMs);
  return trimPreview(snapshot, edgeMs, 1_000 / playbackFramesPerSecond(snapshot.frameRate));
}

/** How frames are asked for: the browser's animation frames, or a test's. */
export type FrameScheduler = { request: (draw: () => void) => number; cancel: (frame: number) => void };
export const animationFrames: FrameScheduler = {
  request: draw => requestAnimationFrame(draw),
  cancel: frame => cancelAnimationFrame(frame)
};

/** What a preview does with a pointer: work out the result, move the part in the DOM, tell React when what it draws changed. */
export type DragPreviewWork<P, R> = {
  target: (pointer: P) => R;
  /** False once the dragged part left the page: nothing is moved any more, and the release does nothing. */
  alive: () => boolean;
  paint: (result: R) => void;
  /** Puts the part back where React drew it, once the drag is over. */
  restore: () => void;
  /** What React draws of a result; `changed` hears a result only when it differs. */
  drawn: (result: R) => string;
  changed: (result: R) => void;
};

/**
 * One drag's frames: many moves in a frame are worked out once, in the frame; the release is worked out at once from
 * where the pointer was let go. Over (Escape, the part gone, the release), it writes nothing more.
 */
export class DragPreview<P, R> {
  private pending: P | null = null;
  private last: P | null = null;
  private frame: number | null = null;
  private shown: string;
  private over = false;

  constructor(private readonly work: DragPreviewWork<P, R>, initial: R, private readonly frames: FrameScheduler = animationFrames, private readonly motion: MotionReport = timelineMotion) {
    this.shown = work.drawn(initial);
  }

  /** The pointer moved: kept, and worked out in the next frame. The timeline counts as moving (timeline-motion.ts). */
  move(pointer: P): void {
    if (this.over) return;
    this.motion.moved();
    this.pending = pointer;
    this.last = pointer;
    if (this.frame === null) this.frame = this.frames.request(this.draw);
  }

  /** The snapshot changed under the pointer (scrolled, zoomed): the last pointer is worked out again in the next frame. */
  redraw(): void {
    if (this.last !== null) this.move(this.last);
  }

  /** Let go at `pointer`: its result now, for the one command; null when the drag is over already or the part is gone. */
  release(pointer: P): R | null {
    if (this.over) return null;
    const result = this.work.alive() ? this.work.target(pointer) : null;
    this.stop();
    return result;
  }

  /** The drag is over: no more frames, and the part goes back to where React draws it. */
  stop(): void {
    if (this.over) return;
    this.over = true;
    if (this.frame !== null) this.frames.cancel(this.frame);
    this.frame = null;
    this.pending = null;
    this.work.restore();
  }

  get stopped(): boolean { return this.over; }

  private readonly draw = (): void => {
    this.frame = null;
    const pointer = this.pending;
    this.pending = null;
    if (pointer === null || this.over) return;
    if (!this.work.alive()) { this.stop(); return; }
    const result = this.work.target(pointer);
    this.work.paint(result);
    const drawn = this.work.drawn(result);
    if (drawn === this.shown) return;
    this.shown = drawn;
    this.work.changed(result);
  };
}
