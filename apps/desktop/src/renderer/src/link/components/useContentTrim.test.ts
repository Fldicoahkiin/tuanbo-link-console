import { describe, expect, it } from 'vitest';
import { trimPreview } from './useContentTrim';

describe('修剪拖动时就停在规则允许的位置', () => {
  const drag = { originStartMs: 2_000, originDurationMs: 3_000, bounds: { minStartMs: 1_000, maxEndMs: 6_000 } };
  it('拖到相邻片段或素材尽头就停住，松手前后一样', () => {
    expect(trimPreview({ ...drag, edge: 'end' }, 9_000, 33)).toEqual({ startMs: 2_000, durationMs: 4_000 });
    expect(trimPreview({ ...drag, edge: 'start' }, 0, 33)).toEqual({ startMs: 1_000, durationMs: 4_000 });
  });
  it('拖过另一端时留下至少一帧，另一端不动', () => {
    expect(trimPreview({ ...drag, edge: 'end' }, 1_500, 33)).toEqual({ startMs: 2_000, durationMs: 33 });
    expect(trimPreview({ ...drag, edge: 'start' }, 7_000, 33)).toEqual({ startMs: 4_967, durationMs: 33 });
  });
  it('没有右边界的图片和机位可以一直拉长', () => {
    expect(trimPreview({ ...drag, edge: 'end', bounds: { minStartMs: 0, maxEndMs: Number.POSITIVE_INFINITY } }, 45_000, 33)).toEqual({ startMs: 2_000, durationMs: 43_000 });
  });
});
