import { describe, expect, it, vi } from 'vitest';
import { EditorPlayhead, playheadBoundaries, segmentAt, segmentStartMs, timelineStateBoundaries } from './editor-playhead';

describe('编辑器播放头不经 React（0.5.9 E2）', () => {
  it('每次移动告诉订阅者一次，位置没变就不告诉', () => {
    const playhead = new EditorPlayhead();
    const heard = vi.fn();
    const stop = playhead.subscribeFrame(heard);
    playhead.set(40); playhead.set(40); playhead.set(80);
    expect(heard.mock.calls).toEqual([[40], [80]]);
    stop();
    playhead.set(120);
    expect(heard).toHaveBeenCalledTimes(2);
    expect(playhead.read()).toBe(120);
  });

  it('画的时候放好的位置不告诉人，之后 set 同一个值时才告诉', () => {
    const playhead = new EditorPlayhead(0);
    const heard = vi.fn();
    playhead.subscribeFrame(heard);
    playhead.place(500);
    expect(playhead.read()).toBe(500);
    expect(heard).not.toHaveBeenCalled();
    playhead.set(500);
    expect(heard.mock.calls).toEqual([[500]]);
  });

  it('段号只在跨过边界时变：1 秒推 200 次，跨过 2 个边界只通知 2 次', () => {
    const boundaries = playheadBoundaries([2_300, 2_000, 2_000, 4_000, 2_600]);
    expect(boundaries).toEqual([2_000, 2_300, 2_600, 4_000]);
    const playhead = new EditorPlayhead(1_900);
    const segments: number[] = [];
    playhead.watch(ms => segmentAt(boundaries, ms), segment => segments.push(segment));
    for (let step = 1; step <= 200; step += 1) playhead.set(1_900 + step * 5);
    expect(playhead.read()).toBe(2_900);
    expect(segments).toEqual([1, 2, 3]);
  });

  it('边界本身算后一段（片段从开始那一刻起算，到结束那一刻为止不算）', () => {
    const boundaries = [2_000, 4_000];
    expect(segmentAt(boundaries, 1_999)).toBe(0);
    expect(segmentAt(boundaries, 2_000)).toBe(1);
    expect(segmentAt(boundaries, 3_999)).toBe(1);
    expect(segmentAt(boundaries, 4_000)).toBe(2);
    expect(segmentStartMs(boundaries, 0)).toBe(0);
    expect(segmentStartMs(boundaries, 1)).toBe(2_000);
    expect(segmentStartMs(boundaries, 2)).toBe(4_000);
    expect(segmentAt([], 1_000)).toBe(0);
  });

  it('时间线状态的边界是素材和机位的开始与结束', () => {
    expect(timelineStateBoundaries({
      clips: [{ startMs: 1_000, endMs: 3_000 }],
      visualObsCues: [{ startMs: 3_000, endMs: 5_000 }]
    })).toEqual([1_000, 3_000, 5_000]);
  });
});
