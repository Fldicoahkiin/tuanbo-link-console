import { createLightingMusic, lightingDocumentSchema, type LightingDocument, type LightingTrack } from '@tb/schema';
import { LightingTempoMap, lightingClipInTime } from './lighting-edit';
import { musicMsToBeat } from './lighting-music';
import { lightingIdMap, remapEventGroup, remapMa2Binding, withNewLightingIds, type LightingIdMap } from './lighting-ids';

/** Append reusable lighting data while retaining the destination programme's timing. */
export function appendLightingDocument(current: LightingDocument, incoming: LightingDocument): LightingDocument {
  const source = lightingDocumentSchema.parse(incoming);
  const destination = lightingDocumentSchema.parse(current);
  // An exported lighting file from before 0.5.9 may carry the beats of the song it came from; this song keeps its own (`rundownItem.music`).
  // Lighting taken from another song gets ids of its own, as a duplicated song's does (lighting-ids.ts).
  if (!destination.tracks.length) { const copy = withNewLightingIds(source); delete copy.musicAnalysis; return copy; }
  const existingTargets = new Set(destination.ma2Bindings?.map((binding) => binding.timecode));
  if (source.ma2Bindings?.some((binding) => existingTargets.has(binding.timecode))) throw new Error('当前节目已绑定导入文件中的 MA2 Timecode，不能重复导入');
  const map = new LightingTempoMap(source.tempos);
  const remap = lightingIdMap();
  const templateIds = new Set(source.templates.map(template => template.id));
  const convertTrack = (track: LightingTrack, id: LightingIdMap): LightingTrack => ({
    ...structuredClone(track), id: id(track.id), clips: track.clips.map((clip) => {
      const converted = lightingClipInTime(clip, map, id);
      return { ...converted, events: converted.events.map(event => {
        const next = remapEventGroup({ ...event }, id);
        if (next.librarySource) {
          if (templateIds.has(next.librarySource.id)) next.librarySource = { ...next.librarySource, id: remap(next.librarySource.id) };
          else delete next.librarySource;
        }
        if (next.beatAnchor !== undefined || clip.timeLock === 'beat') next.beatAnchor = musicMsToBeat(destination, converted.start + next.at);
        return next;
      }) };
    })
  });
  const tracks = source.tracks.map((track) => convertTrack(track, remap));
  const bindings = source.ma2Bindings?.map((binding) => remapMa2Binding(binding, remap, (track) => convertTrack(track, remap)));
  return lightingDocumentSchema.parse({
    ...destination,
    version: source.version === 2 || destination.version === 2 || source.tracks.some(track => track.clips.some(clip => clip.timeLock === 'beat')) ? 2 : destination.version,
    ...(source.music?.sections.length ? { music: { ...destination.music ?? createLightingMusic(), sections: [...destination.music?.sections ?? [], ...source.music.sections.map(section => ({ ...section, id: remap(section.id) }))] } } : {}),
    tracks: [...destination.tracks, ...tracks],
    markers: [...destination.markers, ...source.markers.map((marker) => ({ ...marker, id: remap(marker.id) }))],
    templates: [...destination.templates, ...source.templates.map((template) => ({
      ...template, id: remap(template.id), track: convertTrack(template.track, lightingIdMap())
    }))],
    ...(bindings?.length ? { ma2Bindings: [...destination.ma2Bindings ?? [], ...bindings] } : {})
  });
}
