/** Exact 96th percentile without sorting/copying hundreds of thousands of JS
 * array entries. Median pivot and equal-value partition keep silence linear. */
export function waveformNormalization(peaks: readonly number[]): number {
  if (!peaks.length) return 1;
  const values = Float64Array.from(peaks), target = Math.floor(values.length * 0.96);
  let left = 0, right = values.length - 1;
  while (left < right) {
    const a = values[left]!, b = values[(left + right) >>> 1]!, c = values[right]!;
    const pivot = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
    let low = left, high = right;
    while (low <= high) {
      while (values[low]! < pivot) low++;
      while (values[high]! > pivot) high--;
      if (low <= high) { const value = values[low]!; values[low++] = values[high]!; values[high--] = value; }
    }
    if (target <= high) right = high;
    else if (target >= low) left = low;
    else break;
  }
  return Math.max(0.001, values[target]!);
}

/** Every source peak contributes to a visible pixel. Reducing draw calls never
 * drops a narrow onset or the final sample and does not alter the saved cache. */
export function waveformColumns(peaks: readonly number[], start: number, end: number, width: number): Float64Array {
  const columns = new Float64Array(Math.max(1, Math.ceil(width)));
  const count = end - start;
  for (let index = start; index < end; index++) {
    const column = Math.min(columns.length - 1, Math.floor((index - start) * columns.length / count));
    columns[column] = Math.max(columns[column]!, peaks[index] ?? 0);
  }
  return columns;
}
