import { useRef, useState, type PointerEvent } from 'react';
import { playbackFramesPerSecond, timecodeToMilliseconds } from '@tb/core/link';
import type { LinkCue, MtcFrameRate, ReferenceMediaClip } from '@tb/schema';
import { resizeTimelineSpan, snapTimelineTime, timelineInteractionTime } from './timeline-geometry';

export type ClipResizeDrag = {
  id: string;
  edge: 'start' | 'end';
  pointerId: number;
  originStartMs: number;
  originDurationMs: number;
  originSourceOffsetMs: number;
  sourceDurationMs: number | null;
  previewStartMs: number;
  previewDurationMs: number;
};

type ResizeInput = {
  durationMs: number;
  frameRate: MtcFrameRate;
  timeAtClientX: (clientX: number) => number;
  focusTimeline: () => void;
  snapEnabled: boolean;
  getSnapPointsMs: (itemId: string) => readonly number[];
  snapThresholdMs: number;
};

export function useClipResize(input: ResizeInput & {
  onTrimClip: (clipId: string, startMs: number, durationMs: number) => void;
  onSelectClip: (clipId: string) => void;
}) {
  const [drag, setDrag] = useState<ClipResizeDrag | null>(null);
  const dragRef = useRef<ClipResizeDrag | null>(null);
  const resolve = (current: ClipResizeDrag, clientX: number): ClipResizeDrag => {
    const framesPerSecond = playbackFramesPerSecond(input.frameRate);
    const minimum = snapTimelineTime(1_000 / framesPerSecond, input.frameRate);
    const pointerMs = timelineInteractionTime(input.timeAtClientX(clientX), input.durationMs, input.frameRate, input.snapEnabled, input.getSnapPointsMs(current.id), input.snapThresholdMs);
    const preview = resizeTimelineSpan({
      edge: current.edge,
      originStartMs: current.originStartMs,
      originDurationMs: current.originDurationMs,
      originSourceOffsetMs: current.originSourceOffsetMs,
      sourceDurationMs: current.sourceDurationMs,
      timelineDurationMs: input.durationMs,
      pointerMs,
      minimumDurationMs: minimum
    });
    return { ...current, previewStartMs: preview.startMs, previewDurationMs: preview.durationMs };
  };
  const begin = (event: PointerEvent<HTMLElement>, clip: ReferenceMediaClip, edge: 'start' | 'end', sourceDurationMs?: number): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    input.focusTimeline();
    event.currentTarget.setPointerCapture(event.pointerId);
    input.onSelectClip(clip.id);
    const startMs = timecodeToMilliseconds(clip.startTimecode, input.frameRate);
    const next: ClipResizeDrag = {
      id: clip.id,
      edge,
      pointerId: event.pointerId,
      originStartMs: startMs,
      originDurationMs: clip.durationMs,
      originSourceOffsetMs: clip.sourceOffsetMs ?? 0,
      sourceDurationMs: sourceDurationMs ?? null,
      previewStartMs: startMs,
      previewDurationMs: clip.durationMs
    };
    dragRef.current = next;
    setDrag(next);
  };
  const move = (event: PointerEvent<HTMLElement>): void => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const next = resolve(current, event.clientX);
    dragRef.current = next;
    setDrag(next);
  };
  const end = (event: PointerEvent<HTMLElement>): void => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const completed = resolve(current, event.clientX);
    dragRef.current = null;
    setDrag(null);
    if (completed.previewDurationMs !== completed.originDurationMs || completed.previewStartMs !== completed.originStartMs) {
      input.onTrimClip(completed.id, completed.previewStartMs, completed.previewDurationMs);
    }
  };
  const cancel = (event: PointerEvent<HTMLElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDrag(null);
  };
  return { begin, cancel, drag, end, move };
}

export type CueResizeDrag = {
  id: string;
  edge: 'start' | 'end';
  pointerId: number;
  startClientX: number;
  originPointerMs: number;
  originStartMs: number;
  originDurationMs: number;
  previewStartMs: number;
  previewDurationMs: number;
};

export function useCueResize(input: ResizeInput & {
  onTrimCue: (cueId: string, startMs: number, durationMs: number) => void;
  onSelectCue: (cueId: string) => void;
}) {
  const [drag, setDrag] = useState<CueResizeDrag | null>(null);
  const dragRef = useRef<CueResizeDrag | null>(null);
  const resolve = (current: CueResizeDrag, clientX: number): CueResizeDrag => {
    if (Math.abs(clientX - current.startClientX) < 3) return current;
    const framesPerSecond = playbackFramesPerSecond(input.frameRate);
    const minimum = 1_000 / framesPerSecond;
    const pointerMs = timelineInteractionTime((current.edge === 'start' ? current.originStartMs : current.originStartMs + current.originDurationMs) + input.timeAtClientX(clientX) - current.originPointerMs, input.durationMs, input.frameRate, input.snapEnabled, input.getSnapPointsMs(current.id), input.snapThresholdMs);
    const endMs = current.originStartMs + current.originDurationMs;
    if (current.edge === 'start') {
      const startMs = Math.max(0, Math.min(endMs - minimum, pointerMs));
      return { ...current, previewStartMs: startMs, previewDurationMs: endMs - startMs };
    }
    return { ...current, previewDurationMs: Math.max(minimum, Math.min(input.durationMs - current.originStartMs, pointerMs - current.originStartMs)) };
  };
  const begin = (event: PointerEvent<HTMLElement>, cue: LinkCue, durationMs: number, edge: 'start' | 'end'): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    input.focusTimeline();
    event.currentTarget.setPointerCapture(event.pointerId);
    input.onSelectCue(cue.id);
    const startMs = timecodeToMilliseconds(cue.timecode, input.frameRate);
    const next: CueResizeDrag = { id: cue.id, edge, pointerId: event.pointerId, startClientX: event.clientX, originPointerMs: input.timeAtClientX(event.clientX), originStartMs: startMs, originDurationMs: durationMs, previewStartMs: startMs, previewDurationMs: durationMs };
    dragRef.current = next;
    setDrag(next);
  };
  const move = (event: PointerEvent<HTMLElement>): void => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const next = resolve(current, event.clientX);
    dragRef.current = next;
    setDrag(next);
  };
  const end = (event: PointerEvent<HTMLElement>): void => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const completed = resolve(current, event.clientX);
    dragRef.current = null;
    setDrag(null);
    if (completed.previewStartMs !== completed.originStartMs || completed.previewDurationMs !== completed.originDurationMs) {
      input.onTrimCue(completed.id, completed.previewStartMs, completed.previewDurationMs);
    }
  };
  const cancel = (event: PointerEvent<HTMLElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDrag(null);
  };
  return { begin, cancel, drag, end, move };
}
