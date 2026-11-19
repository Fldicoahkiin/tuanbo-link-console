import type { LightingDocument, LightingTrack, Ma2PoolRoute, Ma2SongBinding, Ma2SongPoint } from '@tb/schema';

import { lightingEventTime, LightingTempoMap } from './lighting-edit';

/** Empty locations on an imported Timecode use a separate editable Sequence for this song. */
export function boundEmptyCuePoints(document: LightingDocument): Ma2SongPoint[] {
  if (document.ma2Bindings?.length !== 1 || !document.tracks.some(track => track.clips.some(clip => clip.events.some(event => event.kind === 'empty-cue')))) return [];
  const sequence = document.ma2Bindings[0]!.emptyCueSequence;
  const saved = new Map(sequence?.points.map(point => [point.id, point.cue]));
  const map = new LightingTempoMap(document.tempos);
  return document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events.flatMap(event => {
    const cue = saved.get(event.id);
    // Already recorded lights on these points are native self-references. Preserve their numbers
    // and contents when the operator adds the next empty point.
    if (event.kind !== 'empty-cue' && !(event.kind === 'ma2' && event.action === 'goto' && sequence && event.sequence === sequence.sequence && cue && Number(cue) === Number(event.cue))) return [];
    return [{ id: event.id, name: event.label, atMs: lightingEventTime(clip, event, map),
      cues: sequence && cue ? [{ sequence: sequence.sequence, cue, delayMs: 0 }] : [] }];
  })));
}

/** Change only the placeholder, retaining its edit identity, source track, time and undo history. */
export function routeBoundEmptyCues(document: LightingDocument, result: Ma2SongBinding): LightingDocument {
  const executor = result.executor;
  if (!executor || result.timecode || document.ma2Bindings?.length !== 1) throw new Error('控台没有确认这首歌空 Cue 的执行器');
  const cues = new Map(result.points.map(point => [point.id, point.cue]));
  const next = structuredClone(document);
  next.ma2Bindings![0]!.emptyCueSequence = result;
  for (const track of next.tracks) for (const clip of track.clips) {
    clip.events = clip.events.map(event => {
      if (event.kind !== 'empty-cue') return event;
      const cue = cues.get(event.id);
      if (!cue) throw new Error('控台没有读回时间线所需的空 Cue');
      return { ...event, kind: 'ma2', action: 'goto', executor, sequence: result.sequence, cue };
    });
  }
  return next;
}

/** All nonempty lighting tracks must have an explicit destination before a song can be confirmed. */
export function unboundMa2Tracks(document: LightingDocument): LightingTrack[] {
  if (!document.ma2Bindings?.length) return [];
  const bound = new Set(document.ma2Bindings.flatMap(binding => [...binding.baselineTracks.map(track => track.id), ...(binding.pendingTracks ?? []).map(track => track.trackId)]));
  return document.tracks.filter(track => !bound.has(track.id) && track.clips.some(clip => clip.events.some(event => ['ma2', 'ma2-fader', 'empty-cue'].includes(event.kind))));
}

/** A song-level issue: an unassigned track must never be attributed to an arbitrary Timecode. */
export function ma2TrackRoutingIssue(document: LightingDocument): string | null {
  const tracks = unboundMa2Tracks(document);
  return tracks.length ? `还有 ${tracks.length} 条灯光轨道没有确定控台位置（${tracks.map(track => track.name).join('、')}）。请在控台同步中关联这些轨道的执行器；这些 Cue 尚未写入控台` : null;
}

/** Pool references contain a Sequence and a Cue but have no physical executor of their own. */
export function ma2PoolSequencesToRoute(document: LightingDocument): number[] {
  if (document.ma2Bindings?.length !== 1) return [];
  const sequences = new Set<number>();
  for (const track of unboundMa2Tracks(document)) {
    const events = track.clips.flatMap(clip => clip.events);
    const first = events[0];
    if (first?.kind === 'ma2' && first.action === 'goto' && first.sequence && events.every(event =>
      event.kind === 'ma2' && event.action === 'goto' && event.sequence === first.sequence && !event.executor && event.cue)) sequences.add(first.sequence);
  }
  return [...sequences];
}

/** Called inside the lighting command: auto-route only an unambiguous executor to the one selected show. */
export function routeMa2Tracks(document: LightingDocument, assignments: readonly Ma2PoolRoute[] = []): LightingDocument {
  if (document.ma2Bindings?.length !== 1) return document;
  const unbound = new Set(unboundMa2Tracks(document).map(track => track.id));
  if (!unbound.size) return document;
  const next = structuredClone(document);
  const binding = next.ma2Bindings![0]!;
  for (const track of next.tracks.filter(value => unbound.has(value.id))) {
    const events = track.clips.flatMap(clip => clip.events);
    const executors = events.map(event => {
      if (event.kind !== 'ma2' && event.kind !== 'ma2-fader') return null;
      if (event.executor) return event.executor;
      if (event.kind !== 'ma2' || !event.sequence) return null;
      const known = [...new Set(binding.mappings.filter(mapping => mapping.sequence === event.sequence).map(mapping => mapping.executor))];
      return known.length === 1 ? known[0]! : assignments.find(value => value.sequence === event.sequence)?.executor ?? null;
    });
    const unique = [...new Set(executors)];
    const executor = unique.length === 1 ? unique[0] : null;
    if (!executor || !/^[1-9]\d*\.[1-9]\d*$/.test(executor)) continue;
    for (const event of events) if (event.kind === 'ma2' || event.kind === 'ma2-fader') event.executor = executor;
    if (track.cueStamp?.mode === 'fixed' && !track.cueStamp.executor) track.cueStamp.executor = executor;
    const knownTrack = binding.trackMappings?.find(value => value.executor === executor)?.trackId;
    const executorName = assignments.find(value => value.executor === executor)?.executorName ?? binding.baselineTracks.find(value => value.id === knownTrack)?.name ?? `执行器 ${executor}`;
    binding.pendingTracks = [...binding.pendingTracks ?? [], { trackId: track.id, executor, executorName }];
  }
  return binding.pendingTracks?.length === document.ma2Bindings[0]!.pendingTracks?.length ? document : next;
}
