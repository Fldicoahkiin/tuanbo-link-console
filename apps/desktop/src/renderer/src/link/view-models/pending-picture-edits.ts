import type { LinkCue, ReferenceMediaClip, RundownItem, VisualLayer } from '@tb/schema';

/**
 * What of a song's picture OBS does not have yet. While 联动台播放 prepares, plays or pauses a song,
 * OBS follows the project as it was when playback started (LinkApp keeps that version until 停止);
 * picture edits made since take effect only when the song is stopped and played again. Until the user
 * decides when they should take effect (0.6.0), the editor says so instead of marking them on air.
 * Worked out again from both versions on every edit, never stored in the project.
 */
export type PendingPictureEdits = {
  /** Clips (`media:<id>`) and cues (`cue:<id>`) added or changed since, keyed like the timeline's airtime. */
  changed: ReadonlySet<string>;
  /** Clips and picture cues of the version on air that the project no longer has, so are not drawn. */
  removed: number;
};

export const NO_PENDING_PICTURE_EDITS: PendingPictureEdits = { changed: new Set(), removed: 0 };

/**
 * Compares, by id, only what reaches OBS (createObsProgramSnapshot): every clip, the OBS actions of
 * each cue with its timing, track and switch, and whether each track is shown and where it sits among
 * the tracks both versions have. Labels, names and notes only describe a part, and locks only guard
 * editing; cues without OBS actions and lighting are left out. Every part on a track shown, hidden or
 * moved since counts as changed. `onAir` is the song in the version on air, undefined when that version
 * does not have it (then nothing of it is on air).
 */
export function pendingPictureEdits(onAir: RundownItem | undefined, current: RundownItem): PendingPictureEdits {
  const tracks = changedTracks(onAir?.visualLayers ?? [], current.visualLayers);
  const onChangedTrack = (layerId: string | undefined): boolean => layerId !== undefined && tracks.has(layerId);
  const clipsOnAir = new Map((onAir?.referenceMediaClips ?? []).map(clip => [clip.id, clipPicture(clip)]));
  const cuesOnAir = new Map((onAir?.cues ?? []).flatMap((cue): [string, string][] => {
    const picture = cuePicture(cue);
    return picture === null ? [] : [[cue.id, picture]];
  }));
  const changed = new Set<string>();
  for (const clip of current.referenceMediaClips) {
    if (clipsOnAir.get(clip.id) !== clipPicture(clip) || onChangedTrack(clip.layerId)) changed.add(`media:${clip.id}`);
  }
  for (const cue of current.cues) {
    const picture = cuePicture(cue), was = cuesOnAir.get(cue.id);
    // A cue that never drove OBS has no picture to wait for.
    if (picture === null && was === undefined) continue;
    if (picture !== was || onChangedTrack(cue.layerId)) changed.add(`cue:${cue.id}`);
  }
  const clips = new Set(current.referenceMediaClips.map(clip => clip.id));
  const cues = new Set(current.cues.map(cue => cue.id));
  const removed = [...clipsOnAir.keys()].filter(id => !clips.has(id)).length + [...cuesOnAir.keys()].filter(id => !cues.has(id)).length;
  return { changed, removed };
}

/** The note above the timeline on edits OBS does not have yet: what happened and what to do, then why
 * and which button; null when there are none. */
export function pendingPictureNotice(edits: PendingPictureEdits): { text: string; detail: string } | null {
  const changed = edits.changed.size, removed = edits.removed;
  if (!changed && !removed) return null;
  const counts = [changed ? `改了 ${changed} 处` : '', removed ? `删了 ${removed} 处` : ''].filter(Boolean).join('、');
  return { text: `播放中${counts}，停下重播才生效`,
    detail: `OBS 还在按开始播放时的时间线播${removed ? `，删掉的 ${removed} 处也照常播出` : ''}。点“停止”后重新播放，才会用上改过的时间线。` };
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
  const actions = cue.actions.filter(action => action.kind.startsWith('obs.'));
  return actions.length ? canonical({ ...cue, name: '', notes: '', actions: actions.map(action => ({ ...action, label: '' })) }) : null;
}

/** The same text for equal values, whatever order their fields were written in. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)))
    : entry);
}
