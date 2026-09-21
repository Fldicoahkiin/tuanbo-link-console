import { LightingTempoMap, lightingEventTime, timecodeToMilliseconds, type ResolvedTimelineState } from '@tb/core/link';
import type { LightingDocument, LinkCue, MtcFrameRate } from '@tb/schema';

export function displayedSceneDuration(cue: LinkCue | undefined, pixelsPerSecond: number): number {
  return cue?.durationMs ?? (cue?.actions.some((action) => action.kind === 'obs.setProgramScene') ? 112 / pixelsPerSecond * 1000 : 0);
}

export function timelineSnapPoints(
  state: ResolvedTimelineState,
  cues: readonly LinkCue[],
  frameRate: MtcFrameRate,
  pixelsPerSecond: number,
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
      return [start, start + displayedSceneDuration(cue, pixelsPerSecond)];
    })
  ];
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
