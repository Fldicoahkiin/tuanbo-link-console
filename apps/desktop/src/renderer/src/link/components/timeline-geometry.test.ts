import { describe, expect, it } from 'vitest';
import {
  buildVisibleTimelineTicks,
  chooseTimelineTickInterval,
  clampTimelineTime,
  editableTimelineDuration,
  fitTimelinePixelsPerSecond,
  formatTimelineTimecode,
  resizeTimelineSpan,
  snapTimelineTime,
  timelineInteractionTime,
  timelineMoveSnapPoints,
  timelineContentWidth,
  timelineSpanWidth,
  timelineTimeFromClientX
} from './timeline-geometry';

describe('timeline geometry', () => {
  it('移动片段的左右边缘均可吸附到目标，保持片段时长', () => {
    const points = timelineMoveSnapPoints([0, 5000, 8000], 2000);
    expect(timelineInteractionTime(3100, 20000, '30', true, points, 140)).toBe(3000);
    expect(timelineInteractionTime(4900, 20000, '30', true, points, 140)).toBe(5000);
    expect(timelineInteractionTime(3100, 20000, '30', false, points, 140)).toBe(3100);
    expect(points.every((point) => point >= 0)).toBe(true);
  });
  it('默认使用音频长度，内容超出才延长，移回后恢复音频长度', () => {
    expect(editableTimelineDuration({ referenceAudioDurationMs: 4_000, media: [], cues: [] })).toBe(4_000);
    expect(editableTimelineDuration({ referenceAudioDurationMs: 4_000, media: [], cues: [{ startMs: 5_100, durationMs: 0 }] })).toBe(5_100);
    expect(editableTimelineDuration({ referenceAudioDurationMs: 4_000, media: [], cues: [{ startMs: 3_000, durationMs: 0 }] })).toBe(4_000);
  });
  it('将指针坐标换算为包含滚动偏移的节目时间', () => {
    expect(timelineTimeFromClientX({
      clientX: 350,
      viewportLeft: 100,
      scrollLeft: 500,
      pixelsPerSecond: 50,
      durationMs: 60_000
    })).toBe(15_000);
  });

  it('把时间限制在节目范围内并保证内容至少铺满视口', () => {
    expect(clampTimelineTime(-1, 5_000)).toBe(0);
    expect(clampTimelineTime(8_000, 5_000)).toBe(5_000);
    expect(timelineContentWidth(5_000, 20, 800)).toBe(800);
    expect(timelineContentWidth(60_000, 20, 800)).toBe(1_200);
    expect(timelineSpanWidth(5_000, 0.25)).toBe(2);
    expect(timelineSpanWidth(5_000, 20)).toBe(100);
  });

  it('适合视图对一小时以上节目仍会真正铺满视口', () => {
    const pixelsPerSecond = fitTimelinePixelsPerSecond(3_600_000, 1_200);
    expect(pixelsPerSecond).toBeCloseTo(1 / 3);
    expect(timelineContentWidth(3_600_000, pixelsPerSecond, 1_200)).toBeCloseTo(1_200);
    expect(chooseTimelineTickInterval(pixelsPerSecond)).toBe(300_000);
  });

  it('按工程帧率吸附并格式化 drop-frame 时间码', () => {
    expect(snapTimelineTime(1_016, '30')).toBe(1_000);
    expect(formatTimelineTimecode(60_060, '29.97df')).toBe('00:01:00;02');
  });

  it('允许操作员关闭磁性吸附，同时仍把时间限制在节目范围内', () => {
    expect(timelineInteractionTime(1_016, 5_000, '30', true)).toBe(1_000);
    expect(timelineInteractionTime(1_016, 5_000, '30', false)).toBe(1_016);
    expect(timelineInteractionTime(6_000, 5_000, '30', false)).toBe(5_000);
  });

  it('开启吸附时优先吸附播放头和相邻片段边缘，关闭时保持连续时间', () => {
    expect(timelineInteractionTime(2_936, 10_000, '30', true, [1_000, 3_000, 5_000], 80)).toBe(3_000);
    expect(timelineInteractionTime(2_936, 10_000, '30', false, [3_000], 80)).toBe(2_936);
  });

  it('时间线只计算实际片段末尾，不加入素材余量或空白', () => {
    expect(editableTimelineDuration({
      media: [{ startMs: 5_000, durationMs: 7_000, sourceOffsetMs: 0, sourceDurationMs: 37_000 }],
      cues: []
    })).toBe(12_000);
    expect(editableTimelineDuration({
      media: [{ startMs: 50_000, durationMs: 7_000, sourceOffsetMs: 2_000, sourceDurationMs: 37_000 }],
      cues: []
    })).toBe(57_000);
    expect(editableTimelineDuration({ media: [], cues: [{ startMs: 58_000, durationMs: 5_000 }] })).toBe(63_000);
    expect(editableTimelineDuration({
      media: [{ startMs: 58_000, durationMs: 2_000, sourceOffsetMs: 0 }],
      cues: []
    })).toBe(60_000);
  });

  it('视频左右修剪可以反复恢复且不会超过源时长', () => {
    expect(resizeTimelineSpan({
      edge: 'end', originStartMs: 0, originDurationMs: 2_000, originSourceOffsetMs: 0,
      sourceDurationMs: 10_000, timelineDurationMs: 60_000, pointerMs: 8_000, minimumDurationMs: 33
    })).toEqual({ startMs: 0, durationMs: 8_000 });
    expect(resizeTimelineSpan({
      edge: 'end', originStartMs: 0, originDurationMs: 8_000, originSourceOffsetMs: 0,
      sourceDurationMs: 10_000, timelineDurationMs: 60_000, pointerMs: 12_000, minimumDurationMs: 33
    })).toEqual({ startMs: 0, durationMs: 10_000 });
    expect(resizeTimelineSpan({
      edge: 'start', originStartMs: 3_000, originDurationMs: 5_000, originSourceOffsetMs: 3_000,
      sourceDurationMs: 10_000, timelineDurationMs: 60_000, pointerMs: 0, minimumDurationMs: 33
    })).toEqual({ startMs: 0, durationMs: 8_000 });
  });

  it('图片和 OBS 没有源时长限制时可延长到合理时间线范围', () => {
    expect(resizeTimelineSpan({
      edge: 'end', originStartMs: 10_000, originDurationMs: 5_000, originSourceOffsetMs: 0,
      sourceDurationMs: null, timelineDurationMs: 60_000, pointerMs: 55_000, minimumDurationMs: 33
    })).toEqual({ startMs: 10_000, durationMs: 45_000 });
  });

  it('根据缩放选择可读刻度并只生成可见范围刻度', () => {
    expect(chooseTimelineTickInterval(100)).toBe(1_000);
    expect(chooseTimelineTickInterval(10)).toBe(10_000);
    const ticks = buildVisibleTimelineTicks({
      durationMs: 120_000,
      pixelsPerSecond: 20,
      scrollLeft: 600,
      viewportWidth: 800
    });
    expect(ticks[0]?.milliseconds).toBe(25_000);
    expect(ticks.at(-1)?.milliseconds).toBe(75_000);
  });
});
