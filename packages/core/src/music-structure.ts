import { automaticMusicCandidatesSchema, musicStructureSchema, songMusicSchema, type AudioBeatAnalysis, type AutomaticMusicCandidates, type MusicStructure, type MusicStructureSegment, type ReferenceAudioSource, type RundownItem, type SongMusic } from '@tb/schema';
import { detectedBeatsPerBar } from './music-beat-segments';
import { musicTempoSegments } from './music-tempo-segments';
import { musicSegmentSpeed } from './music-segment-tempo';

const round = (value: number): number => Math.round(value * 100) / 100;
type AudioFingerprint = Pick<ReferenceAudioSource, 'sha256' | 'durationMs'>;
const sameAudio = (music: SongMusic, source: AudioFingerprint): boolean => music.sourceSha256 === source.sha256 && Math.abs(music.sourceDurationMs - source.durationMs) <= 50;

/** The song's beats when they were analysed from this very audio (`songMusicSource(item)` for a new analysis). */
export function matchingMusicStructure(item: Pick<RundownItem, 'music'> | undefined, source: AudioFingerprint | undefined): MusicStructure | undefined {
  const music = item?.music;
  return music && source && sameAudio(music, source) ? music.structure : undefined;
}

function songMusic(method: SongMusic['method'], structure: MusicStructure): SongMusic {
  return songMusicSchema.parse({ version: 1, sourceSha256: structure.sourceSha256, sourceDurationMs: structure.durationMs, method, structure });
}

/** Resolve earlier short-section omissions from saved beat evidence without
 * rewriting the document, deleted sections, or the user's boundary edits. */
export function musicStructureSegments(data: MusicStructure): MusicStructureSegment[] {
  if (data.state !== 'ready') return [];
  const beats = data.beats.map(beat => beat.atMs);
  return data.segments.map((segment, index) => ({ ...segment, name: segment.edited ? segment.name : `段落 ${index + 1}`, ...musicSegmentSpeed(beats, segment.startMs, segment.endMs, data.bpm !== null) }));
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
    if (nearby) { nearby.at = at; nearby.reason = 'both'; } else if (at > 0 && at < result.durationMs) boundaries.push({ at, reason: 'tempo' });
  }
  boundaries.sort((a, b) => a.at - b.at);
  const segments = beats.length || structures.length ? boundaries.map((boundary, index) => {
    const endMs = boundaries[index + 1]?.at ?? result.durationMs;
    return { id: `segment:${round(boundary.at)}`, name: `段落 ${index + 1}`, startMs: boundary.at, endMs, reason: boundary.reason, edited: false, ...musicSegmentSpeed(beats, boundary.at, endMs, result.bpm !== null) };
  }) : [];
  return musicStructureSchema.parse({ version: 1, algorithm: 'music-structure-1', sourceSha256: result.sourceSha256, durationMs: result.durationMs, taskId, state: 'ready', bpm: result.bpm, beatsPerBar: detectedBeatsPerBar(result),
    beats: beats.map(atMs => ({ id: `beat:${round(atMs)}`, atMs, strong: downbeats.has(atMs) })), segments, removedBeatMs: [], removedRanges: [] });
}

/** Preserve explicit human corrections across reanalysis; raw diagnostics remain source-bound.
 * The result is the song's new `music`, analysed from `source` (the music track's source file). */
export function acceptMusicStructure(item: Pick<RundownItem, 'music'>, source: AudioFingerprint, candidates: AutomaticMusicCandidates, taskId: string): SongMusic {
  if (source.sha256 !== candidates.sourceSha256 || Math.abs(source.durationMs - candidates.durationMs) > 50) throw new Error('音源或裁剪已改变，本次分析不能应用');
  const next = recognizeMusicStructure(candidates, taskId), previous = matchingMusicStructure(item, source);
  if (previous?.state === 'ready') {
    next.removedBeatMs = previous.removedBeatMs; next.removedRanges = previous.removedRanges;
    next.beats = next.beats.filter(beat => !previous.removedBeatMs.some(at => Math.abs(at - beat.atMs) <= 70));
    const edited = previous.segments.filter(segment => segment.edited);
    next.segments = [...next.segments.filter(segment => ![...previous.removedRanges, ...edited].some(range => segment.startMs < range.endMs && segment.endMs > range.startMs)), ...edited].sort((a, b) => a.startMs - b.startMs);
  }
  return songMusic('automatic', musicStructureSchema.parse(next));
}

/** The simple beat detection (IBT) as the song's `music`: every beat it found, the strong ones are those of its
 * sparsest level. Sections and BPM are worked out from these beats the same way as for the music recognition. */
export function ibtSongMusic(source: AudioFingerprint, analysis: Pick<AudioBeatAnalysis, 'dense' | 'sparse'>, taskId = 'ibt'): SongMusic {
  const beats = [...new Set(analysis.dense)].filter(at => at < source.durationMs).sort((a, b) => a - b);
  const strong = new Set(analysis.sparse);
  const intervals = beats.slice(1).map((at, index) => at - beats[index]!).sort((a, b) => a - b);
  const median = intervals[Math.floor(intervals.length / 2)];
  const candidates = automaticMusicCandidatesSchema.parse({ sourceSha256: source.sha256, durationMs: source.durationMs, bpm: median ? round(60000 / median) : null, items: [
    ...beats.map((startMs, index) => ({ id: `beat:${index}`, kind: 'beat' as const, name: '拍点', startMs, endMs: null })),
    ...beats.filter(at => strong.has(at)).map((startMs, index) => ({ id: `downbeat:${index}`, kind: 'downbeat' as const, name: '强拍', startMs, endMs: null }))
  ] });
  return songMusic('ibt', recognizeMusicStructure(candidates, taskId));
}

/** An empty, cleared result for this audio: it keeps the automatic analysis from starting again on its own. */
export function clearedSongMusic(source: AudioFingerprint, taskId: 'dismissed' | 'cancelled'): SongMusic {
  const result = recognizeMusicStructure({ sourceSha256: source.sha256, durationMs: source.durationMs, bpm: null, items: [] }, taskId);
  return songMusic('automatic', { ...result, state: 'cleared' });
}

/** Edits the song's beats in their own (source) time; the result is the song's new `music`. */
export function editMusicStructure(item: Pick<RundownItem, 'music'>, action: { kind: 'clear' } | { kind: 'remove-beat'; id: string } | { kind: 'remove-segment'; id: string } | { kind: 'segment'; segment: MusicStructureSegment }): SongMusic {
  const music = item.music; if (!music) throw new Error('还没有音乐识别结果');
  const current = music.structure;
  let result: MusicStructure = current;
  if (action.kind === 'clear') result = { ...current, state: 'cleared', beats: [], segments: [], removedBeatMs: [], removedRanges: [] };
  else if (action.kind === 'remove-beat') {
    const point = current.beats.find(beat => beat.id === action.id); if (!point) throw new Error('拍点已不存在');
    result = { ...current, beats: current.beats.filter(beat => beat.id !== action.id), removedBeatMs: [...current.removedBeatMs, point.atMs] };
  } else if (action.kind === 'remove-segment') {
    const segment = current.segments.find(entry => entry.id === action.id); if (!segment) throw new Error('段落已不存在');
    result = { ...current, segments: current.segments.filter(entry => entry.id !== action.id), removedRanges: [...current.removedRanges, { startMs: segment.startMs, endMs: segment.endMs }] };
  } else result = { ...current, segments: current.segments.map(segment => segment.id === action.segment.id ? { ...action.segment, ...musicSegmentSpeed(current.beats.map(beat => beat.atMs), action.segment.startMs, action.segment.endMs, current.bpm !== null), edited: true } : segment).sort((a, b) => a.startMs - b.startMs) };
  return songMusic(music.method, musicStructureSchema.parse(result));
}
