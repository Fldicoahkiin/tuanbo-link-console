import type { Ma2SongBinding, Ma2SongPoint } from '@tb/schema';
import { editMa2SongSequence, emptyMa2SequenceXml, inspectMa2SequenceXml, ma2SequenceCueFingerprints } from './ma2-timecode-xml';

export type Ma2SongCreationRecovery = { binding: Ma2SongBinding; points: Ma2SongPoint[]; restores: Array<{ cue: string; xml: string }> };

/** Record every possible post-Copy state before writing a multi-source merge. */
export function ma2SongCreationStages(skeletonXml: string, changes: readonly {
  cue: string; name: string; sources?: readonly { xml: string; cue: string }[];
}[]): Record<string, string[]> {
  const skeleton = ma2SequenceCueFingerprints(skeletonXml, false);
  const report = inspectMa2SequenceXml(skeletonXml);
  const empty = emptyMa2SequenceXml(report.sequences[0]!.number, report.version);
  return Object.fromEntries(changes.map(change => {
    const states = [skeleton.get(change.cue)!];
    for (let count = 1; count <= (change.sources?.length ?? 0); count++) {
      const xml = editMa2SongSequence(empty, '', [{ ...change, sources: change.sources!.slice(0, count) }], []);
      states.push(ma2SequenceCueFingerprints(xml, false).get(change.cue)!);
    }
    return [change.cue, [...new Set(states)]];
  }));
}

/** Recover the same object and retain new local points, edits and remote extras. */
export function recoverMa2SongCreation(
  binding: Ma2SongBinding, skeletonXml: string, remoteXml: string, points: Ma2SongPoint[],
  originalPoints: readonly Ma2SongPoint[] = points, stages: Readonly<Record<string, readonly string[]>> = {}, heldCues: readonly string[] = [],
  heldNames: readonly string[] = [], heldSequenceName = false
): Ma2SongCreationRecovery {
  const expected = ma2SequenceCueFingerprints(binding.baselineXml, false);
  const skeleton = ma2SequenceCueFingerprints(skeletonXml, false);
  const remote = ma2SequenceCueFingerprints(remoteXml, false);
  const actualSequence = inspectMa2SequenceXml(remoteXml).sequences[0]!;
  const intendedSequence = inspectMa2SequenceXml(binding.baselineXml).sequences[0]!;
  const beforeSequence = inspectMa2SequenceXml(skeletonXml).sequences[0]!;
  if (actualSequence.number !== binding.sequence) throw new Error(`中断记录属于序列 ${binding.sequence}，控台回读对象不一致`);
  const known = (cue: string): boolean => {
    if (heldCues.includes(cue)) return false;
    const value = remote.get(cue);
    return value !== undefined && (value === expected.get(cue) || value === skeleton.get(cue) || stages[cue]?.includes(value) === true);
  };
  const nameChanges = binding.points.flatMap(saved => {
    const intended = intendedSequence.cues.find(cue => Number(cue.number) === Number(saved.cue));
    if (!intended) return [];
    const before = beforeSequence.cues.find(cue => Number(cue.number) === Number(saved.cue));
    const actual = actualSequence.cues.find(cue => Number(cue.number) === Number(saved.cue));
    const deletedLocally = !points.some(point => point.id === saved.id);
    const name = heldNames.includes(saved.cue) ? intended.name : actual && (actual.name === intended.name || actual.name === before?.name) ? actual.name : before?.name ?? intended.name;
    return [{ cue: saved.cue, name: name ?? '', ...(!known(saved.cue) || deletedLocally ? { sources: [{ xml: before && !heldCues.includes(saved.cue) ? skeletonXml : binding.baselineXml, cue: saved.cue }] } : {}) }];
  });
  const sequenceName = heldSequenceName ? intendedSequence.name : actualSequence.name === intendedSequence.name || actualSequence.name === beforeSequence.name ? actualSequence.name : beforeSequence.name;
  const baselineXml = editMa2SongSequence(remoteXml, sequenceName ?? binding.name, nameChanges, []);
  const restores: Ma2SongCreationRecovery['restores'] = [];
  const recovered = points.map(point => {
    const saved = binding.points.find(value => value.id === point.id);
    if (!saved) return point;
    const original = originalPoints.find(value => value.id === point.id);
    const unchanged = original && JSON.stringify(original.cues) === JSON.stringify(point.cues);
    const returnedToSelf = !unchanged && original && point.cues.length === 1
      && point.cues[0]!.sequence === binding.sequence && Number(point.cues[0]!.cue) === Number(saved.cue)
      && skeleton.has(saved.cue) && expected.get(saved.cue) !== skeleton.get(saved.cue);
    // Undo may restore the original self-reference after our pending replace
    // reached MA2. That reference must mean its write-before snapshot, not the
    // new content that happens to occupy the same number now.
    if (returnedToSelf) { restores.push({ cue: saved.cue, xml: skeletonXml }); return point; }
    const value = remote.get(saved.cue);
    if (value === undefined) return unchanged && skeleton.has(saved.cue) ? { ...point, cues: [{ sequence: binding.sequence, cue: saved.cue, delayMs: 0 }] } : point;
    const completed = value === expected.get(saved.cue);
    // Unknown content is retained in the actual snapshot. Keeping the intended
    // baseline makes it a field-level comparison in the normal planner, so one
    // changed Cue does not prevent the remaining song from being reconciled.
    if (unchanged && (completed || expected.get(saved.cue) === skeleton.get(saved.cue) && !heldCues.includes(saved.cue))) return { ...point, cues: [{ sequence: binding.sequence, cue: saved.cue, delayMs: 0 }] };
    return point;
  });
  return { points: recovered, restores, binding: { ...binding, baselineXml, points: binding.points.filter(point => remote.has(point.cue) || skeleton.has(point.cue)) } };
}
