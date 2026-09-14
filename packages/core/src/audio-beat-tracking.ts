import type { AudioBeatAnalysis } from '@tb/schema';

export type BeatOnset = { time: number; strength: number };

/** Tempo-constrained onset path; markers always remain on observed musical attacks. */
export function trackAudioBeats(onsets: BeatOnset[]): AudioBeatAnalysis {
  if (onsets.length < 4) return { sparse: [], standard: [], dense: [] };
  const dense: number[] = []; const standard: number[] = []; const sparse: number[] = [];
  // Silence breaks the phrase, so an earlier section cannot invent beats in a gap.
  let start = 0;
  for (let end = 1; end <= onsets.length; end++) {
    if (end < onsets.length && onsets[end]!.time - onsets[end - 1]!.time < 2200) continue;
    const section = onsets.slice(start, end); start = end;
    if (section.length < 4) continue;
    const path = trackSection(section);
    const accents = [0, 0, 0, 0];
    path.forEach((point, index) => { accents[index % 4]! += point.strength; });
    const phase = accents.indexOf(Math.max(...accents));
    path.forEach((point, index) => {
      dense.push(point.time);
      if (index % 2 === phase % 2) standard.push(point.time);
      if (index % 4 === phase) sparse.push(point.time);
    });
  }
  return { sparse, standard, dense };
}

function estimatePeriod(points: BeatOnset[]): number {
  // Weighted inter-onset correlation, restricted to a plausible main pulse (60–180 BPM).
  const histogram = new Float64Array(101);
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const delta = points[j]!.time - points[i]!.time;
      if (delta > 2020) break;
      for (const multiple of [1, 2]) {
        const period = delta / multiple;
        if (period < 333 || period > 1000) continue;
        const bin = Math.round(period / 10);
        const weight = points[i]!.strength * points[j]!.strength / multiple;
        for (let offset = -2; offset <= 2; offset++) {
          if (bin + offset >= 33 && bin + offset <= 100) histogram[bin + offset]! += weight * (1 - Math.abs(offset) / 3);
        }
      }
    }
  }
  let best = 50; let score = 0;
  for (let bin = 34; bin <= 100; bin++) {
    const prior = Math.exp(-0.5 * (Math.log2((6000 / bin) / 110) / 0.8) ** 2);
    const value = histogram[bin]! * prior;
    if (value > score) { score = value; best = bin; }
  }
  return best * 10;
}

function trackSection(points: BeatOnset[]): BeatOnset[] {
  const scores = new Float64Array(points.length);
  const previous = new Int32Array(points.length).fill(-1);
  const maximum = points.reduce((value, point) => Math.max(value, point.strength), 0);
  let period = 500; let nextWindow = -1; let windowStart = 0; let windowEnd = 0;
  let best = 0;
  for (let i = 0; i < points.length; i++) {
    const point = points[i]!;
    if (point.time >= nextWindow) {
      while (windowStart < points.length && points[windowStart]!.time < point.time - 6000) windowStart++;
      while (windowEnd < points.length && points[windowEnd]!.time <= point.time + 6000) windowEnd++;
      period = estimatePeriod(points.slice(windowStart, windowEnd)); nextWindow = point.time + 3000;
    }
    const strength = point.strength / maximum;
    scores[i] = strength;
    for (let j = i - 1; j >= 0; j--) {
      const delta = point.time - points[j]!.time;
      if (delta > period * 2.2) break;
      if (delta < period * 0.65) continue;
      const multiples = delta > period * 1.55 ? 2 : 1;
      const penalty = 8 * Math.log(delta / (period * multiples)) ** 2 + (multiples - 1) * 0.3;
      const candidate = scores[j]! + strength - penalty;
      if (candidate > scores[i]!) { scores[i] = candidate; previous[i] = j; }
    }
    if (scores[i]! > scores[best]!) best = i;
  }
  const result: BeatOnset[] = [];
  for (let index = best; index >= 0; index = previous[index]!) result.push(points[index]!);
  result.reverse();
  return result.length >= 4 ? result : [];
}
