import type { ReferenceCanvasTransform } from '@tb/schema';
import { resizeCanvasScale } from './canvas-scale';

/** Resize in source-local coordinates, keeping the opposite handle stationary. */
export function resizeMediaCanvas(input: {
  origin: ReferenceCanvasTransform;
  direction: { x: -1 | 0 | 1; y: -1 | 0 | 1 };
  dx: number; dy: number;
  width: number; height: number;
  frameWidth: number; frameHeight: number;
  freeform: boolean;
}): ReferenceCanvasTransform {
  const { origin, direction, width, height } = input;
  const radians = origin.rotation * Math.PI / 180;
  const cos = Math.cos(radians), sin = Math.sin(radians);
  const localX = input.dx * cos + input.dy * sin;
  const localY = -input.dx * sin + input.dy * cos;
  const scale = resizeCanvasScale({
    scaleX: origin.scaleX, scaleY: origin.scaleY,
    deltaX: origin.scaleX * direction.x * localX / width,
    deltaY: origin.scaleY * direction.y * localY / height,
    freeform: input.freeform
  });
  const shiftX = direction.x * width * (scale.scaleX / origin.scaleX - 1) / 2;
  const shiftY = direction.y * height * (scale.scaleY / origin.scaleY - 1) / 2;
  return { ...origin, ...scale,
    x: Math.max(-1, Math.min(2, origin.x + (shiftX * cos - shiftY * sin) / input.frameWidth)),
    y: Math.max(-1, Math.min(2, origin.y + (shiftX * sin + shiftY * cos) / input.frameHeight))
  };
}
