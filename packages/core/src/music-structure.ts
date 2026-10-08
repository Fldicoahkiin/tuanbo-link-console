import { automaticMusicCandidatesSchema, lightingDocumentSchema, musicStructureSchema, type AutomaticMusicCandidates, type LightingDocument, type MusicStructure, type MusicStructureSegment, type ReferenceAudio } from '@tb/schema';
import { detectedBeatsPerBar } from './music-beat-segments';
import { musicTempoSegments } from './music-tempo-segments';

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const round = (value: number): number => Math.round(value * 100) / 100;
export function matchingMusicStructure(document: LightingDocument | undefined, source: Pick<ReferenceAudio, 'sha256' | 'durationMs'> | undefined): MusicStructure | undefined {
  const result = document?.musicAnalysis;
  return result && source && result.sourceSha256 === source.sha256 && Math.abs(result.durationMs - source.durationMs) <= 50 ? result : undefined;
}

function segmentSpeed(beats: number[], start: number, end: number, known: boolean): { bpm: number | null; endBpm: number | null } {
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
  if (!known || periods.length < 3) return { bpm: null, endBpm: null };
  const period = median(periods), stable = periods.filter(value => Math.abs(value / period - 1) <= .1).length / periods.length;
  const first = median(periods.slice(0, Math.min(6, periods.length))), last = median(periods.slice(-6));
  const direction = Math.sign(last - first);
  const smooth = periods.slice(1).filter((value, index) => Math.abs(value / periods[index]! - 1) <= .12 && direction * (value - periods[index]!) >= -first * .025).length / Math.max(1, periods.length - 1);
  if (periods.length >= 12 && smooth >= .8 && Math.abs(last / first - 1) >= .1) return { bpm: round(60000 / first), endBpm: round(60000 / last) };
  // Model times are quantized; a median interval alone can make every section
  // read 115.38 (= 60 / .52), even when its accumulated beat duration differs.
  const inliers = periods.filter(value => Math.abs(value / period - 1) <= .1);
  const localPeriod = inliers.reduce((sum, value) => sum + value, 0) / inliers.length;
  return stable >= .7 ? { bpm: round(60000 / localPeriod), endBpm: null } : { bpm: null, endBpm: null };
}

/** Resolve earlier short-section omissions from saved beat evidence without
 * rewriting the document, deleted sections, or the user's boundary edits. */
export function musicStructureSegments(data: MusicStructure): MusicStructureSegment[] {
  if (data.state !== 'ready') return [];
  const beats = data.beats.map(beat => beat.atMs);
  return data.segments.map(segment => segment.bpm !== null ? segment : { ...segment, ...segmentSpeed(beats, segment.startMs, segment.endMs, data.bpm !== null) });
}

/** Actual structure boundaries and sustained tempo changes, never a user-selected beat interval. */
export function recognizeMusicStructure(input: AutomaticMusicCandidates, taskId: string): MusicStructure {
  const result = automaticMusicCandidatesSchema.parse(input);
  const beats = [...new Set(result.items.filter(item => item.kind === 'beat' && item.startMs < result.durationMs).map(item => item.startMs))].sort((a, b) => a - b);
  const downbeats = new Set(result.items.filter(item => item.kind === 'downbeat').map(item => item.startMs));
  const structures = result.items.filter(item => item.kind === 'section').sort((a, b) => a.startMs - b.startMs);
  const changes = result.bpm === null ? [] : musicTempoSegments(beats, result.durationMs).slice(1).map(segment => segment.startMs);
  const minStructureMs = Math.max(1000, result.bpm ? 120000 / result.bpm : 1000);
  const boundaries: { at: number; reason: MusicStructureSegment['reason'] }[] = [{ at: 0, reason: 'whole' }];
  for (const section of structures.slice(1)) {
    if (section.startMs - boundaries.at(-1)!.at >= minStructureMs && result.durationMs - section.startMs >= minStructureMs) boundaries.push({ at: section.startMs, reason: 'structure' });
  }
  for (const at of changes) {
    const nearby = boundaries.find(boundary => boundary.at > 0 && Math.abs(boundary.at - at) <= 200);
    if (nearby) nearby.reason = 'both'; else if (at > 0 && at < result.durationMs) boundaries.push({ at, reason: 'tempo' });
  }
  boundaries.sort((a, b) => a.at - b.at);
  const segments = beats.length || structures.length ? boundaries.map((boundary, index) => {
    const endMs = boundaries[index + 1]?.at ?? result.durationMs;
    const structure = structures.find(section => section.startMs <= boundary.at + 200 && section.endMs !== null && section.endMs > boundary.at);
    return { id: `segment:${round(boundary.at)}`, name: structure?.name ?? `段落 ${index + 1}`, startMs: boundary.at, endMs, reason: boundary.reason, edited: false, ...segmentSpeed(beats, boundary.at, endMs, result.bpm !== null) };
  }) : [];
  return musicStructureSchema.parse({ version: 1, algorithm: 'music-structure-1', sourceSha256: result.sourceSha256, durationMs: result.durationMs, taskId, state: 'ready', bpm: result.bpm, beatsPerBar: detectedBeatsPerBar(result),
    beats: beats.map(atMs => ({ id: `beat:${round(atMs)}`, atMs, strong: downbeats.has(atMs) })), segments, removedBeatMs: [], removedRanges: [] });
}

/** Preserve explicit human corrections across reanalysis; raw diagnostics remain source-bound. */
export function acceptMusicStructure(document: LightingDocument, source: ReferenceAudio, candidates: AutomaticMusicCandidates, taskId: string): LightingDocument {
  if (source.sha256 !== candidates.sourceSha256 || Math.abs(source.durationMs - candidates.durationMs) > 50) throw new Error('音源或裁剪已改变，本次分析不能应用');
  const next = recognizeMusicStructure(candidates, taskId), previous = matchingMusicStructure(document, source);
  if (previous?.state === 'ready') {
    next.removedBeatMs = previous.removedBeatMs; next.removedRanges = previous.removedRanges;
    next.beats = next.beats.filter(beat => !previous.removedBeatMs.some(at => Math.abs(at - beat.atMs) <= 70));
    const edited = previous.segments.filter(segment => segment.edited);
    next.segments = [...next.segments.filter(segment => ![...previous.removedRanges, ...edited].some(range => segment.startMs < range.endMs && segment.endMs > range.startMs)), ...edited].sort((a, b) => a.startMs - b.startMs);
  }
  return lightingDocumentSchema.parse({ ...document, version: 2, musicAnalysis: next });
}

export function editMusicStructure(document: LightingDocument, action: { kind: 'clear' } | { kind: 'remove-beat'; id: string } | { kind: 'remove-segment'; id: string } | { kind: 'segment'; segment: MusicStructureSegment }): LightingDocument {
  const current = document.musicAnalysis; if (!current) throw new Error('还没有音乐识别结果');
  let result: MusicStructure = current;
  if (action.kind === 'clear') result = { ...current, state: 'cleared', beats: [], segments: [], removedBeatMs: [], removedRanges: [] };
  else if (action.kind === 'remove-beat') {
    const point = current.beats.find(beat => beat.id === action.id); if (!point) throw new Error('拍点已不存在');
    result = { ...current, beats: current.beats.filter(beat => beat.id !== action.id), removedBeatMs: [...current.removedBeatMs, point.atMs] };
  } else if (action.kind === 'remove-segment') {
    const segment = current.segments.find(item => item.id === action.id); if (!segment) throw new Error('段落已不存在');
    result = { ...current, segments: current.segments.filter(item => item.id !== action.id), removedRanges: [...current.removedRanges, { startMs: segment.startMs, endMs: segment.endMs }] };
  } else result = { ...current, segments: current.segments.map(segment => segment.id === action.segment.id ? { ...action.segment, ...segmentSpeed(current.beats.map(beat => beat.atMs), action.segment.startMs, action.segment.endMs, current.bpm !== null), edited: true } : segment).sort((a, b) => a.startMs - b.startMs) };
  return lightingDocumentSchema.parse({ ...document, musicAnalysis: result });
}
