import { audioContainsMediaSource } from './audio-edit';
import { SceneOutputTimeline } from './scene-output-timeline';
import { collectManagedMediaTimeline } from './managed-media-timeline';
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
  /** In the picture: seen at the playhead. */
  visual: boolean;
  /** Under a camera at the playhead: on the timeline but not seen; the output keeps its decoder running for the reveal. */
  covered: boolean;
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

/** Compile immutable document spans once; playback queries only resolve activity.
 * What is in the picture (which clips are seen, which "show source" cues are open)
 * comes from `SceneOutputTimeline.pictureAt`, the output's own rule: a clip under
 * a camera is on the timeline (`active`) but not seen (`visual` false, `covered`). */
export class TimelineStateIndex {
  private readonly clips: ResolvedTimelineClip[];
  private readonly visualObsCues: ResolvedTimelineObsCue[];
  private readonly clipOrder: number[];
  private readonly output: SceneOutputTimeline;
  private readonly outsideOutput: ReadonlySet<string>;
  private readonly frameRate: MtcFrameRate;
  private readonly boundaries: number[];
  private last: { stretch: number; state: ResolvedTimelineState } | null = null;
  constructor(project: LinkProject, private readonly item: RundownItem) {
    const frameRate = project.timebase.frameRate;
    this.frameRate = frameRate;
    const assetById = new Map(project.mediaAssets.map((asset) => [asset.id, asset]));
    const layerById = new Map(item.visualLayers.map((layer, layerIndex) => [layer.id, { layer, layerIndex }]));
    const clips = item.referenceMediaClips.map((clip): ResolvedTimelineClip => {
      const asset = assetById.get(clip.assetId);
      if (!asset) throw new Error(`媒体素材不存在：${clip.assetId}`);
      const isVisualAsset = asset.kind === 'video' || asset.kind === 'image';
      if (isVisualAsset && item.visualLayers.length > 0 && !clip.layerId) {
        throw new Error(`视觉素材片段“${clip.label}”还没分配视觉图层`);
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
        covered: false,
        audible: active && layerVisible && (asset.kind === 'audio' || (asset.kind === 'video' && clip.embeddedAudioEnabled !== false && !audioContainsMediaSource(item.referenceAudio, asset.id)))
      };
    });
    const visualObsCues = item.cues.flatMap((cue): ResolvedTimelineObsCue[] => {
      const showAction = findVisualObsShowAction(cue);
      if (!showAction) return [];
      // The schema lets a song with no tracks hold a show cue on none. It has no track to be drawn on,
      // so the editor leaves it out of the state; the output skips it too (no track, no show).
      if (!cue.layerId && item.visualLayers.length === 0) return [];
      if (!cue.layerId) throw new Error(`OBS 显示 Cue“${cue.name}”还没分配视觉图层`);
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
    // The item may be an edited copy that is not in the project yet.
    const scoped = project.rundown.includes(item) ? project
      : { ...project, rundown: [...project.rundown.filter(entry => entry.id !== item.id), item] };
    // Clips the output cannot play (say a clip on no track) are not under the picture rule here: they
    // keep their own span, as before 0.5.9, and the preflight check tells the operator why they will not play.
    const media = collectManagedMediaTimeline(scoped, item.id);
    this.outsideOutput = new Set(media.refused.map(entry => entry.clipId));
    this.output = new SceneOutputTimeline(scoped, item.id, media.events);
    const cutsMs = this.output.cutPoints().map(frame => frameToMilliseconds(frame, frameRate));
    this.boundaries = [...new Set([...clips, ...visualObsCues].flatMap(entry => [entry.startMs, entry.endMs]).concat(cutsMs))]
      .sort((left, right) => left - right);
  }
  /** Every time the state can change, sorted: clip and show cue starts and ends, and
   * where the picture changes (a camera's start and end, which covers or reveals clips). */
  boundariesMs(): readonly number[] { return this.boundaries; }
  /** The state at `playheadMs`. Between two boundaries nothing changes but `playheadMs`,
   * so a query in the stretch last asked about reuses that answer. */
  at(playheadMs: number): ResolvedTimelineState {
    if (!Number.isFinite(playheadMs) || playheadMs < 0) throw new Error('播放头时间必须是非负有限毫秒数');
    let low = 0, high = this.boundaries.length;
    while (low < high) { const middle = (low + high) >>> 1; if (this.boundaries[middle]! <= playheadMs) low = middle + 1; else high = middle; }
    const last = this.last;
    if (last?.stretch === low) return last.state.playheadMs === playheadMs ? last.state : { ...last.state, playheadMs };
    const state = this.resolve(playheadMs);
    this.last = { stretch: low, state };
    return state;
  }
  private resolve(playheadMs: number): ResolvedTimelineState {
    const picture = this.output.pictureAt(frameAtMilliseconds(playheadMs, this.frameRate));
    const seen = new Set(picture.clips.map(clip => clip.clipId));
    const covered = new Set(picture.covered.map(clip => clip.clipId));
    const shown = new Set(picture.shows.map(show => show.cueId));
    // Written out field by field: this runs at every boundary the playhead crosses.
    const clips = this.clips.map((entry): ResolvedTimelineClip => {
      const active = isTimelineSpanActive(entry, playheadMs);
      const visual = entry.visual && (this.outsideOutput.has(entry.clip.id) ? active : seen.has(entry.clip.id));
      return { startMs: entry.startMs, endMs: entry.endMs, startFrame: entry.startFrame, endFrame: entry.endFrame, durationMs: entry.durationMs,
        clip: entry.clip, asset: entry.asset, layer: entry.layer, layerIndex: entry.layerIndex, active,
        // A picture clip is visible only when seen; sound follows its span.
        visible: entry.visual ? visual : active && entry.visible, visual,
        covered: covered.has(entry.clip.id), audible: active && entry.audible };
    });
    const visualObsCues = this.visualObsCues.map((entry): ResolvedTimelineObsCue => ({
      startMs: entry.startMs, endMs: entry.endMs, startFrame: entry.startFrame, endFrame: entry.endFrame, durationMs: entry.durationMs,
      cue: entry.cue, showAction: entry.showAction, layer: entry.layer, layerIndex: entry.layerIndex,
      active: entry.active && isTimelineSpanActive(entry, playheadMs), visible: shown.has(entry.cue.id) }));
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

/** The frame that holds `milliseconds`: the last frame starting at or before it, so a
 * span read in frames is the same half-open span `isTimelineSpanActive` reads in milliseconds. */
export function frameAtMilliseconds(milliseconds: number, frameRate: MtcFrameRate): number {
  let frame = Math.floor(milliseconds / 1_000 * playbackFramesPerSecond(frameRate));
  while (frame > 0 && frameToMilliseconds(frame, frameRate) > milliseconds) frame -= 1;
  while (frameToMilliseconds(frame + 1, frameRate) <= milliseconds) frame += 1;
  return frame;
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
