import { lightingDocumentSchema, lightingTrackSchema, type LightingDocument } from '@tb/schema';
import { LightingTempoMap, lightingEventTime } from './lighting-edit';
import { removeLightingEffects } from './lighting-effect-group';

/** An empty Cue is an editable timeline location, never a console action. */
export function placeEmptyLightingCue(document: LightingDocument, id: string, ms: number, durationMs: number, label = ''): LightingDocument {
  const map = new LightingTempoMap(document.tempos);
  const previous = document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events.filter(event => event.id === id).map(event => ({ clip, event })) ))[0];
  if (previous) ms = lightingEventTime(previous.clip, previous.event, map);
  if (!Number.isFinite(ms) || ms < 0 || ms >= durationMs) throw new Error('请在音频范围内添加 Cue');
  const base = previous ? removeLightingEffects(document, [id]) : document;
  // Keep empty locations outside native console bindings and material tracks.
  const track = base.tracks.find(entry => entry.group === 'empty-cues' && !entry.locked) ?? lightingTrackSchema.parse({
    id: crypto.randomUUID(), name: 'Cue 点位', kind: 'ma2', color: '#68c9ed', group: 'empty-cues', muted: false, solo: false, locked: false,
    channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: []
  });
  const clip = track.clips.find(entry => entry.timeLock === 'time' && entry.start === 0 && !entry.muted) ?? {
    id: crypto.randomUUID(), name: 'Cue 点位', start: 0, duration: durationMs, timeLock: 'time' as const, muted: false, events: []
  };
  const updated = { ...track, clips: [...track.clips.filter(entry => entry.id !== clip.id), { ...clip, duration: Math.max(clip.duration, ms + 1),
    events: [...clip.events, { id, kind: 'empty-cue' as const, at: ms, label }] }] };
  return lightingDocumentSchema.parse({ ...base, version: 2, tracks: [...base.tracks.filter(entry => entry.id !== track.id), updated] });
}
