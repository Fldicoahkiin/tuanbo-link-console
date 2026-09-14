import { describe, expect, it } from 'vitest';
import type { MtcSample } from '@tb/core/link';
import { MtcStabilityTracker } from './mtc-stability-tracker';

describe('MtcStabilityTracker', () => {
  it('连续满 500ms 后才稳定，跳变与重置都会重新计时', () => {
    const tracker = new MtcStabilityTracker();
    let previous: MtcSample | null = null;
    const update = (frame: number, receivedAtMs: number): boolean => {
      const current = sample(frame, receivedAtMs);
      const stable = tracker.update(previous, current);
      previous = current;
      return stable;
    };

    expect(update(0, 0)).toBe(false);
    expect(update(3, 100)).toBe(false);
    expect(update(12, 400)).toBe(false);
    expect(update(18, 600)).toBe(true);
    expect(update(90, 700)).toBe(false);
    expect(update(93, 800)).toBe(false);
    tracker.reset();
    expect(update(96, 900)).toBe(false);
  });
});

function sample(totalFrames: number, receivedAtMs: number): MtcSample {
  const seconds = Math.floor(totalFrames / 30);
  return {
    frameRate: '30',
    totalFrames,
    receivedAtMs,
    direction: 'forward',
    timecode: { hours: 0, minutes: 0, seconds, frames: totalFrames % 30 }
  };
}
