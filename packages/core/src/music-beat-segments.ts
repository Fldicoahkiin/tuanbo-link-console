import { automaticMusicCandidatesSchema, lightingDocumentSchema, type AutomaticMusicCandidates, type LightingDocument, type ReferenceAudio } from '@tb/schema';
import { musicTempoSegments } from './music-tempo-segments';

export type MusicBeatInterval = 'tempo' | 0.25 | 0.5 | 1 | 2 | 4 | 8 | 16 | 32;
export const musicBeatPrefix = (hash: string): string => `music-beat:${hash}:`;

/** Infer observed beats per bar; a denominator cannot be inferred from beat timestamps alone. */
export function detectedBeatsPerBar(candidates: AutomaticMusicCandidates | undefined): number | null {
  if (!candidates) return null;
  const beats = [...new Set(candidates.items.filter(item => item.kind === 'beat').map(item => item.startMs))].sort((a, b) => a - b);
  const downbeats = [...new Set(candidates.items.filter(item => item.kind === 'downbeat').map(item => item.startMs))].sort((a, b) => a - b);
  const indices = downbeats.map(time => beats.findIndex(beat => Math.abs(beat - time) <= 70));
  if (indices.some(index => index < 0)) return null;
  const counts = indices.slice(1).map((index, i) => index - indices[i]!);
  if (counts.length < 3) return null;
  const ranked = [...new Set(counts)].map(count => ({ count, occurrences: counts.filter(value => value === count).length })).sort((a, b) => b.occurrences - a.occurrences);
  const winner = ranked[0];
  return winner && winner.count >= 2 && winner.count <= 12 && winner.occurrences / counts.length >= .8 ? winner.count : null;
}

/** Index actual detected beats, never infer Cue counts, accents, or semantic song sections. */
export function musicBeatSegments(input: AutomaticMusicCandidates, interval: MusicBeatInterval = 'tempo') {
  const candidates = automaticMusicCandidatesSchema.parse(input);
  const beats = [...new Set(candidates.items.filter(item => item.kind === 'beat' && item.startMs < candidates.durationMs).map(item => item.startMs))].sort((a, b) => a - b);
  if (interval === 'tempo') return musicTempoSegments(beats, candidates.durationMs).map((segment, index) => ({
    id: `${musicBeatPrefix(candidates.sourceSha256)}tempo:${index}`, name: `${segment.bpm} BPM`, startMs: segment.startMs, endMs: segment.endMs,
    notes: '按持续 BPM 变化分段；根据检测拍点估算，可删除重做', color: '#eabb68', kind: 'custom' as const
  }));
  const positions = interval < 1 ? beats.flatMap((start, index) => beats[index + 1] === undefined ? [start] : Array.from({ length: 1 / interval }, (_, step) => start + (beats[index + 1]! - start) * step * interval)) : beats.filter((_, index) => index % interval === 0);
  return positions.map((startMs, index) => ({
    id: `${musicBeatPrefix(candidates.sourceSha256)}${interval}:${index}`, name: `第 ${index + 1} 段`, startMs,
    endMs: positions[index + 1] ?? candidates.durationMs,
    notes: `每 ${interval} 拍一段；第 ${index * interval + 1} 拍开始`, color: '#eabb68', kind: 'custom' as const
  }));
}

export function saveMusicBeatSegments(document: LightingDocument, source: ReferenceAudio, candidates: AutomaticMusicCandidates, interval: MusicBeatInterval, selected?: ReadonlySet<string>): LightingDocument {
  if (source.sha256 !== candidates.sourceSha256 || Math.abs(source.durationMs - candidates.durationMs) > 50) throw new Error('音源或裁剪已改变，请重新分析');
  const points = musicBeatSegments(candidates, interval).filter(point => !selected || selected.has(point.id));
  if (!points.length) throw new Error('没有检测到节拍');
  return lightingDocumentSchema.parse({ ...document, version: 2, markers: [...document.markers.filter(marker => !marker.id.startsWith(musicBeatPrefix(source.sha256))), ...points] });
}
