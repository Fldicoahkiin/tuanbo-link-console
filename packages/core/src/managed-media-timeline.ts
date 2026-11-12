import type {
  LinkMediaAsset,
  LinkProject,
  MtcFrameRate,
  ReferenceCanvasTransform,
  RundownItem
} from '@tb/schema';
import { frameNumberToTimecode, millisecondsToFrameNumber } from './mtc-timecode';
import { audioContainsMediaSource } from './audio-edit';
import { clipObsTransform } from './media-obs-transform';
import { resolveTimelineClipSpan, wasTimelineFrameCrossed } from './timeline-state';

export const MANAGED_OBS_SCENE_NAME = '团播联动台输出';
export const MANAGED_OBS_SOURCE_PREFIX = '团播联动台·';

export type ManagedMediaEvent = {
  id: string;
  phase: 'start' | 'stop';
  frameNumber: number;
  itemId: string;
  clipId: string;
  layerId: string;
  layerIndex: number;
  layerCount: number;
  sourceName: string;
  sceneName: string;
  deferSceneSwitch?: boolean | undefined;
  assetId: string;
  assetName: string;
  assetKind: 'video' | 'image' | 'audio';
  relativePath: string;
  sourceOffsetMs: number;
  embeddedAudioEnabled: boolean;
  /** The clip's look in OBS, set on the decoder's scene item before it goes on air; undefined leaves OBS's look as it
   * is (`media-obs-transform.ts`). */
  transform?: ReferenceCanvasTransform | undefined;
};

export type ManagedMediaTimeline = {
  itemId: string;
  frameRate: MtcFrameRate;
  events: ManagedMediaEvent[];
};

/** A clip the output cannot play, and why, in the words the preflight check shows. */
export type RefusedMediaClip = { clipId: string; reason: string };

/** The playback timeline: refuses the song when any clip cannot be played (preflight
 * reports the reason as a blocking check; playback never starts with it). */
export function compileManagedMediaTimeline(project: LinkProject, itemId: string): ManagedMediaTimeline {
  const { refused, ...timeline } = collectManagedMediaTimeline(project, itemId);
  const first = refused[0];
  if (first) throw new Error(first.reason);
  return timeline;
}

/** The one media timeline compiler. The clips the output can play become events; the
 * ones it cannot are listed in `refused` instead of failing the song, for a reader (the
 * editor) that must still show a project the schema accepts while preflight blocks it. */
export function collectManagedMediaTimeline(project: LinkProject, itemId: string): ManagedMediaTimeline & { refused: RefusedMediaClip[] } {
  const item = requireItem(project, itemId);
  const assets = new Map(project.mediaAssets.map((asset) => [asset.id, asset]));
  const scenes = materialSceneTargets(project, itemId);
  const sceneByLayer = new Map(scenes.filter(target => target.layerId).map(target => [`${target.asset.id}:${target.layerId}`, target]));
  const refused: RefusedMediaClip[] = [];
  const refuse = (clipId: string, reason: string): [] => { refused.push({ clipId, reason }); return []; };
  const events = item.referenceMediaClips.flatMap((clip): ManagedMediaEvent[] => {
    const asset = assets.get(clip.assetId);
    if (!asset) return refuse(clip.id, `媒体素材不存在：${clip.assetId}`);
    if (asset.kind === 'audio' && audioContainsMediaSource(item.referenceAudio, asset.id)) return [];
    const scene = sceneByLayer.get(`${asset.id}:${clip.layerId}`) ?? materialSceneNames(project.projectId, asset);
    if (!clip.layerId) return refuse(clip.id, `素材片段“${clip.label}”还没分配视觉图层`);
    const layerIndex = item.visualLayers.findIndex((layer) => layer.id === clip.layerId);
    if (layerIndex < 0) return refuse(clip.id, `素材片段“${clip.label}”引用不存在的视觉图层`);
    if (!item.visualLayers[layerIndex]?.visible) return [];
    const span = resolveTimelineClipSpan(clip, project.timebase.frameRate);
    const base = {
      itemId,
      clipId: clip.id,
      layerId: clip.layerId,
      layerIndex,
      layerCount: item.visualLayers.length,
      sourceName: scene.sourceName,
      sceneName: scene.sceneName,
      assetId: asset.id,
      assetName: asset.name,
      assetKind: asset.kind,
      relativePath: asset.relativePath,
      sourceOffsetMs: clip.sourceOffsetMs ?? 0,
      embeddedAudioEnabled: asset.kind === 'audio' || asset.kind === 'video' && clip.embeddedAudioEnabled !== false
        && !(project.playbackSource === 'internal' && audioContainsMediaSource(item.referenceAudio, asset.id))
        && (project.playbackSource !== 'internal' || project.internalVideoAudio === true),
      transform: asset.kind === 'audio' ? undefined : clipObsTransform(clip)
    } as const;
    return [
      { ...base, id: `managed-media:${clip.id}:start`, phase: 'start', frameNumber: span.startFrame },
      { ...base, id: `managed-media:${clip.id}:stop`, phase: 'stop', frameNumber: span.endFrame }
    ];
  });
  events.sort(compareManagedMediaEvents);
  return { itemId, frameRate: project.timebase.frameRate, events, refused };
}

export function materialSceneNames(projectId: string, asset: Pick<LinkMediaAsset, 'id' | 'name'>): { sceneName: string; sourceName: string } {
  const sceneName = `${MANAGED_OBS_SOURCE_PREFIX}素材·${asset.name.slice(0, 48)}·${stableHash(`${projectId}:${asset.id}`)}`;
  return { sceneName, sourceName: `${sceneName}·来源` };
}

/** Separate decoders for the same asset on different tracks; sequential clips
 * on one track retain the existing two-slot preloader and source presentation. */
export function materialSceneTargets(project: LinkProject, itemId?: string): Array<{ asset: LinkMediaAsset; sceneName: string; sourceName: string; layerId?: string }> {
  const result: ReturnType<typeof materialSceneTargets> = project.mediaAssets.map(asset => ({ asset, ...materialSceneNames(project.projectId, asset) }));
  const assets = new Map(project.mediaAssets.map(asset => [asset.id, asset]));
  for (const item of project.rundown) {
    if (itemId && item.id !== itemId) continue;
    const firstLayer = new Map<string, string>();
    const seen = new Set<string>();
    for (const clip of item.referenceMediaClips) {
      if (!clip.layerId) continue;
      const asset = assets.get(clip.assetId);
      if (!asset) continue;
      if (!firstLayer.has(asset.id)) firstLayer.set(asset.id, clip.layerId);
      if (firstLayer.get(asset.id) === clip.layerId) continue;
      const key = `${asset.id}:${clip.layerId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const base = materialSceneNames(project.projectId, asset);
      const sceneName = `${base.sceneName}·轨道·${stableHash(`${item.id}:${clip.layerId}`)}`;
      result.push({ asset, layerId: clip.layerId, sceneName, sourceName: `${sceneName}·来源` });
    }
  }
  return result;
}

/** The clip of this song an OBS source of ours shows, for an edit of that source on the live canvas (E16): the
 * material's decoder or its standby copy. Null for any other source (the user's own, and ours that are not a
 * material's picture), which the live canvas edits in OBS as before. Among several clips of the material on that track
 * the selected one; with none selected the edit is refused, since each clip keeps its own look. */
export function clipOfMaterialSource(project: LinkProject, itemId: string, sourceName: string, selectedClipId: string | null, playheadMs: number | null = null): string | null {
  const decoder = sourceName.endsWith('·预备') ? sourceName.slice(0, -'·预备'.length) : sourceName;
  if (!decoder.startsWith(`${MANAGED_OBS_SOURCE_PREFIX}素材·`) || !decoder.endsWith('·来源')) return null;
  const events = collectManagedMediaTimeline(project, itemId).events;
  const ends = new Map(events.filter(event => event.phase === 'stop').map(event => [event.clipId, event.frameNumber]));
  const starts = events.filter(event => event.phase === 'start' && event.sourceName === decoder && event.assetKind !== 'audio');
  const clips = [...new Set(starts.map(event => event.clipId))];
  if (!clips.length) throw new Error('这个素材不在当前这首歌里，没有记下它的位置。请在这首歌的时间线上调整');
  // The live canvas shows the clip under the editor's playhead; then the selected one; then the only one.
  const frame = playheadMs === null ? null : millisecondsToFrameNumber(playheadMs, project.timebase.frameRate);
  const underPlayhead = frame === null ? undefined : starts.find(event => event.frameNumber <= frame && frame < (ends.get(event.clipId) ?? Infinity))?.clipId;
  const chosen = underPlayhead ?? (selectedClipId && clips.includes(selectedClipId) ? selectedClipId : clips.length === 1 ? clips[0]! : null);
  if (!chosen) throw new Error('这个素材在这首歌里有好几段，每段的位置各记各的。请先在时间线上选中要改的那一段，再拖');
  const item = requireItem(project, itemId), clip = item.referenceMediaClips.find(candidate => candidate.id === chosen);
  const layer = clip?.layerId ? item.visualLayers.find(candidate => candidate.id === clip.layerId) : undefined;
  if (layer?.locked) throw new Error(lockedLayerMessage(layer));
  return chosen;
}

/** What a change to a clip on a locked track is refused with: the inspector, the stage and the live canvas say the same. */
export function lockedLayerMessage(layer: { name: string }): string { return `图层“${layer.name}”已锁定。`; }

export function managedMediaEventTimecode(event: ManagedMediaEvent, frameRate: MtcFrameRate) {
  return frameNumberToTimecode(event.frameNumber, frameRate);
}

export function collectCrossedManagedMediaEvents(
  events: readonly ManagedMediaEvent[],
  previousFrame: number,
  currentFrame: number,
  executedEventIds: ReadonlySet<string>
): ManagedMediaEvent[] {
  if (currentFrame < previousFrame) return [];
  return events.filter((event) => (
    !executedEventIds.has(event.id)
    && wasTimelineFrameCrossed(previousFrame, currentFrame, event.frameNumber)
  ));
}

function compareManagedMediaEvents(left: ManagedMediaEvent, right: ManagedMediaEvent): number {
  if (left.frameNumber !== right.frameNumber) return left.frameNumber - right.frameNumber;
  if (left.phase !== right.phase) return left.phase === 'stop' ? -1 : 1;
  return left.id.localeCompare(right.id);
}

function requireItem(project: LinkProject, itemId: string): RundownItem {
  const item = project.rundown.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`节目不存在：${itemId}`);
  return item;
}

function stableHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}
