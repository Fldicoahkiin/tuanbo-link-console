export function resizeCanvasScale(input: {
  scaleX: number;
  scaleY: number;
  deltaX: number;
  deltaY: number;
  freeform: boolean;
}): { scaleX: number; scaleY: number } {
  if (input.freeform) {
    return {
      scaleX: clamp(input.scaleX + input.deltaX, 0.05, 8),
      scaleY: clamp(input.scaleY + input.deltaY, 0.05, 8)
    };
  }
  const relativeX = input.deltaX / input.scaleX;
  const relativeY = input.deltaY / input.scaleY;
  const relativeDelta = Math.abs(relativeX) >= Math.abs(relativeY) ? relativeX : relativeY;
  const minimumFactor = Math.max(0.05 / input.scaleX, 0.05 / input.scaleY);
  const maximumFactor = Math.min(8 / input.scaleX, 8 / input.scaleY);
  const factor = clamp(1 + relativeDelta, minimumFactor, maximumFactor);
  return { scaleX: input.scaleX * factor, scaleY: input.scaleY * factor };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
