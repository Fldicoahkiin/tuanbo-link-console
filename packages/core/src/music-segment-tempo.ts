const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const round = (value: number): number => Math.round(value * 100) / 100;

/** Fit elapsed beat time, using a separate origin for each uninterrupted run.
 * This averages timestamp quantization without treating a missing beat as a slow beat. */
function fittedPeriod(periods: number[], center: number): number | null {
  const runs: number[][] = [];
  let run = [0];
  for (const period of periods) {
    if (Math.abs(period / center - 1) <= .1) run.push(run.at(-1)! + period);
    else { if (run.length >= 4) runs.push(run); run = [0]; }
  }
  if (run.length >= 4) runs.push(run);
  let covariance = 0, variance = 0;
  for (const values of runs) {
    const meanX = (values.length - 1) / 2, meanY = values.reduce((sum, value) => sum + value, 0) / values.length;
    values.forEach((value, index) => { covariance += (index - meanX) * (value - meanY); variance += (index - meanX) ** 2; });
  }
  if (!variance) return null;
  const period = covariance / variance;
  let squaredError = 0, count = 0;
  for (const values of runs) {
    const origin = values.reduce((sum, value, index) => sum + value - index * period, 0) / values.length;
    for (const [index, value] of values.entries()) { squaredError += (value - origin - index * period) ** 2; count++; }
  }
  return Math.sqrt(squaredError / count) <= center * .06 ? period : null;
}

export function musicSegmentSpeed(beats: number[], start: number, end: number, known: boolean): { bpm: number | null; endBpm: number | null } {
  let periods = beats.slice(1).flatMap((time, index) => beats[index]! >= start && time <= end ? [time - beats[index]!] : []);
  if (known && periods.length < 3 && beats.some(time => time >= start && time < end)) {
    // A structure cut is not a break in the beat clock. For short sections use
    // overlapping intervals and only the immediate neighbours needed to estimate
    // three intervals. Never bridge a gap or a change in tempo with that context.
    const overlapping = beats.slice(1).flatMap((time, index) => beats[index]! < end && time > start ? [index] : []);
    if (overlapping.length) {
      let first = overlapping[0]!, last = overlapping.at(-1)!;
      while (last - first + 1 < 3) {
        if (first > 0 && beats[first - 1]! >= start - 1500) first--;
        else if (last + 2 < beats.length && beats[last + 2]! <= end + 1500) last++;
        else break;
      }
      const context = beats.slice(first + 1, last + 2).map((time, index) => time - beats[first + index]!);
      const center = median(context);
      if (center > 0 && context.every(value => Math.abs(value / center - 1) <= .08)) periods = context;
    }
  }
  // Isolated subdivisions can be detected as two half beats among ordinary
  // beats. Combine only adjacent pairs supported by at least three full periods;
  // a sustained faster passage keeps its own median and is not halved.
  const center = median(periods);
  if (center > 0 && periods.filter(value => Math.abs(value / center - 1) <= .1).length >= 3) {
    const combined: number[] = [];
    for (let index = 0; index < periods.length; index++) {
      const value = periods[index]!, next = periods[index + 1];
      if (next !== undefined && value < center * .65 && next < center * .65 && Math.abs((value + next) / center - 1) <= .1) { combined.push(value + next); index++; }
      else combined.push(value);
    }
    periods = combined;
  }
  if (periods.length < 2 || periods.some(value => value <= 0 || !Number.isFinite(value))) return { bpm: null, endBpm: null };
  const period = median(periods), stable = periods.filter(value => Math.abs(value / period - 1) <= .1).length / periods.length;
  const first = median(periods.slice(0, Math.min(6, periods.length))), last = median(periods.slice(-6));
  const direction = Math.sign(last - first);
  const smooth = periods.slice(1).filter((value, index) => Math.abs(value / periods[index]! - 1) <= .12 && direction * (value - periods[index]!) >= -first * .025).length / Math.max(1, periods.length - 1);
  if (periods.length >= 12 && smooth >= .8 && Math.abs(last / first - 1) >= .03) return { bpm: round(60000 / first), endBpm: round(60000 / last) };
  const localPeriod = fittedPeriod(periods, period);
  // Always expose a local estimate when there is measurable beat evidence.
  // Irregular sections use the median interval, not the whole-song tempo.
  return { bpm: round(60000 / (stable >= .85 && localPeriod !== null ? localPeriod : period)), endBpm: null };
}
