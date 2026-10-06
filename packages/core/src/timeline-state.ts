import { audioContainsMediaSource } from './audio-edit';
import type {
  LinkAction,
  LinkCue,
  LinkMediaAsset,
  LinkProject,
  MtcFrameRate,
  ReferenceMediaClip,
  RundownItem,
  VisualLayer
} from '@tb/schema';
import {
  frameNumberToTimecode,
  millisecondsToFrameNumber,
  playbackFramesPerSecond,
  timecodeToFrameNumber,
  timecodeToMilliseconds
} from './mtc-timecode';

export type TimelineSpan = {
  startMs: number;
  endMs: number;
  startFrame: number;
  endFrame: number;
  durationMs: number;
};

export type ResolvedTimelineClip = TimelineSpan & {
  clip: ReferenceMediaClip;
  asset: LinkMediaAsset;
  layer: VisualLayer | null;
  layerIndex: number | null;
  active: boolean;
  visible: boolean;
  visual: boolean;
  audible: boolean;
};

export type VisualObsShowAction = Extract<LinkAction, { kind: 'obs.setSceneItemEnabled' }>;

export type ResolvedTimelineObsCue = TimelineSpan & {
  cue: LinkCue;
  showAction: VisualObsShowAction;
  layer: VisualLayer;
  layerIndex: number;
  active: boolean;
  visible: boolean;
};

export type ResolvedTimelineLayer = {
  layer: VisualLayer;
  layerIndex: number;
  activeVisualClips: ResolvedTimelineClip[];
  activeObsCues: ResolvedTimelineObsCue[];
};

export type ResolvedTimelineState = {
  itemId: string;
  playheadMs: number;
  clips: ResolvedTimelineClip[];
  visualObsCues: ResolvedTimelineObsCue[];
  layers: ResolvedTimelineLayer[];
  activeClipIds: string[];
  activeVisualClipIds: string[];
  activeAudioClipIds: string[];
  activeObsCueIds: string[];
};

export type ScheduledTimelineCue = {
  cue: LinkCue;
  scheduledFrame: number;
};

export function resolveTimelineState(
  project: LinkProject,
  item: RundownItem,
  playheadMs: number
): ResolvedTimelineState {
  if (!Number.isFinite(playheadMs) || playheadMs < 0) throw new Error('播放头时间必须是非负有限毫秒数');
  return new TimelineStateIndex(project, item).at(playheadMs);
}

/** Compile immutable document spans once; playback queries only resolve activity. */
export class TimelineStateIndex {
  private readonly clips: ResolvedTimelineClip[];
  private readonly visualObsCues: ResolvedTimelineObsCue[];
  private readonly clipOrder: number[];
  constructor(project: LinkProject, private readonly item: RundownItem) {
    const frameRate = project.timebase.frameRate;
    const assetById = new Map(project.mediaAssets.map((asset) => [asset.id, asset]));
    const layerById = new Map(item.visualLayers.map((layer, layerIndex) => [layer.id, { layer, layerIndex }]));
    const clips = item.referenceMediaClips.map((clip): ResolvedTimelineClip => {
      const asset = assetById.get(clip.assetId);
      if (!asset) throw new Error(`媒体素材不存在：${clip.assetId}`);
      const isVisualAsset = asset.kind === 'video' || asset.kind === 'image';
      if (isVisualAsset && item.visualLayers.length > 0 && !clip.layerId) {
        throw new Error(`视觉素材片段“${clip.label}”尚未分配视觉图层`);
      }
      const layerEntry = clip.layerId ? layerById.get(clip.layerId) : undefined;
      if (clip.layerId && !layerEntry) throw new Error(`素材片段“${clip.label}”引用不存在的图层：${clip.layerId}`);
      const span = resolveTimelineClipSpan(clip, frameRate);
      const active = true;
      const layerVisible = layerEntry?.layer.visible ?? true;
      const visible = active && layerVisible;
      return {
        ...span,
        clip,
        asset,
        layer: layerEntry?.layer ?? null,
        layerIndex: layerEntry?.layerIndex ?? null,
        active,
        visible,
        visual: active && layerVisible && isVisualAsset,
        audible: active && layerVisible && (asset.kind === 'audio' || (asset.kind === 'video' && clip.embeddedAudioEnabled !== false && !audioContainsMediaSource(item.referenceAudio, asset.id)))
      };
    });
    const visualObsCues = item.cues.flatMap((cue): ResolvedTimelineObsCue[] => {
      const showAction = findVisualObsShowAction(cue);
      if (!showAction) return [];
      if (!cue.layerId) throw new Error(`OBS 显示 Cue“${cue.name}”尚未分配视觉图层`);
      const layerEntry = layerById.get(cue.layerId);
      if (!layerEntry) throw new Error(`OBS 显示 Cue“${cue.name}”引用不存在的图层：${cue.layerId}`);
      const span = resolveTimelineCueSpan(cue, frameRate);
      const active = cue.enabled;
      return [{
        ...span,
        cue,
        showAction,
        layer: layerEntry.layer,
        layerIndex: layerEntry.layerIndex,
        active,
        visible: active && layerEntry.layer.visible
      }];
    });
    this.clips = clips;
    this.visualObsCues = visualObsCues;
    this.clipOrder = clips.map((_, index) => index).sort((left, right) =>
      (clips[left]!.layerIndex ?? Number.MAX_SAFE_INTEGER) - (clips[right]!.layerIndex ?? Number.MAX_SAFE_INTEGER));
  }
  at(playheadMs: number): ResolvedTimelineState {
    if (!Number.isFinite(playheadMs) || playheadMs < 0) throw new Error('播放头时间必须是非负有限毫秒数');
    const clips = this.clips.map(entry => {
      const active = isTimelineSpanActive(entry, playheadMs);
      return { ...entry, active, visible: active && entry.visible, visual: active && entry.visual, audible: active && entry.audible };
    });
    const visualObsCues = this.visualObsCues.map(entry => {
      const active = entry.active && isTimelineSpanActive(entry, playheadMs);
      return { ...entry, active, visible: active && entry.visible };
    });
    const layers = this.item.visualLayers.map((layer, layerIndex): ResolvedTimelineLayer => ({
      layer,
      layerIndex,
      activeVisualClips: clips.filter((entry) => entry.layer?.id === layer.id && entry.visual),
      activeObsCues: visualObsCues.filter((entry) => entry.layer.id === layer.id && entry.visible)
    }));
    const topFirstClips = this.clipOrder.map(index => clips[index]!);
    return {
      itemId: this.item.id,
      playheadMs,
      clips,
      visualObsCues,
      layers,
      activeClipIds: topFirstClips.filter((entry) => entry.visible).map((entry) => entry.clip.id),
      activeVisualClipIds: topFirstClips.filter((entry) => entry.visual).map((entry) => entry.clip.id),
      activeAudioClipIds: topFirstClips.filter((entry) => entry.audible).map((entry) => entry.clip.id),
      activeObsCueIds: visualObsCues.filter((entry) => entry.visible).map((entry) => entry.cue.id)
    };
  }
}

export function resolveTimelineClipSpan(clip: ReferenceMediaClip, frameRate: MtcFrameRate): TimelineSpan {
  return resolveTimelineSpan(clip.startTimecode, clip.durationMs, frameRate);
}

export function resolveTimelineCueSpan(cue: LinkCue, frameRate: MtcFrameRate): TimelineSpan {
  if (cue.durationMs === undefined) {
    throw new Error(`OBS 显示 Cue“${cue.name}”缺少 durationMs，无法解析结束时间`);
  }
  return resolveTimelineSpan(cue.timecode, cue.durationMs, frameRate);
}

export function resolveTimelineSpan(
  startTimecode: LinkCue['timecode'],
  durationMs: number,
  frameRate: MtcFrameRate
): TimelineSpan {
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('时间线片段时长必须为正数');
  const startFrame = timecodeToFrameNumber(startTimecode, frameRate);
  const startMs = timecodeToMilliseconds(startTimecode, frameRate);
  const durationFrames = Math.max(1, millisecondsToFrameNumber(durationMs, frameRate));
  const endFrame = startFrame + durationFrames;
  const endMs = frameToMilliseconds(endFrame, frameRate);
  return {
    startMs,
    endMs,
    startFrame,
    endFrame,
    durationMs: endMs - startMs
  };
}

export function isTimelineSpanActive(span: Pick<TimelineSpan, 'startMs' | 'endMs'>, playheadMs: number): boolean {
  return span.startMs <= playheadMs && playheadMs < span.endMs;
}

export function wasTimelineFrameCrossed(previousFrame: number, currentFrame: number, boundaryFrame: number): boolean {
  return previousFrame < boundaryFrame && boundaryFrame <= currentFrame;
}

export function findVisualObsShowAction(cue: LinkCue): VisualObsShowAction | null {
  const action = cue.actions.find((candidate) => candidate.kind === 'obs.setSceneItemEnabled' && candidate.enabled);
  return action?.kind === 'obs.setSceneItemEnabled' ? action : null;
}

export function compileScheduledTimelineCues(cues: readonly LinkCue[], frameRate: MtcFrameRate): ScheduledTimelineCue[] {
  return cues
    .filter((cue) => cue.enabled)
    .flatMap((cue, cueOrder): Array<ScheduledTimelineCue & { boundaryOrder: number; cueOrder: number }> => {
      const scheduledFrame = timecodeToFrameNumber(cue.timecode, frameRate);
      const showActions = cue.actions.filter((action): action is VisualObsShowAction => (
        action.kind === 'obs.setSceneItemEnabled' && action.enabled
      ));
      if (showActions.length === 0) return [{ cue, scheduledFrame, boundaryOrder: 1, cueOrder }];
      const span = resolveTimelineCueSpan(cue, frameRate);
      const endCue: LinkCue = {
        id: `${cue.id}:duration-end`,
        name: `结束 · ${cue.name}`,
        timecode: frameNumberToTimecode(span.endFrame, frameRate),
        enabled: true,
        notes: cue.notes,
        actions: showActions.map((action) => ({
          ...action,
          id: `${action.id}:duration-end`,
          label: `隐藏来源 · ${action.sourceName}`,
          enabled: false
        })),
        ...(cue.layerId ? { layerId: cue.layerId } : {})
      };
      return [
        { cue, scheduledFrame, boundaryOrder: 1, cueOrder },
        { cue: endCue, scheduledFrame: span.endFrame, boundaryOrder: 0, cueOrder }
      ];
    })
    .sort((left, right) => (
      left.scheduledFrame - right.scheduledFrame
      || left.boundaryOrder - right.boundaryOrder
      || left.cueOrder - right.cueOrder
    ))
    .map(({ cue, scheduledFrame }) => ({ cue, scheduledFrame }));
}

export function compileRundownTimelineCues(item: RundownItem, frameRate: MtcFrameRate): ScheduledTimelineCue[] {
  const layers = new Map(item.visualLayers.map((layer) => [layer.id, layer]));
  const runnableCues = item.cues.flatMap((cue): LinkCue[] => {
    if (!cue.enabled || !cue.layerId) return cue.enabled ? [cue] : [];
    const layer = layers.get(cue.layerId);
    if (!layer) throw new Error(`Cue“${cue.name}”引用不存在的图层：${cue.layerId}`);
    return layer.visible ? [cue] : [];
  });
  return compileScheduledTimelineCues(runnableCues, frameRate);
}

export function quantizeTimelineRange(
  startMs: number,
  durationMs: number,
  frameRate: MtcFrameRate,
  maximumEndMs?: number
): { startTimecode: LinkCue['timecode']; startMs: number; endMs: number; durationMs: number } {
  if (!Number.isFinite(startMs) || startMs < 0) throw new Error('片段开始时间必须是非负有限毫秒数');
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('片段时长必须为正数');
  const startFrame = millisecondsToFrameNumber(startMs, frameRate);
  const requestedEndFrame = millisecondsToFrameNumber(startMs + durationMs, frameRate);
  let endFrame = Math.max(startFrame + 1, requestedEndFrame);
  const startTimecode = frameNumberToTimecode(startFrame, frameRate);
  const quantizedStartMs = timecodeToMilliseconds(startTimecode, frameRate);
  if (maximumEndMs !== undefined) {
    if (!Number.isFinite(maximumEndMs) || maximumEndMs <= quantizedStartMs) throw new Error('素材剩余时长不足一帧');
    const maximumEndFrame = Math.floor(maximumEndMs / 1_000 * playbackFramesPerSecond(frameRate) + Number.EPSILON);
    endFrame = Math.min(endFrame, maximumEndFrame);
    if (endFrame <= startFrame) throw new Error('素材剩余时长不足一帧');
  }
  const endMs = frameToMilliseconds(endFrame, frameRate);
  return {
    startTimecode,
    startMs: quantizedStartMs,
    endMs,
    durationMs: Math.max(1, Math.round(endMs - quantizedStartMs))
  };
}

function frameToMilliseconds(frame: number, frameRate: MtcFrameRate): number {
  return frame / playbackFramesPerSecond(frameRate) * 1_000;
}
