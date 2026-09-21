import { LightingTempoMap, lightingEventTime } from '@tb/core/link';
import type { LightingDocument } from '@tb/schema';

export function cueEventEntries(document: LightingDocument) {
  const map = new LightingTempoMap(document.tempos);
  return document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events.flatMap(event =>
    event.kind === 'ma2' && (!event.effectGroupId || event.effectGroupId === event.id)
      ? [{ track, clip, id: event.id, cue: event.cue ?? '—', executor: event.executor, label: event.label, ms: lightingEventTime(clip, event, map) }] : []
  ))).sort((a, b) => a.ms - b.ms);
}
