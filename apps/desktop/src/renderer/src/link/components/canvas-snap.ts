export type CanvasSnapResult = {
  value: number;
  guide: number | null;
};

export function snapCanvasAxis(input: {
  value: number;
  itemSize: number;
  anchor: number;
  canvasSize: number;
  threshold: number;
}): CanvasSnapResult {
  const candidates = [
    { value: input.anchor * input.itemSize, guide: 0 },
    { value: input.canvasSize / 2 - (0.5 - input.anchor) * input.itemSize, guide: input.canvasSize / 2 },
    { value: input.canvasSize - (1 - input.anchor) * input.itemSize, guide: input.canvasSize }
  ];
  const nearest = candidates.reduce((best, candidate) => (
    Math.abs(candidate.value - input.value) < Math.abs(best.value - input.value) ? candidate : best
  ));
  return Math.abs(nearest.value - input.value) <= input.threshold
    ? nearest
    : { value: input.value, guide: null };
}
