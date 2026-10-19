import { lightingDocumentSchema, lightingTrackSchema, type LightingDocument } from '@tb/schema';
import { assertMusicCueConflicts } from './lighting-music';

/** Place a console reference without creating a library entry or changing existing timing. */
export function placeConsoleCue(document: LightingDocument, reference: { sequence: number; cue: string; executor: string; name: string }, ms: number, durationMs: number): LightingDocument {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isFinite(ms) || ms < 0 || ms >= durationMs) throw new Error('Cue 超出歌曲范围');
  const track = document.tracks.find(value => value.kind === 'ma2' && value.group === 'effect-canvas' && !value.locked && !value.muted && value.cueStamp?.mode === 'fixed'
    && value.cueStamp.executor === reference.executor && (reference.executor || value.cueStamp.sequence === reference.sequence))
    ?? lightingTrackSchema.parse({ id: crypto.randomUUID(), name: '灯光', kind: 'ma2', color: '#68c9ed', group: 'effect-canvas', muted: false, solo: false, locked: false,
      channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [], cueStamp: { mode: 'fixed', sequence: reference.sequence, cue: reference.cue, executor: reference.executor } });
  const event = { id: crypto.randomUUID(), kind: 'ma2' as const, ...(document.outputMode === 'timecode' ? {} : { runMode: 'independent' as const }), action: 'goto' as const, at: ms, label: reference.name, sequence: reference.sequence, cue: reference.cue, executor: reference.executor };
  const existing = track.clips.find(clip => clip.timeLock === 'time' && clip.start === 0 && !clip.muted);
  const clip = existing ? { ...existing, duration: Math.max(existing.duration, ms + 1), events: [...existing.events, event] }
    : { id: crypto.randomUUID(), name: reference.name, start: 0, duration: durationMs, timeLock: 'time' as const, muted: false, events: [event] };
  const updated = { ...track, clips: [...track.clips.filter(value => value.id !== existing?.id), clip] };
  const result = lightingDocumentSchema.parse({ ...document, version: 2, tracks: document.tracks.some(value => value.id === track.id)
    ? document.tracks.map(value => value.id === track.id ? updated : value) : [...document.tracks, updated] });
  assertMusicCueConflicts(result);
  return result;
}
