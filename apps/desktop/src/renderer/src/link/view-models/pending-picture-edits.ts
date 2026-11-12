import { compileRundownTimelineCues, type FrameRange } from '@tb/core/link';
import type { LinkCue, MtcFrameRate, ReferenceMediaClip, RundownItem, VisualLayer } from '@tb/schema';

/**
 * What of a song's picture OBS does not have yet. While 联动台播放 prepares, plays or pauses a song,
 * OBS follows the version its picture runs (the program's `pictureVersion`: the one the song started
 * with, or a newer one it took since, 0.5.9 R9). A picture edit made since goes to OBS by itself and is
 * used in this pass; until the picture took it, the editor marks it as on its way instead of on air.
 * Worked out again from both versions on every edit, never stored in the project.
 */
export type PendingPictureEdits = {
  /** Clips (`media:<id>`) and cues (`cue:<id>`) added or changed since, keyed like the timeline's airtime. */
  changed: ReadonlySet<string>;
  /** Parts that play in the version on air and that the project no longer has, so are not drawn: they still play. */
  removed: number;
};

export const NO_PENDING_PICTURE_EDITS: PendingPictureEdits = { changed: new Set(), removed: 0 };

/** A song as one version of the project has it, with the frames each of its clips and cameras plays there
 * (SceneOutputTimeline.airtime: clips on hidden tracks, switched-off cameras and clips the song audio already
 * plays have no entry). */
export type SongPicture = { item: RundownItem; frameRate: MtcFrameRate; airtime: ReadonlyMap<string, readonly FrameRange[]> };

/**
 * Compares, by id, only what reaches OBS (createObsProgramSnapshot) and plays there: the clips and cameras
 * with airtime, and the cues with OBS actions that the cue runner plays (switched on, on a shown track).
 * A part that plays in neither version has nothing to wait for, whatever was edited on it. The others count
 * as changed when they play in one version only, when their picture differs (a clip; the OBS actions of a cue
 * with its timing, track and switch), or when their track was shown, hidden or moved among the tracks both
 * versions have. Labels, names and notes only describe a part, and locks only guard editing; lighting is left
 * out. Parts that play in the version on air and are gone count as removed. `onAir` is the song in the version
 * on air, undefined when that version does not have it (then nothing of it is on air).
 */
export function pendingPictureEdits(onAir: SongPicture | undefined, current: SongPicture): PendingPictureEdits {
  const tracks = changedTracks(onAir?.item.visualLayers ?? [], current.item.visualLayers);
  const played = onAir ? playedParts(onAir) : new Set<string>(), plays = playedParts(current);
  const before = onAir ? parts(onAir.item) : new Map<string, Part>(), now = parts(current.item);
  const changed = new Set<string>();
  for (const [key, part] of now) {
    const was = played.has(key), is = plays.has(key);
    if (!was && !is) continue;
    if (was !== is || before.get(key)?.picture !== part.picture || (part.layerId !== undefined && tracks.has(part.layerId))) changed.add(key);
  }
  return { changed, removed: [...played].filter(key => !now.has(key)).length };
}

/** A clip or cue: its track, and its picture as OBS gets it (null for a cue without OBS actions). */
type Part = { layerId: string | undefined; picture: string | null };

/** Every clip and cue of a song by its airtime key. */
function parts(item: RundownItem): Map<string, Part> {
  return new Map([
    ...item.referenceMediaClips.map((clip): [string, Part] => [`media:${clip.id}`, { layerId: clip.layerId, picture: clipPicture(clip) }]),
    ...item.cues.map((cue): [string, Part] => [`cue:${cue.id}`, { layerId: cue.layerId, picture: cuePicture(cue) }])
  ]);
}

/** The parts of a song that play in OBS in its version: the clips and cameras with airtime, and the cues with
 * OBS actions that the cue runner plays (compileRundownTimelineCues, as the program's OBS session does). */
function playedParts(song: SongPicture): Set<string> {
  const played = new Set(song.airtime.keys());
  const runs = new Set(compileRundownTimelineCues(song.item, song.frameRate).map(entry => entry.cue.id));
  for (const cue of song.item.cues) if (runs.has(cue.id) && obsActions(cue).length) played.add(`cue:${cue.id}`);
  return played;
}

/** Tracks whose picture is not the one on air: shown or hidden since, or now above or below another
 * track both versions have where they were the other way round. */
function changedTracks(onAir: readonly VisualLayer[], current: readonly VisualLayer[]): Set<string> {
  const before = new Map(onAir.map(layer => [layer.id, layer]));
  const shared = current.filter(layer => before.has(layer.id)).map(layer => layer.id);
  const sharedIds = new Set(shared);
  const wasOrder = onAir.filter(layer => sharedIds.has(layer.id)).map(layer => layer.id);
  const changed = new Set(current.filter(layer => before.has(layer.id) && before.get(layer.id)?.visible !== layer.visible).map(layer => layer.id));
  for (const [index, id] of shared.entries()) {
    const above = new Set(shared.slice(0, index));
    const wasAbove = wasOrder.slice(0, wasOrder.indexOf(id));
    if (wasAbove.length !== above.size || wasAbove.some(other => !above.has(other))) changed.add(id);
  }
  return changed;
}

/** A clip as OBS gets it; its label only names it. */
function clipPicture(clip: ReferenceMediaClip): string {
  return canonical({ ...clip, label: '' });
}

/** A cue as OBS gets it: its OBS actions with its timing, track and switch; null for a cue without any. */
function cuePicture(cue: LinkCue): string | null {
  const actions = obsActions(cue);
  return actions.length ? canonical({ ...cue, name: '', notes: '', actions: actions.map(action => ({ ...action, label: '' })) }) : null;
}

function obsActions(cue: LinkCue): LinkCue['actions'] {
  return cue.actions.filter(action => action.kind.startsWith('obs.'));
}

/** The same text for equal values, whatever order their fields were written in. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)))
    : entry);
}
