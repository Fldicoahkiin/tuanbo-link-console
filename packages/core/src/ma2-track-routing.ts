import type { LightingDocument, LightingTrack, Ma2PoolRoute } from '@tb/schema';

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
