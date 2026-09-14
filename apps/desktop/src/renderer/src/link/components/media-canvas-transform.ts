import { DEFAULT_REFERENCE_CANVAS_TRANSFORM, type ReferenceCanvasTransform } from '@tb/schema';

export const REFERENCE_CANVAS_WIDTH = 1080;
export const REFERENCE_CANVAS_HEIGHT = 1920;

export function originalMediaCanvasTransform(): ReferenceCanvasTransform {
  return { ...DEFAULT_REFERENCE_CANVAS_TRANSFORM };
}

export function centerMediaCanvasTransform(current: ReferenceCanvasTransform): ReferenceCanvasTransform {
  return { ...current, x: 0.5, y: 0.5 };
}

export function fitMediaCanvasTransform(sourceWidth: number, sourceHeight: number): ReferenceCanvasTransform {
  const scale = Math.min(REFERENCE_CANVAS_WIDTH / sourceWidth, REFERENCE_CANVAS_HEIGHT / sourceHeight);
  return { ...DEFAULT_REFERENCE_CANVAS_TRANSFORM, scale };
}
