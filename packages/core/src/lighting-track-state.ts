import type { LightingDocument, LightingTrack } from '@tb/schema';

/** The editor, both sync paths and read-back use the same track enablement rule. */
export function lightingTrackEnabled(document: Pick<LightingDocument, 'tracks'>, track: LightingTrack): boolean {
  return !track.muted && (!document.tracks.some(value => value.solo) || track.solo);
}
