import { LightingTempoMap, lightingEventTime } from '@tb/core/link';
import type { LightingDocument } from '@tb/schema';

export function cueEventEntries(document: LightingDocument) {
  const map = new LightingTempoMap(document.tempos);
  const leads = new Map<string, number>();
  for (const track of document.tracks) for (const clip of track.clips) for (const event of clip.events) {
    if (event.kind === 'ma2' && event.preparation) {
      const group = event.effectGroupId ?? event.id;
      leads.set(group, Math.max(leads.get(group) ?? 0, event.preparation.leadMs));
    }
  }
  return document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events.flatMap(event =>
    event.kind === 'ma2' && (!event.effectGroupId || event.effectGroupId === event.id)
      ? [{ track, clip, id: event.id, cue: event.cue ?? '—', executor: event.executor, label: event.label, preparationLeadMs: leads.get(event.effectGroupId ?? event.id) ?? 0, ms: lightingEventTime(clip, event, map) }] : []
  ))).sort((a, b) => a.ms - b.ms);
}
