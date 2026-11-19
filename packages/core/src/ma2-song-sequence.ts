import { lightingDocumentSchema, lightingTrackSchema, type LightingDocument, type LightingEvent, type Ma2SongConsoleEdits, type Ma2SongPoint, type Ma2SongSyncResult } from '@tb/schema';
import { LightingTempoMap, lightingClipSpan, lightingEventTime } from './lighting-edit';
import { MA2_FRAME_MS } from './ma2-time-origin';
import { consoleLabelText } from './ma2-console-label';
import { lightingTrackEnabled } from './lighting-track-state';

/** A song joins console sync only after association or an explicit new-timeline destination. */
export function hasMa2SongSyncTarget(document: LightingDocument | undefined): boolean {
  return Boolean(document && (document.consoleSong || document.timelineDestination || document.ma2Bindings?.length));
}

/** Song positions are stable identities; pool Cue numbers are never inferred from labels. */
function songCueGroups(document: LightingDocument) {
  type Event = Extract<LightingEvent, { kind: 'ma2' | 'empty-cue' }>;
  type Member = { event: Event; at: number };
  const map = new LightingTempoMap(document.tempos);
  const groups = new Map<string, { enabled: boolean; members: Member[] }>();
  for (const track of document.tracks) for (const clip of track.clips) for (const event of clip.events) {
    if (event.kind !== 'ma2' && event.kind !== 'empty-cue') continue;
    if (event.kind === 'ma2' && (event.action !== 'goto' || event.preparation)) throw new Error('歌曲序列只同步指定 Cue；埋步和执行器动作请保留在原时间线');
    const at = lightingEventTime(clip, event, map);
    const enabled = lightingTrackEnabled(document, track) && !clip.muted;
    const key = JSON.stringify([event.effectGroupId ?? event.id, Math.round(at / MA2_FRAME_MS), enabled]);
    const group = groups.get(key) ?? { enabled, members: [] };
    group.members.push({ event, at });
    groups.set(key, group);
  }
  const order = ({ event }: Member): number => event.kind === 'ma2' ? event.ingredientOrder ?? Number(event.id !== event.effectGroupId) : 0;
  return [...groups.values()].map(({ enabled, members }) => {
    members.sort((a, b) => order(a) - order(b));
    const leader = members.find(({ event }) => event.id === event.effectGroupId) ?? members[0]!;
    return { id: leader.event.id, name: leader.event.label, atMs: leader.at, members, enabled };
  });
}

export function ma2SongPoints(document: LightingDocument): Ma2SongPoint[] {
  return songCueGroups(document).map(({ id, name, atMs, enabled, members }) => ({
    id, name, atMs, ...(!enabled && { enabled: false }),
    cues: members.flatMap(({ event }) => event.kind === 'ma2' && event.sequence && event.cue
      ? [{ sequence: event.sequence, cue: event.cue, ...(event.attributes && { attributes: event.attributes }), ...(event.includeTracking !== undefined && { includeTracking: event.includeTracking }), delayMs: 0 }] : [])
  })).sort((a, b) => a.atMs - b.atMs);
}

/**
 * Edits the sync took over from the console (2026-10-26, both ways), applied to points this request
 * observed and nobody changed here meanwhile: those keep their local edit, which the next sync writes.
 * A moved point moves like a Cue dragged here (its clip starts earlier when needed); one on a locked
 * track stays, so the next sync writes it back. An added point goes on the Cue location track.
 */
function applyMa2SongConsoleEdits(document: LightingDocument, unchanged: ReadonlySet<string>, edits: Ma2SongConsoleEdits, binding: Ma2SongSyncResult['binding'], leaders: ReadonlyMap<string, string>): LightingDocument {
  const map = new LightingTempoMap(document.tempos);
  const origin = document.music?.firstBeatMs ?? 0;
  const points = new Map(ma2SongPoints(document).map(point => [point.id, point]));
  // Each event of a moved point keeps its offset from the point's start.
  const shift = new Map(edits.moved.filter(edit => unchanged.has(edit.id) && points.has(edit.id)).map(edit => [edit.id, edit.atMs - points.get(edit.id)!.atMs]));
  const removed = new Set(edits.removed.filter(id => unchanged.has(id)));
  const present = new Set(document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events.map(event => event.id))));
  const added = edits.added.filter(point => !present.has(point.id));
  let tracks = document.tracks.map(track => ({ ...track, clips: track.clips.flatMap(clip => {
    const kept = clip.events.filter(event => !removed.has(leaders.get(event.id) ?? event.id));
    const moves = new Map(track.locked ? [] : kept.flatMap(event => {
      const delta = shift.get(leaders.get(event.id) ?? event.id);
      return delta === undefined ? [] : [[event.id, Math.max(0, lightingEventTime(clip, event, map) + delta)] as const];
    }));
    if (!moves.size) return [kept.length === clip.events.length ? clip : { ...clip, events: kept }];
    const { startMs, endMs } = lightingClipSpan(clip, map);
    const earliest = Math.min(startMs, ...kept.map(event => moves.get(event.id) ?? lightingEventTime(clip, event, map)));
    const events = kept.map((event): LightingEvent => {
      const ms = moves.get(event.id) ?? lightingEventTime(clip, event, map);
      const next: LightingEvent = { ...event, at: ms - earliest };
      if (event.kind === 'note' && next.kind === 'note' && clip.timeLock === 'beat') next.duration = map.beatToMs(clip.start + event.at + event.duration) - lightingEventTime(clip, event, map);
      if (clip.timeLock === 'beat' || event.beatAnchor !== undefined && moves.has(event.id)) {
        if (ms >= origin) next.beatAnchor = map.msToBeat(ms - origin); else delete next.beatAnchor;
      }
      return next;
    });
    return [{ ...clip, start: earliest, timeLock: 'time' as const, events, duration: Math.max(endMs - earliest, ...events.map(event => event.at + (event.kind === 'note' ? event.duration : 0.001))) }];
  }) }));
  if (added.length) {
    const track = tracks.find(entry => entry.group === 'empty-cues' && !entry.locked) ?? lightingTrackSchema.parse({
      id: crypto.randomUUID(), name: 'Cue 点位', kind: 'ma2', color: '#68c9ed', group: 'empty-cues', muted: false, solo: false, locked: false,
      channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: []
    });
    const clip = track.clips.find(entry => entry.timeLock === 'time' && entry.start === 0 && !entry.muted) ?? {
      id: crypto.randomUUID(), name: 'Cue 点位', start: 0, duration: 0, timeLock: 'time' as const, muted: false, events: []
    };
    const events: LightingEvent[] = [...clip.events, ...added.map(point => ({ id: point.id, kind: 'ma2' as const, at: point.atMs, action: 'goto' as const,
      executor: binding.executor ?? '', sequence: binding.sequence, cue: point.cue, label: point.name }))];
    const updated = { ...track, clips: [...track.clips.filter(entry => entry.id !== clip.id), { ...clip, events, duration: Math.max(clip.duration, ...events.map(event => event.at + 1)) }] };
    tracks = [...tracks.filter(entry => entry.id !== track.id), updated];
  }
  return { ...document, tracks };
}

/** Apply only the positions observed by this request. Concurrent local edits remain pending. */
export function applyMa2SongReadback(source: LightingDocument, observed: Ma2SongPoint[], result: Ma2SongSyncResult): LightingDocument {
  const current = new Map(ma2SongPoints(source).map(point => [point.id, point]));
  const unchanged = new Set(observed.filter(point => JSON.stringify(point) === JSON.stringify(current.get(point.id))).map(point => point.id));
  const groups = songCueGroups(source);
  const leaders = new Map(groups.flatMap(group => group.members.map(({ event }) => [event.id, group.id] as const)));
  const document = result.consoleEdits ? applyMa2SongConsoleEdits(source, unchanged, result.consoleEdits, result.binding, leaders) : source;
  // A moved point is still the one this request observed: it takes its Cue below like any other.
  const materials = new Map<string, NonNullable<Extract<LightingEvent, { kind: 'ma2' }>['sourceIngredients']>>();
  for (const { id, members } of groups) for (const { event } of members) {
    if (event.kind !== 'ma2' || !event.sequence || !event.cue) continue;
    const sources = event.sourceIngredients ?? [{ sequence: event.sequence, cue: event.cue, name: event.label, executor: event.executor, ...(event.attributes && {attributes: event.attributes}),
      ...(event.includeTracking !== undefined && { includeTracking: event.includeTracking }) }];
    if (event.sourceIngredients || event.attributes || event.includeTracking !== undefined || event.sequence !== result.binding.sequence || event.effectGroupId) {
      materials.set(id, [...materials.get(id) ?? [], ...sources]);
    }
  }
  const mapping = new Map(result.binding.points.map(point => [point.id, point.cue]));
  const cues = result.library.sequences.find(value => value.sequence === result.binding.sequence)?.cues ?? [];
  return lightingDocumentSchema.parse({ ...document, version: 2, consoleSong: result.binding,
    ...(document.timelineDestination ? { timelineDestination: { ...document.timelineDestination, sequence: result.binding.sequence, executor: result.binding.executor ?? document.timelineDestination.executor, timecode: result.binding.timecode?.number ?? document.timelineDestination.timecode } } : {}), tracks: document.tracks.map(track => ({ ...track, clips: track.clips.map(clip => ({ ...clip, events: clip.events.flatMap((event): LightingEvent[] => {
    const id = leaders.get(event.id) ?? event.id;
    if (!unchanged.has(id)) return [event];
    const cue = mapping.get(id); if (!cue || event.kind !== 'ma2' && event.kind !== 'empty-cue') return [event];
    // The console holds pinyin for a Chinese label; only a name changed on the console replaces it.
    const consoleName = cues.find(value => Number(value.number) === Number(cue))?.name;
    const label = !consoleName || consoleName === consoleLabelText(event.label) ? event.label : consoleName;
    if (event.id !== id) return [];
    return [{ id, kind: 'ma2', at: event.at, action: 'goto', executor: result.binding.executor ?? '', sequence: result.binding.sequence, cue,
      label, ...(materials.has(id) && { sourceIngredients: materials.get(id) }),
      ...(event.beatAnchor === undefined ? {} : { beatAnchor: event.beatAnchor }),
      ...(event.runMode ? { runMode: event.runMode } : {}) }];
  }) })) })) });
}
