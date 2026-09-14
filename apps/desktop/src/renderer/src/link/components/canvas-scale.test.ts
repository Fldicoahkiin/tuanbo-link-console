import { describe, expect, it } from 'vitest';
import { resizeCanvasScale } from './canvas-scale';

describe('canvas proportional resize', () => {
  it('keeps the current aspect ratio by default', () => {
    expect(resizeCanvasScale({ scaleX: 1, scaleY: 1, deltaX: 0.5, deltaY: 0.2, freeform: false }))
      .toEqual({ scaleX: 1.5, scaleY: 1.5 });
  });

  it('preserves an existing scale ratio while resizing', () => {
    expect(resizeCanvasScale({ scaleX: 2, scaleY: 1, deltaX: 1, deltaY: 0, freeform: false }))
      .toEqual({ scaleX: 3, scaleY: 1.5 });
  });

  it('allows freeform stretching only when requested', () => {
    expect(resizeCanvasScale({ scaleX: 1, scaleY: 1, deltaX: 0.5, deltaY: 0, freeform: true }))
      .toEqual({ scaleX: 1.5, scaleY: 1 });
  });
});
