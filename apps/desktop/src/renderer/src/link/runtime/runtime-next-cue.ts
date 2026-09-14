import { timecodeToFrameNumber, type CueExecutionReport } from '@tb/core/link';
import type { MtcFrameRate, RundownItem } from '@tb/schema';

export function findNextCueId(input: {
  item: RundownItem | undefined;
  frameRate: MtcFrameRate;
  currentFrame: number;
  missedCueIds: readonly string[];
  reports: readonly CueExecutionReport[];
}): string | null {
  if (!input.item) return null;
  const missed = new Set(input.missedCueIds);
  const executed = new Set(input.reports.map((report) => report.cueId));
  return input.item.cues
    .filter((cue) => cue.enabled && !missed.has(cue.id) && !executed.has(cue.id))
    .map((cue) => ({ cue, frame: timecodeToFrameNumber(cue.timecode, input.frameRate) }))
    .filter(({ frame }) => frame > input.currentFrame)
    .sort((left, right) => left.frame - right.frame)[0]?.cue.id ?? null;
}
