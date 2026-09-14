import { useEffect, useRef } from 'react';
import type { MtcFrameRate } from '@tb/schema';
import { playbackFramesPerSecond } from '@tb/core/link';

export function useTimelinePlaybackClock(props: {
  playing: boolean;
  playheadMs: number;
  durationMs: number;
  frameRate: MtcFrameRate;
  itemId: string | null;
  onPlayheadChange: (milliseconds: number) => void;
  onPlayingChange: (playing: boolean) => void;
}): void {
  const { durationMs, frameRate, itemId, onPlayheadChange, onPlayingChange, playheadMs, playing } = props;
  const playheadRef = useRef(playheadMs);
  useEffect(() => { playheadRef.current = playheadMs; }, [playheadMs]);
  useEffect(() => {
    if (!playing) return;
    const originMs = playheadRef.current;
    const startedAt = performance.now();
    const framesPerSecond = playbackFramesPerSecond(frameRate);
    const updateIntervalMs = 1_000 / framesPerSecond;
    let previousElapsedFrame = 0;
    let frame = 0;
    const update = (now: number): void => {
      const elapsedFrame = Math.floor((now - startedAt) / updateIntervalMs);
      const nextMs = Math.min(durationMs, originMs + elapsedFrame * updateIntervalMs);
      if (elapsedFrame > previousElapsedFrame || nextMs >= durationMs) {
        previousElapsedFrame = elapsedFrame;
        playheadRef.current = nextMs;
        onPlayheadChange(nextMs);
      }
      if (nextMs >= durationMs) {
        onPlayingChange(false);
        return;
      }
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [durationMs, frameRate, itemId, onPlayheadChange, onPlayingChange, playing]);
}
