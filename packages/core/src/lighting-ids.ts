import type { LightingDocument, LightingEvent, LightingTrack } from '@tb/schema';

type Ma2Binding = NonNullable<LightingDocument['ma2Bindings']>[number];
type ConsoleSong = NonNullable<LightingDocument['consoleSong']>;

/** Gives the new id of a source id. */
export type LightingIdMap = (sourceId: string) => string;

/** One new id per source id, the same one each time it is asked again, so references between objects stay together. */
export function lightingIdMap(createId: () => string = () => crypto.randomUUID()): LightingIdMap {
  const ids = new Map<string, string>();
  return (sourceId) => {
    const existing = ids.get(sourceId);
    if (existing) return existing;
    const id = createId(); ids.set(sourceId, id); return id;
  };
}

/** An event's effect group goes through the same map as the event ids, so the group keeps its lead event. */
export function remapEventGroup<Event extends LightingEvent>(event: Event, id: LightingIdMap): Event {
  return event.effectGroupId ? { ...event, effectGroupId: id(event.effectGroupId) } : event;
}

/**
 * A console binding with its own id and every reference into its baseline through `id`. `track` gives the
 * baseline tracks the same treatment as the song's own tracks, so the baseline still compares equal to them.
 */
export function remapMa2Binding(binding: Ma2Binding, id: LightingIdMap, track: (track: LightingTrack) => LightingTrack): Ma2Binding {
  return {
    ...structuredClone(binding), id: id(binding.id),
    baselineTracks: binding.baselineTracks.map(track),
    ...(binding.trackMappings ? { trackMappings: binding.trackMappings.map(mapping => ({ ...mapping, trackId: id(mapping.trackId) })) } : {}),
    ...(binding.pendingTracks ? { pendingTracks: binding.pendingTracks.map(entry => ({ ...entry, trackId: id(entry.trackId) })) } : {}),
    mappings: binding.mappings.map(mapping => ({ ...mapping, trackId: id(mapping.trackId), clipId: id(mapping.clipId), eventId: id(mapping.eventId) }))
  };
}

/**
 * The same lighting with a new id for every object the song owns: tracks, clips, events and their effect
 * groups, markers, music sections, console bindings and the song's own console points. Nothing moves in time,
 * and whatever the console compares (Timecode number, MTC start, Cues, times) stays the same, so a copy is
 * exactly as in step with the console as its source. Templates and `librarySource` keep their ids: they name
 * entries of the project's shared material library, not objects of this song.
 */
export function withNewLightingIds(document: LightingDocument, id: LightingIdMap = lightingIdMap()): LightingDocument {
  const track = (source: LightingTrack): LightingTrack => ({
    ...structuredClone(source), id: id(source.id),
    clips: source.clips.map(clip => ({ ...structuredClone(clip), id: id(clip.id), events: clip.events.map(event => remapEventGroup({ ...structuredClone(event), id: id(event.id) }, id)) }))
  });
  const copy = structuredClone(document);
  return {
    ...copy,
    tracks: document.tracks.map(track),
    markers: copy.markers.map(marker => ({ ...marker, id: id(marker.id) })),
    ...(copy.music ? { music: { ...copy.music, sections: copy.music.sections.map(section => ({ ...section, id: id(section.id) })) } } : {}),
    ...(document.ma2Bindings ? { ma2Bindings: document.ma2Bindings.map(binding => remapMa2Binding(binding, id, track)) } : {}),
    ...(copy.consoleSong ? { consoleSong: remapConsoleSong(copy.consoleSong, id) } : {})
  };
}

/** The song's console points are named after their event (or its effect group), the same ids the tracks use. */
function remapConsoleSong(song: ConsoleSong, id: LightingIdMap): ConsoleSong {
  return { ...song, points: song.points.map(point => ({ ...point, id: id(point.id) })) };
}
