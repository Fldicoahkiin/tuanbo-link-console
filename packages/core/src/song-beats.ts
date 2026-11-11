import { referenceAudioSourceSchema, type AudioBeatLevel, type MusicStructureSegment, type ReferenceAudio, type ReferenceAudioSource, type RundownItem, type SongMusic } from '@tb/schema';
import { audioTracks } from './audio-edit';
import { musicStructureSegments } from './music-structure';

/**
 * A song's beats, the only place the editor and the lighting workspace read them from (0.5.9 E9).
 * `rundownItem.music` holds them in the time of the audio they were analysed from; here they are placed on the song:
 * each beat at the audio segment of the music track that plays that part of the source, so cutting, moving or padding
 * the audio moves the beats with the music and drops the beats of a part that was cut out. No new analysis is needed.
 * Results are kept per (music, song audio) object, so asking every frame costs nothing and gives the same object.
 */

/** A beat on the song. `sourceId` is the beat in `music.structure`, for edits; a part of the source played twice gives two beats. */
export type SongBeat = { id: string; sourceId: string; atMs: number; strong: boolean };
/** A section on the song; one cut into pieces gives one part per piece, each with the section's `sourceId`. */
export type SongBeatSegment = MusicStructureSegment & { sourceId: string };
/** Where a stretch of the analysed audio plays in the song. */
export type SongMusicPiece = { startMs: number; sourceOffsetMs: number; durationMs: number };
export type SongBeatsResult = {
  method: SongMusic['method'];
  taskId: string;
  bpm: number | null;
  beatsPerBar: number | null;
  beats: readonly SongBeat[];
  segments: readonly SongBeatSegment[];
  /** Beats and section edges, sorted: where an edit can snap to. */
  editPointsMs: readonly number[];
  pieces: readonly SongMusicPiece[];
};
export type SongBeats =
  | { state: 'none' }
  | { state: 'stale'; reason: string }
  /** `cleared`: the operator cleared the marks; nothing shows and the automatic analysis does not start again by itself. */
  | ({ state: 'ready' | 'cleared' } & SongBeatsResult);

/** Beats that can be shown or edited: recognised, or cleared by the operator. */
export type PlacedSongBeats = Extract<SongBeats, { state: 'ready' | 'cleared' }>;

const NONE: SongBeats = { state: 'none' };
const NO_AUDIO: SongBeats = { state: 'stale', reason: '这首歌还没有音乐，添加音乐后再识别节拍' };
const CHANGED: SongBeats = { state: 'stale', reason: '音乐换了，需要重新识别节拍' };
const byAudio = new WeakMap<SongMusic, WeakMap<ReferenceAudio, SongBeats>>();
const sources = new WeakMap<ReferenceAudio, ReferenceAudioSource>();

/** The audio to analyse for this song: the source file of its music track (the first track), never the rendered mix.
 * The same object for the same song audio. */
export function songMusicSource(item: Pick<RundownItem, 'referenceAudio' | 'title'>): ReferenceAudioSource | undefined {
  const audio = item.referenceAudio;
  if (!audio) return undefined;
  let source = sources.get(audio);
  if (!source) { source = referenceAudioSourceSchema.parse(audioTracks(audio, item.title)[0]!.source); sources.set(audio, source); }
  return source;
}

/** Which of the song's audio files these beats belong to: the music track's source file (0.5.9 on) or, for beats
 * from before, the song audio itself. Undefined when the song no longer has that audio. */
export function songMusicAudio(item: Pick<RundownItem, 'referenceAudio' | 'title'>, music: Pick<SongMusic, 'sourceSha256' | 'sourceDurationMs'>): Pick<ReferenceAudioSource, 'sha256' | 'durationMs'> | undefined {
  const source = songMusicSource(item);
  if (source && close(music, source)) return source;
  return item.referenceAudio && close(music, item.referenceAudio) ? item.referenceAudio : undefined;
}

export function songBeats(item: Pick<RundownItem, 'music' | 'referenceAudio' | 'title'>): SongBeats {
  const { music, referenceAudio } = item;
  if (!music) return NONE;
  if (!referenceAudio) return NO_AUDIO;
  let cache = byAudio.get(music);
  if (!cache) { cache = new WeakMap(); byAudio.set(music, cache); }
  let result = cache.get(referenceAudio);
  if (!result) { result = placeMusic(music, item.title, referenceAudio); cache.set(referenceAudio, result); }
  return result;
}

const close = (music: Pick<SongMusic, 'sourceSha256' | 'sourceDurationMs'>, audio: Pick<ReferenceAudioSource, 'sha256' | 'durationMs'>): boolean => music.sourceSha256 === audio.sha256 && Math.abs(music.sourceDurationMs - audio.durationMs) <= 50;

function placeMusic(music: SongMusic, title: string, audio: ReferenceAudio): SongBeats {
  const track = audioTracks(audio, title)[0]!;
  // Analysed from the music track's source file (0.5.9 on), or, for data from before, from the song audio itself.
  const pieces: SongMusicPiece[] | null = close(music, track.source)
    ? [...track.segments].sort((a, b) => a.startMs - b.startMs).map(({ startMs, sourceOffsetMs, durationMs }) => ({ startMs, sourceOffsetMs, durationMs }))
    : close(music, audio) ? [{ startMs: 0, sourceOffsetMs: 0, durationMs: audio.durationMs }] : null;
  if (!pieces) return CHANGED;
  const structure = music.structure;
  const beats: SongBeat[] = [];
  for (const beat of structure.beats) for (const [index, piece] of pieces.entries()) {
    if (beat.atMs < piece.sourceOffsetMs || beat.atMs >= piece.sourceOffsetMs + piece.durationMs) continue;
    beats.push({ id: index ? `${beat.id}@${index}` : beat.id, sourceId: beat.id, atMs: piece.startMs + beat.atMs - piece.sourceOffsetMs, strong: beat.strong });
  }
  beats.sort((a, b) => a.atMs - b.atMs);
  const segments: SongBeatSegment[] = [];
  for (const segment of musicStructureSegments(structure)) {
    let part = 0;
    for (const piece of pieces) {
      const start = Math.max(segment.startMs, piece.sourceOffsetMs), end = Math.min(segment.endMs, piece.sourceOffsetMs + piece.durationMs);
      if (end <= start) continue;
      segments.push({ ...segment, id: part ? `${segment.id}@${part}` : segment.id, sourceId: segment.id, startMs: piece.startMs + start - piece.sourceOffsetMs, endMs: piece.startMs + end - piece.sourceOffsetMs });
      part++;
    }
  }
  segments.sort((a, b) => a.startMs - b.startMs);
  const editPointsMs = [...new Set([...beats.map(beat => beat.atMs), ...segments.flatMap(segment => [segment.startMs, segment.endMs])])].sort((a, b) => a - b);
  return { state: structure.state, method: music.method, taskId: structure.taskId, bpm: structure.bpm, beatsPerBar: structure.beatsPerBar, beats, segments, editPointsMs, pieces };
}

/** Where a moment of the song is in the analysed audio; undefined where the song plays no part of it (cut out or silent). */
export function songTimeToMusicSource(beats: SongBeatsResult, songMs: number): number | undefined {
  const piece = beats.pieces.find(entry => songMs >= entry.startMs && songMs <= entry.startMs + entry.durationMs);
  return piece ? piece.sourceOffsetMs + songMs - piece.startMs : undefined;
}

const densities = new WeakMap<readonly SongBeat[], Partial<Record<AudioBeatLevel, readonly SongBeat[]>>>();
/** The beats an editor shows at a density, decided when shown and never saved: every beat, every other beat, or only
 * the strong ones. The same array for the same beats and density. */
export function songBeatsAtDensity(beats: readonly SongBeat[], level: AudioBeatLevel): readonly SongBeat[] {
  if (level === 'dense') return beats;
  let cache = densities.get(beats);
  if (!cache) { cache = {}; densities.set(beats, cache); }
  return cache[level] ??= level === 'standard' ? beats.filter((_, index) => index % 2 === 0) : beats.filter(beat => beat.strong);
}
