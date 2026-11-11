import { useEffect, useRef } from 'react';
import type { MtcFrameRate } from '@tb/schema';
import { playbackFramesPerSecond } from '@tb/core/link';
import type { EditorPlayhead } from './editor-playhead';

export function useTimelinePlaybackClock(props: {
  playing: boolean;
  /** Where playing starts from: the playhead when play is pressed. */
  playhead: EditorPlayhead;
  durationMs: number;
  frameRate: MtcFrameRate;
  itemId: string | null;
  onPlayheadChange: (milliseconds: number) => void;
  onPlayingChange: (playing: boolean) => void;
}): void {
  const { durationMs, frameRate, itemId, onPlayheadChange, onPlayingChange, playhead, playing } = props;
  const callbacks = useRef({ onPlayheadChange, onPlayingChange });
  useEffect(() => { callbacks.current = { onPlayheadChange, onPlayingChange }; }, [onPlayheadChange, onPlayingChange]);
  useEffect(() => {
    if (!playing) return;
    const originMs = playhead.read();
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
        callbacks.current.onPlayheadChange(nextMs);
      }
      if (nextMs >= durationMs) {
        callbacks.current.onPlayingChange(false);
        return;
      }
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [durationMs, frameRate, itemId, playhead, playing]);
}
