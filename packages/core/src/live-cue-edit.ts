import { linkCueSchema, type LiveCueEditRequest, type MtcFrameRate, type RundownItem } from '@tb/schema';
import { timecodeToMilliseconds } from './mtc-timecode';
import { compileRundownTimelineCues, type ScheduledTimelineCue } from './timeline-state';

export type PreparedCueEdit = {
  request: LiveCueEditRequest;
  item: RundownItem;
  events: readonly ScheduledTimelineCue[];
  affectedIds: readonly string[];
  requiredChannels: readonly ('obs' | 'midi')[];
  earliestAffectedMs: number;
};
export type CueEditResult = { status: 'not-applied'; reason: string } | {
  status: 'awaiting-preparation'; transactionId: string; requiredChannels: readonly ('obs' | 'midi')[]; latestCommitPositionMs: number;
} | { status: 'applied'; revision: number };

/** Covers local Cue actions only. MA2 native Timecode and media-resource changes
 * require their separate preparation/verification paths; this cannot authorize
 * live XML import or switch a native timeline to local execution. */
export function prepareLiveCueEdit(item: RundownItem, frameRate: MtcFrameRate, request: LiveCueEditRequest): PreparedCueEdit {
  const before = new Map(item.cues.map(cue => [cue.id, cue]));
  const after = new Map(request.cues.map(cue => [cue.id, cue]));
  const affectedIds: string[] = [], requiredChannels = new Set<'obs' | 'midi'>();
  let earliestAffectedMs = Infinity;
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const oldCue = before.get(id), newCue = after.get(id);
    // Zod produces stable field order for equivalent immutable document objects.
    if (oldCue && newCue && JSON.stringify(linkCueSchema.parse(oldCue)) === JSON.stringify(newCue)) continue;
    affectedIds.push(id);
    for (const cue of [oldCue, newCue]) {
      if (!cue) continue;
      earliestAffectedMs = Math.min(earliestAffectedMs, timecodeToMilliseconds(cue.timecode, frameRate));
      for (const action of cue.actions) requiredChannels.add(action.kind.startsWith('midi.') ? 'midi' : 'obs');
    }
  }
  const next = { ...item, cues: request.cues };
  return { request, item: next, events: compileRundownTimelineCues(next, frameRate), affectedIds,
    requiredChannels: [...requiredChannels], earliestAffectedMs };
}
