import { describe, expect, it } from 'vitest';
import { resizeMediaCanvas } from './media-canvas-geometry';

const base = { origin: { x: .5, y: .5, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 },
  direction: { x: 1 as const, y: 1 as const }, dx: 20, dy: 40,
  width: 100, height: 200, frameWidth: 500, frameHeight: 500, freeform: false };

describe('media canvas pointer geometry', () => {
  it('keeps the opposite corner fixed and follows the pointer proportionally', () => {
    const result = resizeMediaCanvas(base);
    expect(result.scaleX).toBeCloseTo(1.2);
    expect(result.scaleY).toBeCloseTo(1.2);
    expect(result.x * 500 - 100 * result.scaleX / 2).toBeCloseTo(200);
    expect(result.y * 500 - 200 * result.scaleY / 2).toBeCloseTo(150);
  });
  it('allows independent edge stretching with Shift', () => {
    const result = resizeMediaCanvas({ ...base, direction: { x: -1, y: 0 }, dx: -30, dy: 50, freeform: true });
    expect(result.scaleX).toBeCloseTo(1.3);
    expect(result.scaleY).toBe(1);
    expect(result.x * 500 + 100 * result.scaleX / 2).toBeCloseTo(300);
  });
  it('uses rotated local axes', () => {
    const result = resizeMediaCanvas({ ...base, origin: { ...base.origin, rotation: 90 }, dx: -40, dy: 20 });
    expect(result.scaleX).toBeCloseTo(1.2);
    expect(result.x).toBeCloseTo(.46);
    expect(result.y).toBeCloseTo(.52);
  });
});
