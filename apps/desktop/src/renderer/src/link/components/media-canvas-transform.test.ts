import { describe, expect, it } from 'vitest';
import { centerMediaCanvasTransform, fitMediaCanvasTransform, originalMediaCanvasTransform } from './media-canvas-transform';

describe('media canvas transforms', () => {
  it('restores the native-size transform at canvas center', () => {
    expect(originalMediaCanvasTransform()).toEqual({ x: 0.5, y: 0.5, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 });
  });

  it('centers without changing size or rotation', () => {
    expect(centerMediaCanvasTransform({ x: 1.2, y: -0.2, scale: 2, scaleX: 0.8, scaleY: 1.1, rotation: 12 }))
      .toEqual({ x: 0.5, y: 0.5, scale: 2, scaleX: 0.8, scaleY: 1.1, rotation: 12 });
  });

  it('fits landscape media inside the vertical application canvas without deformation', () => {
    expect(fitMediaCanvasTransform(1920, 1080)).toEqual({ x: 0.5, y: 0.5, scale: 0.5625, scaleX: 1, scaleY: 1, rotation: 0 });
  });
});
