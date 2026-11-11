import { describe, expect, it } from 'vitest';
import { DragPreview, type FrameScheduler } from './drag-preview';
import { TIMELINE_REST_MS, TimelineMotion } from './timeline-motion';

describe('时间线在不在动', () => {
  it('报过一次后 300 ms 内算在动，之后不算', () => {
    let time = 1_000;
    const motion = new TimelineMotion(() => time);
    expect(motion.moving()).toBe(false);
    motion.moved();
    time += TIMELINE_REST_MS - 1;
    expect(motion.moving()).toBe(true);
    time += 1;
    expect(motion.moving()).toBe(false);
  });

  it('拖动时间线上的片段（DragPreview）每次移动都报一次，Esc 之后不再报', () => {
    let reports = 0;
    const frames: FrameScheduler = { request: () => 1, cancel: () => undefined };
    const drag = new DragPreview<number, number>({
      target: (x) => x,
      alive: () => true,
      paint: () => undefined,
      restore: () => undefined,
      drawn: (result) => String(result),
      changed: () => undefined
    }, 0, frames, { moved: () => { reports += 1; } });
    drag.move(1); drag.move(2);
    expect(reports).toBe(2);
    drag.stop();
    drag.move(3);
    expect(reports).toBe(2);
  });
});
