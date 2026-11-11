import { LightingTempoMap, lightingEventTime, songBeatsAtDensity, timecodeToMilliseconds, type ResolvedTimelineState, type SongBeats, type SongBeatsResult } from '@tb/core/link';
import type { AudioBeatLevel, LightingDocument, LinkCue, MtcFrameRate, ReferenceMediaClip } from '@tb/schema';

/** How long a clip or cue lasts on the timeline; an instant cue lasts 0. */
export function timelineItemDuration(props: { clips: readonly ReferenceMediaClip[]; cues: readonly LinkCue[] }, target: { kind: 'clip' | 'cue'; id: string }): number {
  return (target.kind === 'clip' ? props.clips.find(clip => clip.id === target.id)?.durationMs : props.cues.find(cue => cue.id === target.id)?.durationMs) ?? 0;
}

export function timelineSnapPoints(
  state: ResolvedTimelineState,
  cues: readonly LinkCue[],
  frameRate: MtcFrameRate,
  playheadMs?: number,
  excluded?: { kind: 'clip' | 'cue'; id: string }
): number[] {
  const visualIds = new Set(state.visualObsCues.map(entry => entry.cue.id));
  return [0, ...(playheadMs === undefined ? [] : [playheadMs]),
    ...state.clips.filter((entry) => excluded?.kind !== 'clip' || entry.clip.id !== excluded.id).flatMap((entry) => [entry.startMs, entry.endMs]),
    ...state.visualObsCues.filter((entry) => excluded?.kind !== 'cue' || entry.cue.id !== excluded.id).flatMap((entry) => [entry.startMs, entry.endMs]),
    ...cues.filter((cue) => !visualIds.has(cue.id)
      && (excluded?.kind !== 'cue' || cue.id !== excluded.id)).flatMap((cue) => {
      const start = timecodeToMilliseconds(cue.timecode, frameRate);
      return cue.durationMs === undefined ? [start] : [start, start + cue.durationMs];
    })
  ];
}

/**
 * A held part's snap points apart from the playhead: the one `before` it and the ones `after` it, in the order
 * timelineSnapPoints gives them (the earlier point wins a tie). A drag or trim reads the playhead in every frame and
 * puts it back between the two, so it snaps to the same points as when every move asked for the whole list.
 */
export function heldSnapPoints(state: ResolvedTimelineState, cues: readonly LinkCue[], frameRate: MtcFrameRate, held: { kind: 'clip' | 'cue'; id: string }): { before: number[]; after: number[] } {
  const [first = 0, ...after] = timelineSnapPoints(state, cues, frameRate, undefined, held);
  return { before: [first], after };
}

const beatSnaps = new WeakMap<SongBeatsResult, Partial<Record<AudioBeatLevel, readonly number[]>>>();
const noBeatSnaps: readonly number[] = [];

/**
 * The song's beat points the editor snaps to (0.5.9 E12): the song's `songBeats(item).editPointsMs`, the same points
 * as the lighting workspace, but only those drawn at the chosen spacing (`level`) and the section edges, so what
 * snaps is what is seen, as in 剪映. The only place the editor works out beat snap points; a song without beats has
 * none, and the timeline still snaps to its parts, the playhead and the markers. Same input, same array.
 */
export function songBeatSnapPoints(beats: SongBeats | undefined, level: AudioBeatLevel): readonly number[] {
  if (beats?.state !== 'ready') return noBeatSnaps;
  let cache = beatSnaps.get(beats);
  if (!cache) { cache = {}; beatSnaps.set(beats, cache); }
  const cached = cache[level];
  if (cached) return cached;
  const shown = new Set(songBeatsAtDensity(beats.beats, level).map(beat => beat.atMs));
  const edges = new Set(beats.segments.flatMap(segment => [segment.startMs, segment.endMs]));
  return cache[level] = beats.editPointsMs.filter(at => shown.has(at) || edges.has(at));
}

/** The lighting workspace never receives visual clip or OBS cue boundaries. */
export function lightingSnapPoints(document: LightingDocument | undefined, beats: readonly number[], durationMs: number, excludedEventId?: string): number[] {
  const points = [0, durationMs, ...beats];
  if (document) {
    const map = new LightingTempoMap(document.tempos);
    for (const track of document.tracks) for (const clip of track.clips) for (const event of clip.events) {
      if (event.id !== excludedEventId && event.kind === 'ma2') points.push(lightingEventTime(clip, event, map));
    }
  }
  return [...new Set(points.filter(ms => ms >= 0 && ms <= durationMs))].sort((a, b) => a - b);
}
