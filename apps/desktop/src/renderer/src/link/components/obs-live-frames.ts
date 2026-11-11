import { animationFrames, type FrameScheduler } from './drag-preview';
import { timelineMotion } from './timeline-motion';

/*
 * How often the OBS live canvas asks for a frame (0.5.9 E6, 05 设计 4.8). The loop runs on animation frames and asks
 * the main process for the next frame only when one is due, one request at a time, so the main process and the
 * native preview bridge do less work too: 30 frames a second; about 10 while a timeline part is dragged or the
 * timeline scrolls or zooms (timeline-motion.ts), back to 30 once it rested 300 ms. While a source is moved on the
 * live canvas itself there is no cap beyond the display's frames, as before, so what is dragged there stays smooth.
 */

export const LIVE_FRAME_MS = 1_000 / 30;
export const MOVING_FRAME_MS = 100;
/** A due frame may come this much early: animation frames do not land on the exact millisecond. */
const EARLY_MS = 1;

/** The time between two requests now. */
export function liveFrameInterval(state: { editingCanvas: boolean; timelineMoving: boolean }): number {
  if (state.editingCanvas) return 0;
  return state.timelineMoving ? MOVING_FRAME_MS : LIVE_FRAME_MS;
}

export type LiveFrameWork<F> = {
  /** Asks for the next frame (the shared preview session). */
  fetch: () => Promise<F>;
  draw: (frame: F) => void;
  /** Whether a source is being moved on the live canvas. */
  editingCanvas: () => boolean;
  /** The loop ended on a failure; nothing more is asked. */
  failed: (reason: unknown) => void;
};

export type LiveFrameClock = { frames: FrameScheduler; now: () => number; timelineMoving: () => boolean };

const browserClock: LiveFrameClock = { frames: animationFrames, now: () => performance.now(), timelineMoving: () => timelineMotion.moving() };

/** One live canvas's frames, from `start` until `stop` or a failure. */
export class LiveFrameLoop<F> {
  private frame: number | null = null;
  private last = Number.NEGATIVE_INFINITY;
  private over = false;

  constructor(private readonly work: LiveFrameWork<F>, private readonly clock: LiveFrameClock = browserClock) {}

  start(): void { this.wait(); }

  /** No more frames are asked for or drawn; a request already out is let go. */
  stop(): void {
    this.over = true;
    if (this.frame !== null) this.clock.frames.cancel(this.frame);
    this.frame = null;
  }

  get stopped(): boolean { return this.over; }

  private wait(): void {
    if (!this.over) this.frame = this.clock.frames.request(this.tick);
  }

  private readonly tick = (): void => {
    this.frame = null;
    if (this.over) return;
    const now = this.clock.now();
    const interval = liveFrameInterval({ editingCanvas: this.work.editingCanvas(), timelineMoving: this.clock.timelineMoving() });
    const due = this.last + interval;
    if (now < due - EARLY_MS) { this.wait(); return; }
    // Kept on the beat (no drift from late frames), unless the loop fell a whole interval behind.
    this.last = now - due < interval ? due : now;
    this.work.fetch().then((frame) => {
      if (this.over) return;
      this.work.draw(frame);
      this.wait();
    }).catch((reason: unknown) => {
      if (this.over) return;
      this.over = true;
      this.work.failed(reason);
    });
  };
}

/** Whether the canvas asks for frames at all: not while the window is hidden, the preview is put aside for a repair, or after a failure (until 修复 or 刷新). */
export function livePreviewWanted(state: { visible: boolean; suspended: boolean; failed: boolean }): boolean {
  return state.visible && !state.suspended && !state.failed;
}

/** The shared preview session (obs-preview-session), as the canvas uses it. */
export type LivePreview<F> = { next: () => Promise<F>; close: () => Promise<void> };

/** One preview session's frames, from `run` until `stop` (hidden, unmounted) or a failure; the session is closed after. */
export function livePreviewRun<F>(preview: LivePreview<F>, work: Omit<LiveFrameWork<F>, 'fetch'>, clock: LiveFrameClock = browserClock): { run: () => Promise<void>; stop: () => void } {
  let stopped = false;
  let loop: LiveFrameLoop<F> | null = null;
  let ended: (() => void) | null = null;
  return {
    run: async () => {
      try {
        await new Promise<void>((resolve) => {
          if (stopped) { resolve(); return; }
          ended = resolve;
          loop = new LiveFrameLoop({ ...work, fetch: () => preview.next(), failed: (reason) => { work.failed(reason); resolve(); } }, clock);
          loop.start();
        });
      } finally { await preview.close(); }
    },
    stop: () => { stopped = true; loop?.stop(); ended?.(); }
  };
}

/** What a frame is, as drawn: RGBA, four bytes a pixel. */
export type LiveFrame = { width: number; height: number; rgba: Uint8Array };

type Surface = { width: number; height: number; getContext(kind: '2d', options: { alpha: false }): Pick<CanvasRenderingContext2D, 'putImageData'> | null };

/**
 * Draws frames onto the canvas with one `ImageData`, made again only when the frame's size changes; the context is
 * asked for once per canvas.
 */
export class LiveFramePainter {
  private surface: Surface | null = null;
  private context: Pick<CanvasRenderingContext2D, 'putImageData'> | null = null;
  private image: ImageData | null = null;

  constructor(private readonly target: () => Surface | null, private readonly createImage: (width: number, height: number) => ImageData = (width, height) => new ImageData(width, height)) {}

  draw(frame: LiveFrame): void {
    const surface = this.target();
    if (surface !== this.surface) { this.surface = surface; this.context = surface?.getContext('2d', { alpha: false }) ?? null; this.image = null; }
    if (!surface || !this.context) throw new Error('无法创建 OBS 实时画布');
    if (frame.rgba.byteLength !== frame.width * frame.height * 4) throw new Error('OBS 预览画面数据不完整');
    if (surface.width !== frame.width || surface.height !== frame.height) { surface.width = frame.width; surface.height = frame.height; }
    if (!this.image || this.image.width !== frame.width || this.image.height !== frame.height) this.image = this.createImage(frame.width, frame.height);
    this.image.data.set(frame.rgba);
    this.context.putImageData(this.image, 0, 0);
  }
}
