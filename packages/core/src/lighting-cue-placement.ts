import { lightingDocumentSchema, lightingTrackSchema, type LightingDocument } from '@tb/schema';
import { lightingEventTime, LightingTempoMap } from './lighting-edit';
import { firstTimecodeTrack } from './ma2-track-routing';
import { lightingTrackEnabled } from './lighting-track-state';
import { assertMusicCueConflicts } from './lighting-music';

/** A pool Cue can reuse the lane placed for its Sequence, including after automatic assignment. */
export function materialCueTrack(document: LightingDocument, reference: { sequence: number; executor: string }) {
  const lanes = document.tracks.filter(track => track.kind === 'ma2' && track.group === 'effect-canvas' && !track.locked && !track.muted && track.cueStamp?.mode === 'fixed');
  if (reference.executor) return lanes.find(track => track.cueStamp?.mode === 'fixed' && track.cueStamp.executor === reference.executor);
  const matching = lanes.filter(track => track.cueStamp?.mode === 'fixed' && track.cueStamp.sequence === reference.sequence);
  return matching.find(track => track.cueStamp?.mode === 'fixed' && !track.cueStamp.executor) ?? (matching.length === 1 ? matching[0] : undefined);
}

/** Place a console reference without creating a library entry or changing existing timing. */
export function placeConsoleCue(document: LightingDocument, reference: { sequence: number; cue: string; executor: string; name: string; valueEdits?: import('@tb/schema').Ma2CueValueEdit[] | undefined; attributes?: string[] | undefined; includeTracking?: boolean | undefined }, ms: number, durationMs: number): LightingDocument {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isFinite(ms) || ms < 0 || ms >= durationMs) throw new Error('Cue 超出歌曲范围');
  const track = materialCueTrack(document, reference)
    ?? lightingTrackSchema.parse({ id: crypto.randomUUID(), name: '灯光', kind: 'ma2', color: '#68c9ed', group: 'effect-canvas', muted: false, solo: false, locked: false,
      channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [], cueStamp: { mode: 'fixed', sequence: reference.sequence, cue: reference.cue, executor: reference.executor } });
  const event = { id: crypto.randomUUID(), ...(reference.valueEdits && { valueEdits: reference.valueEdits }), ...(reference.attributes && { attributes: reference.attributes }), ...(reference.includeTracking !== undefined && { includeTracking: reference.includeTracking }), kind: 'ma2' as const, action: 'goto' as const, at: ms, label: reference.name, sequence: reference.sequence, cue: reference.cue, executor: track.cueStamp?.mode === 'fixed' ? track.cueStamp.executor : reference.executor };
  const binding = document.ma2Bindings?.length === 1 ? document.ma2Bindings[0] : undefined;
  const primary = binding && firstTimecodeTrack(binding)?.trackId;
  const tempo = new LightingTempoMap(document.tempos);
  for (const lane of document.tracks) {
    if (lane.id !== track.id && lane.id !== primary || !lightingTrackEnabled(document, lane)) continue;
    for (const clip of lane.clips) for (const placed of clip.events) {
      if (clip.muted || placed.kind !== 'ma2' || placed.action !== 'goto' || placed.effectGroupId || lightingEventTime(clip, placed, tempo) !== ms) continue;
      const single = placed.sourceIngredients ? placed.sourceIngredients.length === 1 && placed.sourceIngredients[0] : placed;
      if (single && single.sequence === reference.sequence && Number(single.cue) === Number(reference.cue)
        && JSON.stringify(single.valueEdits) === JSON.stringify(reference.valueEdits) && JSON.stringify(single.attributes) === JSON.stringify(reference.attributes) && single.includeTracking === reference.includeTracking && (!reference.executor || single.executor === reference.executor)) return document;
    }
  }
  const existing = track.clips.find(clip => clip.timeLock === 'time' && clip.start === 0 && !clip.muted);
  const clip = existing ? { ...existing, duration: Math.max(existing.duration, ms + 1), events: [...existing.events, event] }
    : { id: crypto.randomUUID(), name: reference.name, start: 0, duration: durationMs, timeLock: 'time' as const, muted: false, events: [event] };
  const updated = { ...track, clips: [...track.clips.filter(value => value.id !== existing?.id), clip] };
  const result = lightingDocumentSchema.parse({ ...document, version: 2, tracks: document.tracks.some(value => value.id === track.id)
    ? document.tracks.map(value => value.id === track.id ? updated : value) : [...document.tracks, updated] });
  assertMusicCueConflicts(result, new Set([event.id]));
  return result;
}

/** Place a verified sequence as one document edit. Each native Cue keeps its own time. */
export function placeTimedConsoleCues(document: LightingDocument, steps: ReadonlyArray<Parameters<typeof placeConsoleCue>[1] & { delayMs: number }>, startMs: number, durationMs: number) {
  return steps.reduce((result, step) => placeConsoleCue(result, step, startMs + step.delayMs, durationMs), document);
}
