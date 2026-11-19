import type { LightingDocument, LightingEvent, LightingTrack, Ma2FirstTrackReceipt, Ma2FirstTrackRequest, Ma2PoolRoute, Ma2SongBinding, Ma2SongPoint } from '@tb/schema';

import { MA2_FRAME_MS } from './ma2-time-origin';
import { lightingTrackEnabled } from './lighting-track-state';
import { lightingEventTime, LightingTempoMap } from './lighting-edit';

type Binding = NonNullable<LightingDocument['ma2Bindings']>[number];

export function firstTimecodeTrack(binding: Binding) {
  const firstId = binding.baselineTracks[0]?.id;
  return firstId ? binding.trackMappings?.find(mapping => mapping.trackId === firstId)
    ?? binding.mappings.find(mapping => mapping.trackId === firstId) : undefined;
}

export function isWorkbenchCue(binding: Binding, track: LightingTrack, event: LightingEvent): boolean {
  if (event.kind === 'empty-cue') return true;
  if (event.kind !== 'ma2' || event.action !== 'goto') return false;
  const legacy = binding.emptyCueSequence;
  return Boolean(event.attributes || event.includeTracking !== undefined || track.group === 'effect-canvas' || track.group === 'empty-cues'
    || event.librarySource || event.effectGroupId || legacy && legacy.sequence === event.sequence
    && legacy.points.some(point => point.id === event.id && Number(point.cue) === Number(event.cue)));
}

/** Only placements made in the workbench move. A console-authored parallel track keeps its playback. */
export function firstTrackCuePlan(document: LightingDocument) {
  const binding = document.ma2Bindings?.length === 1 && document.ma2Bindings[0];
  if (!binding || !binding.baselineTracks.length) return null;
  const firstId = binding.baselineTracks[0]!.id;
  const first = firstTimecodeTrack(binding);
  const known = new Map(binding.mappings.map(mapping => [mapping.eventId, mapping]));
  const tempo = new LightingTempoMap(document.tempos);
  type Member = Extract<LightingEvent, { kind: 'ma2' | 'empty-cue' }>;
  const groups = new Map<string, { event: Member; alreadyPlaced: boolean; enabled: boolean }[]>();
  for (const track of document.tracks) for (const clip of track.clips) for (const event of clip.events) {
    if (event.kind !== 'empty-cue' && (event.kind !== 'ma2' || event.action !== 'goto' || !event.sequence || !event.cue)) continue;
    const previous = known.get(event.id);
    const authored = isWorkbenchCue(binding, track, event);
    if (!authored) continue;
    const enabled = !clip.muted && lightingTrackEnabled(document, track);
    const frame = Math.round((lightingEventTime(clip, event, tempo) + (binding.timeOriginMs ?? 0)) / MA2_FRAME_MS);
    const key = JSON.stringify([event.effectGroupId ?? event.id, frame, enabled]);
    const group = groups.get(key) ?? [];
    group.push({ event, enabled, alreadyPlaced: event.kind === 'ma2' && !event.attributes && event.includeTracking === undefined && previous?.trackId === firstId && track.id === firstId && previous.sequence === event.sequence });
    groups.set(key, group);
  }
  const points: Ma2FirstTrackRequest['points'] = [];
  const members = new Map<string, { ids: string[]; sources: NonNullable<Extract<Member, { kind: 'ma2' }>['sourceIngredients']>; enabled: boolean }>();
  for (const group of groups.values()) {
    if (group.every(member => member.alreadyPlaced)) continue;
    group.sort(({ event: a }, { event: b }) => (a.kind === 'ma2' ? a.ingredientOrder ?? Number(a.id !== a.effectGroupId) : 0) - (b.kind === 'ma2' ? b.ingredientOrder ?? Number(b.id !== b.effectGroupId) : 0));
    const leader = group.find(({ event }) => event.id === event.effectGroupId)?.event ?? group[0]!.event;
    const sources = group.flatMap(({ event }) => event.kind === 'ma2' && event.sequence && event.cue
      ? event.sourceIngredients ?? [{ sequence: event.sequence, cue: event.cue, executor: event.executor, name: event.label, ...(event.attributes && { attributes: event.attributes }), ...(event.includeTracking !== undefined && { includeTracking: event.includeTracking }), ...(event.preparation && { preparation: event.preparation }) }] : []);
    points.push({ id: leader.id, sources: sources.map(({ sequence, cue, includeTracking, attributes }) => ({ sequence, cue, ...(attributes && { attributes }), ...(includeTracking !== undefined && { includeTracking }) })) });
    members.set(leader.id, { ids: group.map(member => member.event.id), sources, enabled: group[0]!.enabled });
  }
  if (!points.length) return null;
  if (!first) throw new Error('原时间线第一轨没有可确认的执行器，请在控台检查第一轨的关联');
  const sequences = new Set(binding.mappings.filter(mapping => mapping.trackId === firstId && mapping.sequence).map(mapping => mapping.sequence!));
  if (sequences.size > 1) throw new Error('原时间线第一轨引用了多个序列，请在控台确认这条轨道的执行器');
  const expectedSequence = [...sequences][0];
  return { trackId: firstId, executor: first.executor, ...expectedSequence && { expectedSequence }, points, members };
}

export function applyFirstTrackCues(document: LightingDocument, plan: NonNullable<ReturnType<typeof firstTrackCuePlan>>, receipt: Ma2FirstTrackReceipt): LightingDocument {
  if (receipt.executor !== plan.executor || plan.expectedSequence && receipt.sequence !== plan.expectedSequence || plan.points.length !== receipt.cues.length) throw new Error('控台返回的第一轨或 Cue 数量和本次添加的不一致');
  const cues = new Map(plan.points.map((point, index) => [point.id, receipt.cues[index]!]));
  const consumed = new Set([...plan.members.values()].flatMap(member => member.ids));
  const next = structuredClone(document);
  const dest = next.tracks.find(track => track.id === plan.trackId);
  if (!dest) throw new Error('原时间线第一轨已经移除');
  const map = new LightingTempoMap(next.tempos);
  const added: LightingTrack['clips'] = [];
  for (const track of next.tracks) for (const clip of track.clips) {
    for (const event of clip.events) {
      const cue = cues.get(event.id);
      if (!cue || event.kind !== 'ma2' && event.kind !== 'empty-cue') continue;
      const member = plan.members.get(event.id)!;
      const at = lightingEventTime(clip, event, map);
      const muted = !member.enabled;
      let target = added.find(value => value.muted === muted);
      if (!target) {
        target = { ...clip, id: crypto.randomUUID(), start: 0, timeLock: 'time', muted, duration: 1, events: [] };
        added.push(target);
      }
      target.duration = Math.max(target.duration, at + 1);
      const placed = { ...event };
      if (placed.kind === 'ma2') { delete placed.includeTracking; delete placed.attributes; }
      target.events.push({ ...placed, at, kind: 'ma2', action: 'goto', executor: receipt.executor, sequence: receipt.sequence, cue,
        ...(member.sources.length > 0 && { sourceIngredients: member.sources }) });
    }
    clip.events = clip.events.filter(event => !consumed.has(event.id));
  }
  dest.clips.push(...added);
  const bound = new Set(next.ma2Bindings![0]!.baselineTracks.map(track => track.id));
  next.tracks = next.tracks.filter(track => bound.has(track.id) || track.clips.some(clip => clip.events.length) || !document.tracks.find(old => old.id === track.id)?.clips.some(clip => clip.events.some(event => consumed.has(event.id))));
  const remaining = new Set(next.tracks.map(track => track.id));
  const binding = next.ma2Bindings![0]!;
  if (binding.pendingTracks) binding.pendingTracks = binding.pendingTracks.filter(track => remaining.has(track.trackId));
  return next;
}

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
