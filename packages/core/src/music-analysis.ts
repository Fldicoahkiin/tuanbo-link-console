import type { MusicAnalysisResult } from '@tb/schema';
import { estimateMusicBpm } from './lighting-music';

/** 20 ms RMS envelopes. Results are hypotheses, never automatic Cue actions. */
export function analyzeMusicEnvelope(values: readonly number[], durationMs: number): Pick<MusicAnalysisResult, 'bpm' | 'candidates'> {
  const candidates: MusicAnalysisResult['candidates'] = [];
  const onsets: number[] = []; let previous = -Infinity; let sum = 0; let silenceStart: number | null = null;
  const peak = values.reduce((maximum, value) => Math.max(maximum, value), 0);
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!; const at = index * 20; const mean = sum / Math.min(50, Math.max(1, index));
    if (value < Math.max(.003, peak * .015)) { if (silenceStart === null) silenceStart = at; }
    else if (silenceStart !== null) { if (at - silenceStart >= 250) candidates.push({ id: `silence:${silenceStart}`, kind: 'silence', startMs: silenceStart, endMs: at, strength: 1 }); silenceStart = null; }
    if (value > .008 && value > mean * 1.5 && value >= (values[index - 1] ?? 0) && value > (values[index + 1] ?? 0) && at - previous >= 70) {
      onsets.push(at); previous = at;
      candidates.push({ id: `beat:${at}`, kind: 'beat', startMs: at, endMs: null, strength: Math.min(1, value / Math.max(.001, peak)) });
      if (value > mean * 2 && value >= peak * .35) candidates.push({ id: `hit:${at}`, kind: 'hit', startMs: at, endMs: null, strength: Math.min(1, value / Math.max(.001, peak)) });
    }
    sum += value; if (index >= 50) sum -= values[index - 50]!;
  }
  if (silenceStart !== null && durationMs - silenceStart >= 250) candidates.push({ id: `silence:${silenceStart}`, kind: 'silence', startMs: silenceStart, endMs: durationMs, strength: 1 });
  let first = 0;
  for (let i = 1; i <= onsets.length; i++) {
    if (i < onsets.length && onsets[i]! - onsets[i - 1]! <= 180) continue;
    if (i - first >= 4) candidates.push({ id: `roll:${onsets[first]}`, kind: 'roll', startMs: onsets[first]!, endMs: Math.min(durationMs, onsets[i - 1]! + 80), strength: Math.min(1, (i - first) / 12) });
    first = i;
  }
  let bpm = estimateMusicBpm(onsets);
  if (bpm !== null) { while (bpm > 200) bpm /= 2; while (bpm < 60) bpm *= 2; bpm = Math.round(bpm * 100) / 100; }
  if (candidates.length > 100000) throw new Error('识别出的候选太多，请分段分析（结果没有截断，也没有自动应用）');
  return { bpm, candidates: candidates.filter(value => value.startMs < durationMs).sort((a, b) => a.startMs - b.startMs) };
}
