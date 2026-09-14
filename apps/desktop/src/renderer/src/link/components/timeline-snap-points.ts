import { timecodeToMilliseconds, type ResolvedTimelineState } from '@tb/core/link';
import type { LinkCue, MtcFrameRate } from '@tb/schema';

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
  return [0, ...(playheadMs === undefined ? [] : [playheadMs]),
    ...state.clips.filter((entry) => excluded?.kind !== 'clip' || entry.clip.id !== excluded.id).flatMap((entry) => [entry.startMs, entry.endMs]),
    ...state.visualObsCues.filter((entry) => excluded?.kind !== 'cue' || entry.cue.id !== excluded.id).flatMap((entry) => [entry.startMs, entry.endMs]),
    ...cues.filter((cue) => !state.visualObsCues.some((entry) => entry.cue.id === cue.id)
      && (excluded?.kind !== 'cue' || cue.id !== excluded.id)).flatMap((cue) => {
      const start = timecodeToMilliseconds(cue.timecode, frameRate);
      return [start, start + displayedSceneDuration(cue, pixelsPerSecond)];
    })
  ];
}
