import {
  frameNumberToTimecode,
  millisecondsToFrameNumber,
  timecodeToMilliseconds
} from '@tb/core/link';
import type { MtcFrameRate } from '@tb/schema';

export const MIN_TIMELINE_PIXELS_PER_SECOND = 0.001;
export const MAX_TIMELINE_PIXELS_PER_SECOND = 480;
export const DEFAULT_TIMELINE_PIXELS_PER_SECOND = 32;
export const MAX_TIMELINE_TIME_MS = 86_399_000;

const TICK_INTERVALS_MS = [
  100,
  200,
  500,
  1_000,
  2_000,
  5_000,
  10_000,
  15_000,
  30_000,
  60_000,
  120_000,
  300_000,
  600_000,
  900_000,
  1_800_000,
  3_600_000,
  7_200_000,
  10_800_000,
  21_600_000
] as const;

export type TimelineTick = {
  milliseconds: number;
  left: number;
  label: string;
};

export function clampTimelineTime(milliseconds: number, durationMs: number): number {
  return Math.min(Math.max(0, milliseconds), Math.max(0, durationMs));
}

export function snapTimelineTime(milliseconds: number, frameRate: MtcFrameRate): number {
  const frame = millisecondsToFrameNumber(Math.max(0, milliseconds), frameRate);
  return timecodeToMilliseconds(frameNumberToTimecode(frame, frameRate), frameRate);
}

export function timelineInteractionTime(
  milliseconds: number,
  durationMs: number,
  frameRate: MtcFrameRate,
  snapEnabled: boolean,
  snapPointsMs: readonly number[] = [],
  snapThresholdMs = 0
): number {
  if (!snapEnabled) return clampTimelineTime(milliseconds, durationMs);
  const frameSnapped = snapTimelineTime(milliseconds, frameRate);
  const closestPoint = snapPointsMs.reduce<{ point: number; distance: number } | null>((closest, point) => {
    const distance = Math.abs(point - milliseconds);
    return closest === null || distance < closest.distance ? { point, distance } : closest;
  }, null);
  const snapped = closestPoint && closestPoint.distance <= snapThresholdMs ? closestPoint.point : frameSnapped;
  return clampTimelineTime(snapped, durationMs);
}

/** Convert both clip edges to candidate start positions without changing its length. */
export function timelineMoveSnapPoints(points: readonly number[], durationMs: number): number[] {
  return [...new Set(points.flatMap((point) => [point, point - durationMs]).filter((point) => point >= 0))];
}

export function editableTimelineDuration(input: {
  referenceAudioDurationMs?: number;
  media: Array<{ startMs: number; durationMs: number; sourceOffsetMs: number; sourceDurationMs?: number }>;
  cues: Array<{ startMs: number; durationMs: number }>;
}): number {
  const mediaEnd = input.media.reduce((end, span) => Math.max(end, span.startMs + span.durationMs), 0);
  const cueEnd = input.cues.reduce((end, span) => Math.max(end, span.startMs + span.durationMs), 0);
  return Math.max(input.referenceAudioDurationMs ?? 0, mediaEnd, cueEnd) || 60_000;
}

export function timelineContentWidth(durationMs: number, pixelsPerSecond: number, viewportWidth: number): number {
  return Math.max(viewportWidth, durationMs / 1_000 * pixelsPerSecond);
}

export function timelineSpanWidth(durationMs: number, pixelsPerSecond: number, minimumWidth = 2): number {
  return Math.max(minimumWidth, durationMs / 1_000 * pixelsPerSecond);
}

export function fitTimelinePixelsPerSecond(durationMs: number, viewportWidth: number): number {
  const fitted = viewportWidth / Math.max(0.001, durationMs / 1_000);
  return Math.min(MAX_TIMELINE_PIXELS_PER_SECOND, Math.max(MIN_TIMELINE_PIXELS_PER_SECOND, fitted));
}

/** Where a time is on the timeline's content, in px: the DOM parts and the canvas layer (TimelineCanvasLayer) both
 * place by this, so the two always agree. */
export function timeToX(milliseconds: number, pixelsPerSecond: number): number {
  return milliseconds / 1_000 * pixelsPerSecond;
}

export function timelineTimeFromClientX(input: {
  clientX: number;
  viewportLeft: number;
  scrollLeft: number;
  pixelsPerSecond: number;
  durationMs: number;
}): number {
  const contentX = input.clientX - input.viewportLeft + input.scrollLeft;
  return clampTimelineTime(contentX / input.pixelsPerSecond * 1_000, input.durationMs);
}

/** The time at `clientX` while editing: not held to the song's length, only to a day (a part may be moved past the end). */
export function timelineEditTimeFromClientX(input: { clientX: number; viewportLeft: number; scrollLeft: number; pixelsPerSecond: number }): number {
  return Math.min(MAX_TIMELINE_TIME_MS, Math.max(0, (input.clientX - input.viewportLeft + input.scrollLeft) / input.pixelsPerSecond * 1000));
}

export function chooseTimelineTickInterval(pixelsPerSecond: number): number {
  return TICK_INTERVALS_MS.find((interval) => interval / 1_000 * pixelsPerSecond >= 72)
    ?? TICK_INTERVALS_MS.at(-1)!;
}

export function buildVisibleTimelineTicks(input: {
  durationMs: number;
  pixelsPerSecond: number;
  scrollLeft: number;
  viewportWidth: number;
}): TimelineTick[] {
  const interval = chooseTimelineTickInterval(input.pixelsPerSecond);
  const visibleStartMs = Math.max(0, input.scrollLeft / input.pixelsPerSecond * 1_000 - interval);
  const visibleEndMs = Math.min(
    input.durationMs,
    (input.scrollLeft + input.viewportWidth) / input.pixelsPerSecond * 1_000 + interval
  );
  const first = Math.floor(visibleStartMs / interval) * interval;
  const ticks: TimelineTick[] = [];
  for (let milliseconds = first; milliseconds <= visibleEndMs; milliseconds += interval) {
    ticks.push({
      milliseconds,
      left: milliseconds / 1_000 * input.pixelsPerSecond,
      label: formatTimelineRulerTime(milliseconds, interval)
    });
  }
  return ticks;
}

export function formatTimelineTimecode(milliseconds: number, frameRate: MtcFrameRate, full = false): string {
  const timecode = frameNumberToTimecode(millisecondsToFrameNumber(Math.max(0, milliseconds), frameRate), frameRate);
  const values = [timecode.hours, timecode.minutes, timecode.seconds, timecode.frames]
    .map((value) => String(value).padStart(2, '0'));
  const separator = frameRate === '29.97df' ? ';' : ':';
  const prefix = full || timecode.hours > 0 ? `${values[0]}:${values[1]}:` : timecode.minutes > 0 ? `${values[1]}:` : '';
  return `${prefix}${values[2]}${separator}${values[3]}`;
}

function formatTimelineRulerTime(milliseconds: number, interval: number): string {
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor(totalSeconds % 3_600 / 60);
  const seconds = totalSeconds % 60;
  const prefix = hours > 0 ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:` : minutes > 0 ? `${String(minutes).padStart(2, '0')}:` : '';
  if (interval < 1_000) {
    return `${prefix}${String(seconds).padStart(2, '0')}.${String(Math.floor(milliseconds % 1_000 / 100))}`;
  }
  return `${prefix}${String(seconds).padStart(2, '0')}`;
}
