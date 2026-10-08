import type { AutomaticMusicRun } from '@tb/schema';

function nearest(points: readonly number[], at: number): number | undefined {
  let low = 0, high = points.length;
  while (low < high) { const middle = (low + high) >>> 1; if (points[middle]! < at) low = middle + 1; else high = middle; }
  return [points[low - 1], points[low]].filter((point): point is number => point !== undefined).sort((a, b) => Math.abs(a - at) - Math.abs(b - at))[0];
}
const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

/** Select a continuous model sequence by pairwise agreement, then refine supported positions.
 * Unlike an intersection, an isolated missed beat in one model does not erase the beat. */
export function fuseMusicBeats(run: AutomaticMusicRun) {
  const models = [run.diagnostics['beat-this-final0'], run.diagnostics['beat-this-final1'], run.diagnostics['beat-this-final2']].filter(model => model !== undefined);
  if (!models.length) return { beats: [], downbeats: [], ambiguous: false };
  const agreement = (a: readonly number[], b: readonly number[]): number => a.length + b.length ? (a.filter(time => Math.abs((nearest(b, time) ?? Infinity) - time) <= .07).length + b.filter(time => Math.abs((nearest(a, time) ?? Infinity) - time) <= .07).length) / (a.length + b.length) : 1;
  const ranked = models.map(model => ({ model, score: models.reduce((sum, other) => sum + agreement(model.beats, other.beats), 0) })).sort((a, b) => b.score - a.score);
  const reference = ranked[0]!.model;
  const beats = reference.beats.map(at => {
    const votes = models.flatMap(model => { const time = nearest(model.beats, at); return time !== undefined && Math.abs(time - at) <= .07 ? [time] : []; });
    return votes.length >= 2 ? median(votes) : at;
  }).filter((time, index, values) => index === 0 || time > values[index - 1]!);
  const downbeats = beats.filter(at => models.filter(model => Math.abs((nearest(model.downbeats, at) ?? Infinity) - at) <= .07).length >= 2);
  const periods = models.map(model => median(model.beats.slice(1).map((time, index) => time - model.beats[index]!))).filter(period => period > 0);
  const period = median(periods);
  const ambiguous = periods.length > 1 && periods.filter(value => Math.abs(value / period - 1) <= .15).length < 2;
  return { beats, downbeats, ambiguous };
}
