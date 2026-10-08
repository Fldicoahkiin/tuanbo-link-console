import type {
  LinkMediaAsset,
  LinkProject,
  MtcFrameRate,
  ReferenceCanvasTransform,
  RundownItem
} from '@tb/schema';
import { frameNumberToTimecode } from './mtc-timecode';
import { audioContainsMediaSource } from './audio-edit';
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
  sceneName?: string | undefined;
  deferSceneSwitch?: boolean | undefined;
  assetId: string;
  assetName: string;
  assetKind: 'video' | 'image' | 'audio';
  relativePath: string;
  sourceOffsetMs: number;
  embeddedAudioEnabled: boolean;
  transform: ReferenceCanvasTransform;
};

export type ManagedMediaTimeline = {
  itemId: string;
  frameRate: MtcFrameRate;
  events: ManagedMediaEvent[];
};

export function compileManagedMediaTimeline(project: LinkProject, itemId: string): ManagedMediaTimeline {
  const item = requireItem(project, itemId);
  const assets = new Map(project.mediaAssets.map((asset) => [asset.id, asset]));
  const scenes = materialSceneTargets(project, itemId);
  const sceneByLayer = new Map(scenes.filter(target => target.layerId).map(target => [`${target.asset.id}:${target.layerId}`, target]));
  assertLayerIntervalsDoNotOverlap(item, assets, project.timebase.frameRate);
  const events = item.referenceMediaClips.flatMap((clip): ManagedMediaEvent[] => {
    const asset = requireAsset(assets, clip.assetId);
    if (asset.kind === 'audio' && project.obsOutputMode !== 'scenes') return [];
    if (asset.kind === 'audio' && audioContainsMediaSource(item.referenceAudio, asset.id)) return [];
    const scene = project.obsOutputMode === 'scenes' ? sceneByLayer.get(`${asset.id}:${clip.layerId}`) ?? materialSceneNames(project.projectId, asset) : null;
    if (!clip.layerId) throw new Error(`素材片段“${clip.label}”尚未分配视觉图层`);
    const layerIndex = item.visualLayers.findIndex((layer) => layer.id === clip.layerId);
    if (layerIndex < 0) throw new Error(`素材片段“${clip.label}”引用不存在的视觉图层`);
    if (!item.visualLayers[layerIndex]?.visible) return [];
    const span = resolveTimelineClipSpan(clip, project.timebase.frameRate);
    const base = {
      itemId,
      clipId: clip.id,
      layerId: clip.layerId,
      layerIndex,
      layerCount: item.visualLayers.length,
      sourceName: scene?.sourceName ?? managedMediaSourceName(project.projectId, clip.layerId, asset.kind),
      ...(scene ? { sceneName: scene.sceneName } : {}),
      assetId: asset.id,
      assetName: asset.name,
      assetKind: asset.kind,
      relativePath: asset.relativePath,
      sourceOffsetMs: clip.sourceOffsetMs ?? 0,
      embeddedAudioEnabled: asset.kind === 'audio' || asset.kind === 'video' && clip.embeddedAudioEnabled !== false
        && !(project.playbackSource === 'internal' && audioContainsMediaSource(item.referenceAudio, asset.id))
        && (project.playbackSource !== 'internal' || project.internalVideoAudio === true),
      transform: clip.canvasTransform
    } as const;
    return [
      { ...base, id: `managed-media:${clip.id}:start`, phase: 'start', frameNumber: span.startFrame },
      { ...base, id: `managed-media:${clip.id}:stop`, phase: 'stop', frameNumber: span.endFrame }
    ];
  });
  events.sort(compareManagedMediaEvents);
  return { itemId, frameRate: project.timebase.frameRate, events };
}

export function managedMediaSourceName(projectId: string, layerId: string, kind: 'video' | 'image' | 'audio'): string {
  return `${MANAGED_OBS_SOURCE_PREFIX}${stableNamePart(projectId)}·${stableNamePart(layerId)}·${kind}`;
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

function assertLayerIntervalsDoNotOverlap(
  item: RundownItem,
  assets: Map<string, LinkMediaAsset>,
  frameRate: MtcFrameRate
): void {
  const intervalsByLayer = new Map<string, Array<{ clipId: string; label: string; start: number; end: number }>>();
  for (const clip of item.referenceMediaClips) {
    const asset = requireAsset(assets, clip.assetId);
    if (asset.kind === 'audio') continue;
    if (!clip.layerId) throw new Error(`素材片段“${clip.label}”尚未分配视觉图层`);
    const span = resolveTimelineClipSpan(clip, frameRate);
    const start = span.startFrame;
    const end = span.endFrame;
    const intervals = intervalsByLayer.get(clip.layerId) ?? [];
    intervals.push({ clipId: clip.id, label: clip.label, start, end });
    intervalsByLayer.set(clip.layerId, intervals);
  }
  for (const intervals of intervalsByLayer.values()) {
    intervals.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let index = 1; index < intervals.length; index++) {
      const previous = intervals[index - 1]!, current = intervals[index]!;
      if (current.start < previous.end && previous.start < current.end) {
        throw new Error(`视觉图层存在重叠片段：“${previous.label}”与“${current.label}”`);
      }
    }
  }
}

function requireItem(project: LinkProject, itemId: string): RundownItem {
  const item = project.rundown.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`节目不存在：${itemId}`);
  return item;
}

function requireAsset(assets: Map<string, LinkMediaAsset>, assetId: string): LinkMediaAsset {
  const asset = assets.get(assetId);
  if (!asset) throw new Error(`媒体素材不存在：${assetId}`);
  return asset;
}

function stableNamePart(value: string): string {
  const readable = value.replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 27) || 'unknown';
  return `${readable}-${stableHash(value)}`;
}

function stableHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}
