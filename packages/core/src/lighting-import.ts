import { lightingDocumentSchema, type LightingDocument, type LightingTrack } from '@tb/schema';
import { LightingTempoMap, lightingClipInTime } from './lighting-edit';

/** Append reusable lighting data while retaining the destination programme's timing. */
export function appendLightingDocument(current: LightingDocument, incoming: LightingDocument): LightingDocument {
  const source = lightingDocumentSchema.parse(incoming);
  const destination = lightingDocumentSchema.parse(current);
  if (!destination.tracks.length) return structuredClone(source);
  const existingTargets = new Set(destination.ma2Bindings?.map((binding) => binding.timecode));
  if (source.ma2Bindings?.some((binding) => existingTargets.has(binding.timecode))) throw new Error('当前节目已绑定导入文件中的 MA2 Timecode，不能重复导入');
  const map = new LightingTempoMap(source.tempos);
  const remap = identityMap();
  const convertTrack = (track: LightingTrack, id: (sourceId: string) => string): LightingTrack => ({
    ...structuredClone(track), id: id(track.id), clips: track.clips.map((clip) => lightingClipInTime(clip, map, id))
  });
  const tracks = source.tracks.map((track) => convertTrack(track, remap));
  const bindings = source.ma2Bindings?.map((binding) => ({
    ...structuredClone(binding), id: remap(binding.id),
    baselineTracks: binding.baselineTracks.map((track) => convertTrack(track, remap)),
    mappings: binding.mappings.map((mapping) => ({ ...mapping, trackId: remap(mapping.trackId), clipId: remap(mapping.clipId), eventId: remap(mapping.eventId) }))
  }));
  return lightingDocumentSchema.parse({
    ...destination,
    tracks: [...destination.tracks, ...tracks],
    markers: [...destination.markers, ...source.markers.map((marker) => ({ ...marker, id: remap(marker.id) }))],
    templates: [...destination.templates, ...source.templates.map((template) => ({
      ...template, id: remap(template.id), track: convertTrack(template.track, identityMap())
    }))],
    ...(bindings?.length ? { ma2Bindings: [...destination.ma2Bindings ?? [], ...bindings] } : {})
  });
}

function identityMap(): (sourceId: string) => string {
  const ids = new Map<string, string>();
  return (sourceId) => {
    const existing = ids.get(sourceId);
    if (existing) return existing;
    const id = crypto.randomUUID(); ids.set(sourceId, id); return id;
  };
}
