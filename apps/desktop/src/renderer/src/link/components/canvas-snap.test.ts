import { describe, expect, it } from 'vitest';
import { snapCanvasAxis } from './canvas-snap';

describe('画布自动吸附', () => {
  it('将素材中心吸附到画布中心', () => {
    expect(snapCanvasAxis({ value: 536, itemSize: 400, anchor: 0.5, canvasSize: 1080, threshold: 8 })).toEqual({ value: 540, guide: 540 });
  });

  it('按素材锚点将左边缘吸附到画布左边', () => {
    expect(snapCanvasAxis({ value: 203, itemSize: 400, anchor: 0.5, canvasSize: 1080, threshold: 8 })).toEqual({ value: 200, guide: 0 });
  });

  it('超过阈值时保持自由移动', () => {
    expect(snapCanvasAxis({ value: 250, itemSize: 400, anchor: 0.5, canvasSize: 1080, threshold: 8 })).toEqual({ value: 250, guide: null });
  });
});
