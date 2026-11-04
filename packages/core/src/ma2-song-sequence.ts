import { lightingDocumentSchema, lightingTrackSchema, type LightingDocument, type LightingEvent, type Ma2SongConsoleEdits, type Ma2SongPoint, type Ma2SongSyncResult } from '@tb/schema';
import { LightingTempoMap, lightingClipSpan, lightingEventTime } from './lighting-edit';
import { consoleLabelText } from './ma2-console-label';

/** Song positions are stable identities; pool Cue numbers are never inferred from labels. */
export function ma2SongPoints(document: LightingDocument): Ma2SongPoint[] {
  const map = new LightingTempoMap(document.tempos);
  const groups = new Map<string, { name: string; atMs: number; values: Array<{ event: LightingEvent; ms: number }> }>();
  for (const track of document.tracks) for (const clip of track.clips) for (const event of clip.events) {
    if (event.kind !== 'ma2' && event.kind !== 'empty-cue') continue;
    if (event.kind === 'ma2' && (event.action !== 'goto' || event.preparation)) throw new Error('歌曲序列只同步指定 Cue；埋步和执行器动作请保留在原时间线');
    const id = event.effectGroupId ?? event.id; const ms = lightingEventTime(clip, event, map);
    const group = groups.get(id) ?? { name: event.label, atMs: ms, values: [] };
    group.atMs = Math.min(group.atMs, ms); if (event.id === id) group.name = event.label;
    group.values.push({ event, ms }); groups.set(id, group);
  }
  return [...groups].map(([id, group]) => ({ id, name: group.name, atMs: group.atMs, cues: group.values.flatMap(({ event, ms }) => event.kind === 'ma2' && event.sequence && event.cue ? [{ sequence: event.sequence, cue: event.cue, delayMs: ms - group.atMs }] : []) })).sort((a, b) => a.atMs - b.atMs);
}

/**
 * Edits the sync took over from the console (2026-10-26, both ways), applied to points this request
 * observed and nobody changed here meanwhile: those keep their local edit, which the next sync writes.
 * A moved point moves like a Cue dragged here (its clip starts earlier when needed); one on a locked
 * track stays, so the next sync writes it back. An added point goes on the Cue location track.
 */
function applyMa2SongConsoleEdits(document: LightingDocument, unchanged: ReadonlySet<string>, edits: Ma2SongConsoleEdits, binding: Ma2SongSyncResult['binding']): LightingDocument {
  const map = new LightingTempoMap(document.tempos);
  const origin = document.music?.firstBeatMs ?? 0;
  const points = new Map(ma2SongPoints(document).map(point => [point.id, point]));
  // Each event of a moved point keeps its offset from the point's start.
  const shift = new Map(edits.moved.filter(edit => unchanged.has(edit.id) && points.has(edit.id)).map(edit => [edit.id, edit.atMs - points.get(edit.id)!.atMs]));
  const removed = new Set(edits.removed.filter(id => unchanged.has(id)));
  const present = new Set(document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events.map(event => event.id))));
  const added = edits.added.filter(point => !present.has(point.id));
  let tracks = document.tracks.map(track => ({ ...track, clips: track.clips.flatMap(clip => {
    const kept = clip.events.filter(event => !removed.has(event.effectGroupId ?? event.id));
    const moves = new Map(track.locked ? [] : kept.flatMap(event => {
      const delta = shift.get(event.effectGroupId ?? event.id);
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
  const document = result.consoleEdits ? applyMa2SongConsoleEdits(source, unchanged, result.consoleEdits, result.binding) : source;
  // A moved point is still the one this request observed: it takes its Cue below like any other.
  const mapping = new Map(result.binding.points.map(point => [point.id, point.cue]));
  const cues = result.library.sequences.find(value => value.sequence === result.binding.sequence)?.cues ?? [];
  return lightingDocumentSchema.parse({ ...document, version: 2, consoleSong: result.binding, tracks: document.tracks.map(track => ({ ...track, clips: track.clips.map(clip => ({ ...clip, events: clip.events.flatMap((event): LightingEvent[] => {
    const id = event.effectGroupId ?? event.id;
    if (!unchanged.has(id)) return [event];
    const cue = mapping.get(id); if (!cue || event.kind !== 'ma2' && event.kind !== 'empty-cue') return [event];
    // The console holds pinyin for a Chinese label; only a name changed on the console replaces it.
    const consoleName = cues.find(value => Number(value.number) === Number(cue))?.name;
    const label = !consoleName || consoleName === consoleLabelText(event.label) ? event.label : consoleName;
    if (event.id !== id) return [];
    return [{ id, kind: 'ma2', at: event.at, action: 'goto', executor: result.binding.executor ?? '', sequence: result.binding.sequence, cue,
      label,
      ...(event.beatAnchor === undefined ? {} : { beatAnchor: event.beatAnchor }),
      ...(event.runMode ? { runMode: event.runMode } : {}) }];
  }) })) })) });
}
