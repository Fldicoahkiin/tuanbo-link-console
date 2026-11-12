import { createEmptyLinkProject, parseLinkProject, requiredSchemaVersion, type LinkProject, type ObsProgramSnapshot } from '@tb/schema';
import { resolveTimelineClipSpan } from './timeline-state';

/** Runtime data only: original console XML and unrelated programs stay in the
 * document. This snapshot is never used to replace or save the user's project. */
export function createObsProgramSnapshot(project: LinkProject, itemId: string, revision: number): ObsProgramSnapshot {
  // Either playback source: the picture follows the internal player or P1's timecode the same way (0.5.9, P1 picture).
  const item = project.rundown.find(entry => entry.id === itemId);
  if (!item) throw new Error('画面节目不存在');
  const ids = new Set(item.referenceMediaClips.map(clip => clip.assetId));
  return { version: 1, projectId: project.projectId, revision, frameRate: project.timebase.frameRate,
    outputCanvas: project.outputCanvas, internalVideoAudio: project.internalVideoAudio ?? false,
    item: { id: item.id, title: item.title, enabled: item.enabled, notes: item.notes,
      ...(item.referenceAudio ? { referenceAudio: item.referenceAudio } : {}),
      visualLayers: item.visualLayers, referenceMediaClips: item.referenceMediaClips,
      cues: item.cues.flatMap(cue => {
        const actions = cue.actions.filter(action => action.kind.startsWith('obs.'));
        return actions.length ? [{ ...cue, actions }] : [];
      }) },
    assets: project.mediaAssets.filter(asset => ids.has(asset.id)).map(asset => ({ ...asset, folderId: null })) };
}

/** Picture work: an enabled cue drives OBS or the song places media in OBS. Such a song waits for its
 * picture to be prepared before it starts, and plays without it when that fails (`programStart`). */
export function itemNeedsObs(project: LinkProject, itemId: string): boolean {
  const item = project.rundown.find(entry => entry.id === itemId);
  return Boolean(item && (item.referenceMediaClips.length > 0
    || item.cues.some(cue => cue.enabled && cue.actions.some(action => action.kind.startsWith('obs.')))));
}

/** The picture's own project: only this song. Its file version is the one this song needs (`requiredSchemaVersion`),
 * so a song only a newer version keeps (a clip's look sent to OBS, a blank after the music) is read as it is. */
export function projectFromObsSnapshot(snapshot: ObsProgramSnapshot): LinkProject {
  return parseLinkProject({ ...createEmptyLinkProject(snapshot.item.title), projectId: snapshot.projectId,
    schemaVersion: requiredSchemaVersion({ rundown: [snapshot.item] }),
    playbackSource: 'internal', internalVideoAudio: snapshot.internalVideoAudio,
    outputCanvas: snapshot.outputCanvas, timebase: { frameRate: snapshot.frameRate, mode: 'per-item-reset' },
    rundown: [snapshot.item], mediaAssets: snapshot.assets });
}

/** Every upcoming video can be entered between frames: device observations
 * arrive after a clip boundary and camera overlays can reveal it midway.
 * A zero source trim therefore does not prove that decoding from zero is enough. */
export function preciseSeekAssetIds(snapshot: ObsProgramSnapshot, positionMs: number): ReadonlySet<string> {
  if (!Number.isFinite(positionMs) || positionMs < 0) throw new Error('素材准备的音频位置无效');
  const ids = new Set<string>();
  for (const clip of snapshot.item.referenceMediaClips) {
    const span = resolveTimelineClipSpan(clip, snapshot.frameRate);
    if (span.endMs <= positionMs) continue;
    ids.add(clip.assetId);
  }
  return ids;
}
