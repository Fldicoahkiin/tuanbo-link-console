import { createHash, randomUUID } from 'node:crypto';
import { consoleLabelText, type Ma2LatestSide } from '@tb/core/link';
import type { Ma2SongBinding, Ma2SongConsoleEdits, Ma2SongSyncRequest } from '@tb/schema';
import { inspectMa2SequenceXml, inspectMa2TimecodeXml } from './ma2-timecode-xml';

type Points = Ma2SongSyncRequest['points'];
export type Ma2SongConsoleMerge = { points: Points; binding: Ma2SongBinding; edits: Ma2SongConsoleEdits };

/** 30 FPS frames, the resolution of a grandMA2 Timecode show. */
const frames = (ms: number): number => Math.round(ms * 30 / 1000);
const milli = (cue: string): number => Math.round(Number(cue) * 1000);
const cueText = (value: number): string => `${Math.floor(value / 1000)}.${String(value % 1000).padStart(3, '0')}`;
const showRevision = (xml: string): string => createHash('sha256').update(xml.replace(/<Info\b[^>]*\/>/g, '').replace(/>\s+</g, '><').trim()).digest('hex');

/**
 * Takes over what was edited on the console since the last confirmed sync (2026-10-26: both ways).
 * The last confirmed binding is the common base; per point and per kind of edit:
 * - a Cue deleted from the song's Sequence, or its trigger deleted from the song's Timecode show,
 *   removes the point; a Cue whose trigger alone was deleted stays in the Sequence;
 * - a trigger moved in the show moves the point;
 * - a trigger added for a Cue of the song's Sequence that no point uses adds a point at its time.
 * A point the software changed since too (its name, time or Cue for a deletion, its time for a move)
 * takes the later change, `latest` (2026-11-11, "矛盾的时候采用最新的"; it replaced 2026-10-26's "the
 * software's version"): the software's is written again, or the console's comes in. A Cue fired more
 * than once in the show keeps the software's time. The Sequence missing as a whole is not taken as a
 * deletion: the sync builds it again.
 */
export function mergeMa2SongConsoleEdits(binding: Ma2SongBinding, points: Points, remoteXml: string, showXml: string | null, latest: Ma2LatestSide, createId: () => string = randomUUID): Ma2SongConsoleMerge {
  const remote = inspectMa2SequenceXml(remoteXml).sequences[0]!;
  const base = inspectMa2SequenceXml(binding.baselineXml).sequences[0]!;
  const onConsole = new Set(remote.cues.map(cue => milli(cue.number)));
  const local = new Map(points.map(point => [point.id, point]));
  const sameName = (point: Points[number], cue: string): boolean => {
    const name = base.cues.find(value => milli(value.number) === milli(cue))?.name ?? '';
    return name === point.name || name === consoleLabelText(point.name) || !point.name && name === `Cue ${Number(cue)}`;
  };
  const own = (point: Points[number], cue: string): boolean => point.cues.length === 1 && point.cues[0]!.sequence === binding.sequence && milli(point.cues[0]!.cue) === milli(cue) && point.cues[0]!.delayMs === 0;
  const timeKept = (point: Points[number], old: Ma2SongBinding['points'][number]): boolean => old.atMs === undefined || frames(point.atMs) === frames(old.atMs);
  const untouched = (point: Points[number], old: Ma2SongBinding['points'][number]): boolean => own(point, old.cue) && sameName(point, old.cue) && timeKept(point, old);

  // Times the song's own show fires each Cue of its Sequence, in frames; only read when the show changed.
  const fired = new Map<number, number[]>();
  const show = showXml !== null && binding.timecode && showRevision(showXml) !== binding.timecode.revision ? inspectMa2TimecodeXml(showXml).timecodes[0] ?? null : null;
  if (show) for (const track of show.tracks) for (const subtrack of track.subtracks) for (const event of subtrack.events) {
    if (event.attributes.command !== 'Goto' || event.attributes.pressed === 'false') continue;
    const [kind, sequence, index] = event.cueAddress;
    if (event.cueAddress.length !== 3 || kind !== '1' || Number(sequence) !== binding.sequence) continue;
    const cue = remote.cues.find(value => value.index === Number(index));
    const time = Number(event.attributes.time ?? '0');
    if (!cue || !Number.isFinite(time) || time < 0) continue;
    fired.set(milli(cue.number), [...fired.get(milli(cue.number)) ?? [], time]);
  }

  const removed = new Set<string>(); const moved = new Map<string, number>();
  let conflicts = 0;
  const remove = (point: Points[number], old: Ma2SongBinding['points'][number]): void => {
    if (untouched(point, old)) { removed.add(old.id); return; }
    conflicts += 1;
    if (latest === 'remote') removed.add(old.id);
  };
  for (const old of binding.points) {
    const point = local.get(old.id);
    if (!point) continue;
    if (!onConsole.has(milli(old.cue))) { remove(point, old); continue; }
    if (!show || old.atMs === undefined) continue;
    const times = fired.get(milli(old.cue)) ?? [];
    if (!times.length) { remove(point, old); continue; }
    if (times.length !== 1 || Math.round(times[0]!) === frames(old.atMs)) continue;
    // Moved here to the same frame as there is no disagreement.
    if (!timeKept(point, old) && frames(point.atMs) !== Math.round(times[0]!)) { conflicts += 1; if (latest !== 'remote') continue; }
    moved.set(old.id, times[0]! * 1000 / 30);
  }
  const used = new Set([...binding.points.map(point => milli(point.cue)), ...points.flatMap(point => point.cues.filter(cue => cue.sequence === binding.sequence).map(cue => milli(cue.cue)))]);
  const added = [...fired].filter(([cue]) => !used.has(cue)).map(([cue, times]) => ({
    id: createId(), name: remote.cues.find(value => milli(value.number) === cue)?.name ?? '', atMs: Math.min(...times) * 1000 / 30, cue: cueText(cue)
  }));

  const merged: Points = [
    ...points.filter(point => !removed.has(point.id)).map(point => moved.has(point.id) ? { ...point, atMs: moved.get(point.id)! } : point),
    ...added.map(point => ({ id: point.id, name: point.name, atMs: point.atMs, cues: [{ sequence: binding.sequence, cue: point.cue, delayMs: 0 }] }))
  ].sort((a, b) => a.atMs - b.atMs);
  // A removed point leaves the base too, so the sync never deletes a Cue whose trigger alone was removed.
  // An added point stays out of it: the sync takes its Cue over as it is, without writing it.
  const confirmed = binding.points.filter(point => !removed.has(point.id)).map(point => moved.has(point.id) ? { ...point, atMs: moved.get(point.id)! } : point);
  return { points: merged, binding: { ...binding, points: confirmed }, edits: { moved: [...moved].map(([id, atMs]) => ({ id, atMs })), removed: [...removed], added, ...conflicts ? { conflicts: { count: conflicts, winner: latest } } : {} } };
}

/** True when the merge took over anything from the console, or chose between two changes of one point. */
export function hasMa2SongConsoleEdits(edits: Ma2SongConsoleEdits): boolean {
  return edits.moved.length + edits.removed.length + edits.added.length > 0 || edits.conflicts !== undefined;
}
