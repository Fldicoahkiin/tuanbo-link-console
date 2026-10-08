const WINDOW = 4;
const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const stable = (values: number[], center: number): boolean => values.filter(value => Math.abs(value / center - 1) <= .07).length >= Math.ceil(values.length * .75);

/** Conservative change points in detected beat intervals. Predictions remain editable annotations. */
export function musicTempoSegments(beats: readonly number[], durationMs: number) {
  const intervals = beats.slice(1).map((value, index) => value - beats[index]!);
  if (intervals.length < 2) return [];
  const boundaries = [0];
  for (let index = WINDOW; index + WINDOW <= intervals.length; index++) {
    const previous = intervals.slice(index - WINDOW, index), following = intervals.slice(index, index + WINDOW);
    const before = median(previous), after = median(following);
    if (!before || !after || Math.abs(after / before - 1) < .04 || Math.abs(60000 / before - 60000 / after) < 3) continue;
    // Ignore isolated missed/extra beats and avoid moving a change earlier merely because a window crosses it.
    if (!stable(previous, before) || !stable(following, after) || following.slice(0, 3).some(value => Math.abs(value / after - 1) > .07)) continue;
    if (following.slice(0, 3).some(value => Math.abs(value - after) >= Math.abs(value - before))) continue;
    if (Math.abs(previous.at(-1)! - before) >= Math.abs(previous.at(-1)! - after)) continue;
    boundaries.push(index); index += WINDOW - 1;
  }
  return boundaries.map((index, section) => {
    const next = boundaries[section + 1] ?? intervals.length;
    const period = median(intervals.slice(index, next));
    return { startMs: beats[index]!, endMs: boundaries[section + 1] === undefined ? durationMs : beats[next]!, bpm: Math.round(6000000 / period) / 100 };
  });
}
