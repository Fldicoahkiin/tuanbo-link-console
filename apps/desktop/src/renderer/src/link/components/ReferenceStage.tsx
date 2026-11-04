import { ObsLiveCanvas } from './ObsLiveCanvas';
import { Fragment, useEffect, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent, type PointerEvent } from 'react';
import type { LinkObsInventory, LinkObsSceneItemTransform, ResolvedTimelineClip, ResolvedTimelineObsCue, ResolvedTimelineState } from '@tb/core/link';
import type { LinkMediaAsset, OutputCanvas, ReferenceCanvasTransform, ReferenceMediaClip, SceneItemTransform } from '@tb/schema';
import { Boxes, MonitorPlay, RadioTower, Volume2 } from 'lucide-react';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { OBS_DRAG_TYPE, obsPreviewSourceName, parseObsResource, type ObsResource } from './resource-library-model';
import { snapCanvasAxis } from './canvas-snap';
import { resizeMediaCanvas } from './media-canvas-geometry';
import { ObsPreviewLayer } from './ObsPreviewLayer';
import { resolveObsSceneItemGeometry, resolveObsSourceSize, type ObsSourceSize } from './obs-source-geometry';
import { StageMediaContextMenu, StageObsContextMenu } from './StageMediaContextMenu';
import { usePreviewMediaLifecycle } from './usePreviewMediaLifecycle';

type Props = {
  sceneMode?: boolean;
  /** Scene mode: the clips the output shows; the camera, if any, lies beneath them. */
  activeMediaClipIds?: ReadonlySet<string> | null;
  scenePreview?: { cueId: string; sceneName: string } | null;
  mutePreviewAudio?: boolean;
  itemTitle: string | null;
  timelineState: ResolvedTimelineState | null;
  outputCanvas: OutputCanvas;
  selectedAsset: LinkMediaAsset | null;
  selectedClipId: string | null;
  selectedCueId: string | null;
  projectPath: string | null;
  obsStatus: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';
  obsSceneCount: number;
  obsInputCount: number;
  obsInventory: LinkObsInventory | null;
  playheadMs: number;
  playing: boolean;
  onSelectClip: (clipId: string) => void;
  onSelectCue: (cueId: string) => void;
  onSelectObsResource: (resource: ObsResource) => void;
  onTransformClip: (clipId: string, transform: ReferenceCanvasTransform) => void;
  onMoveClipToTop: (clipId: string) => void;
  onRemoveClip: (clipId: string) => void;
  onTransformObs: (cueId: string, transform: SceneItemTransform) => void;
  onMoveObsToTop: (cueId: string) => void;
  onRemoveObs: (cueId: string) => void;
  onDropObsResource: (resource: ObsResource, startMs?: number, layerId?: string) => void;
};

export function ReferenceStage(props: Props): JSX.Element {
  const aspect = props.outputCanvas.width > props.outputCanvas.height ? 'landscape' : 'portrait';
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [snapGuides, setSnapGuides] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });
  const [mediaContext, setMediaContext] = useState<{ clip: ReferenceMediaClip; asset: LinkMediaAsset; x: number; y: number } | null>(null);
  const [obsContext, setObsContext] = useState<(ActiveObsResource & { layerId: string; x: number; y: number }) | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const visibleClips = props.timelineState?.clips.filter((entry) => entry.visual || (entry.layer?.visible !== false && entry.asset.kind !== 'audio' && entry.startMs > props.playheadMs && entry.startMs <= props.playheadMs + 2000)) ?? [];
  const activeClipCount = props.timelineState?.activeClipIds.length ?? 0;
  const onAir = (clipId: string): boolean => !props.sceneMode || props.activeMediaClipIds?.has(clipId) === true;
  const audibleClipIds = new Set(props.mutePreviewAudio ? [] : props.timelineState?.activeAudioClipIds.filter(onAir) ?? []);
  const standaloneAudio = props.timelineState?.clips.filter((entry) => audibleClipIds.has(entry.clip.id) && entry.asset.kind === 'audio') ?? [];
  const canvas = props.outputCanvas;
  const obsCanvasMatches = props.obsInventory?.videoSettings?.baseWidth === canvas.width
    && props.obsInventory.videoSettings.baseHeight === canvas.height;
  const activeObsCount = props.scenePreview ? 1 : props.timelineState?.activeObsCueIds.length ?? 0;
  const dropObs = (event: DragEvent<HTMLDivElement>): void => {
    const value = event.dataTransfer.getData(OBS_DRAG_TYPE);
    if (!value) return;
    event.preventDefault();
    const resource = parseObsResource(value);
    props.onSelectObsResource(resource);
    props.onDropObsResource(resource, props.playheadMs);
  };

  if (props.obsStatus === 'connected') return <section className="reference-stage panel">
    <div className="stage-canvas"><ObsLiveCanvas /></div>
    <footer className="stage-statusbar"><span><RadioTower />OBS 实时画布</span><span>直接编辑 OBS 当前场景来源</span></footer>
  </section>;
  return <section className="reference-stage panel">
    <div
      className={`stage-canvas ${aspect}`}
      ref={stageRef}
      onDragOver={(event) => { if (event.dataTransfer.types.includes(OBS_DRAG_TYPE)) event.preventDefault(); }}
      onDrop={dropObs}
    >
      <div className="stage-frame" style={{ aspectRatio: `${canvas.width} / ${canvas.height}` }}>
        {props.scenePreview ? <ObsPreviewLayer key={props.scenePreview.sceneName}
          sourceName={props.scenePreview.sceneName} status={props.obsStatus} zIndex={1}
          selected={props.selectedCueId === props.scenePreview.cueId} locked
          transform={null} sourceSize={{ width: canvas.width, height: canvas.height }}
          canvasWidth={canvas.width} canvasHeight={canvas.height} onSnapGuides={setSnapGuides}
          onSelect={() => props.scenePreview && props.onSelectCue(props.scenePreview.cueId)}
          onContextMenu={(event) => event.preventDefault()}
          onTransform={() => { throw new Error('整个 OBS 场景的画面请在 OBS 里调整'); }}
        /> : null}
        {[...(props.timelineState?.layers ?? [])].reverse().map((layerState, reverseIndex) => {
          const layer = layerState.layer;
          if (!layer.visible) return null;
          const zIndex = reverseIndex + 2;
          const obsEntries = props.sceneMode ? [] : layerState.activeObsCues.map((entry) => resolveActiveObsResource(entry, props.obsInventory, canvas)).filter((entry) => !entry.resource.inputKind?.includes('wasapi'));
          return <Fragment key={layer.id}>
            {obsEntries.map((obsEntry) => <ObsPreviewLayer key={obsEntry.cueId} sourceName={obsPreviewSourceName(obsEntry.resource) ?? obsEntry.resource.name} status={props.obsStatus} zIndex={zIndex} selected={props.selectedCueId === obsEntry.cueId} locked={layer.locked} transform={obsEntry.transform} sourceSize={obsEntry.sourceSize} canvasWidth={obsEntry.canvasWidth} canvasHeight={obsEntry.canvasHeight} onSnapGuides={setSnapGuides} onSelect={() => { props.onSelectObsResource(obsEntry.resource); props.onSelectCue(obsEntry.cueId); }} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); props.onSelectObsResource(obsEntry.resource); props.onSelectCue(obsEntry.cueId); setMediaContext(null); setObsContext({ ...obsEntry, layerId: layer.id, x: event.clientX, y: event.clientY }); }} onTransform={(transform) => props.onTransformObs(obsEntry.cueId, transform)} />)}
            {props.projectPath ? visibleClips.filter((entry) => entry.layer?.id === layer.id).map((entry) => {
              return <MediaCanvasLayer
                key={entry.clip.id}
                asset={entry.asset}
                clip={entry.clip}
                startMs={entry.startMs}
                locked={layer.locked}
                hidden={!entry.visual || !onAir(entry.clip.id)}
                muted={!audibleClipIds.has(entry.clip.id)}
                playheadMs={props.playheadMs}
                playing={props.playing}
                projectPath={props.projectPath ?? ''}
                selected={props.selectedClipId === entry.clip.id}
                zIndex={zIndex}
                canvasWidth={canvas.width}
                canvasHeight={canvas.height}
                onSnapGuides={setSnapGuides}
                onPlaybackError={setPlaybackError}
                onSelect={() => props.onSelectClip(entry.clip.id)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  props.onSelectClip(entry.clip.id);
                  setMediaContext({ clip: entry.clip, asset: entry.asset, x: event.clientX, y: event.clientY });
                }}
                onTransform={(transform) => props.onTransformClip(entry.clip.id, transform)}
              />;
            }) : null}
          </Fragment>;
        })}
        {snapGuides.x !== null ? <i className="stage-snap-guide vertical" style={{ left: `${snapGuides.x * 100}%` }} /> : null}
        {snapGuides.y !== null ? <i className="stage-snap-guide horizontal" style={{ top: `${snapGuides.y * 100}%` }} /> : null}
        {activeClipCount === 0 && activeObsCount === 0 ? <StagePlaceholder itemTitle={props.itemTitle} selectedAsset={props.selectedAsset} /> : null}
        {playbackError ? <div className="stage-error">{playbackError}</div> : null}
      </div>
    </div>
    {props.projectPath ? standaloneAudio.map((entry) => <StandaloneAudioPreview key={entry.clip.id} entry={entry} playheadMs={props.playheadMs} playing={props.playing} projectPath={props.projectPath ?? ''} onPlaybackError={setPlaybackError} />) : null}
    <footer className="stage-statusbar">
      <span><Boxes />活动素材 {activeClipCount}</span>
      <span><RadioTower />OBS {props.obsSceneCount} 场景 / {props.obsInputCount} 输入</span>
      <span><Volume2 />视频音频 试听</span>
      <strong className={obsCanvasMatches ? 'is-matched' : 'is-mismatched'}>{canvas.width}×{canvas.height}{props.obsInventory?.videoSettings ? obsCanvasMatches ? ' · OBS 一致' : ' · OBS 不一致' : ''}</strong>
    </footer>
    {mediaContext ? <StageMediaContextMenu
      context={mediaContext}
      topLayerId={props.timelineState?.layers[0]?.layer.id ?? null}
      onClose={() => setMediaContext(null)}
      onTransform={(transform) => props.onTransformClip(mediaContext.clip.id, transform)}
      onMoveToTop={() => props.onMoveClipToTop(mediaContext.clip.id)}
      onRemove={() => props.onRemoveClip(mediaContext.clip.id)}
    /> : null}
    {obsContext ? <StageObsContextMenu
      context={obsContext}
      topLayerId={props.timelineState?.layers[0]?.layer.id ?? null}
      onClose={() => setObsContext(null)}
      onTransform={(transform) => props.onTransformObs(obsContext.cueId, transform)}
      onMoveToTop={() => props.onMoveObsToTop(obsContext.cueId)}
      onRemove={() => props.onRemoveObs(obsContext.cueId)}
    /> : null}
  </section>;
}

function StandaloneAudioPreview(props: {
  entry: ResolvedTimelineClip;
  playheadMs: number;
  playing: boolean;
  projectPath: string;
  onPlaybackError: (message: string | null) => void;
}): JSX.Element | null {
  const [url, setUrl] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  usePreviewMediaLifecycle(audioRef, url);
  const { asset, clip, startMs } = props.entry;
  const { onPlaybackError, playheadMs, playing, projectPath } = props;
  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    void linkDesktopViewModel.ensureMediaAudioUrl({ projectPath, relativePath: asset.relativePath, sha256: asset.sha256, kind: asset.kind })
      .then((value) => { if (!cancelled) setUrl(value); })
      .catch((error: unknown) => { if (!cancelled) onPlaybackError(toMessage(error)); });
    return () => { cancelled = true; };
  }, [asset.kind, asset.relativePath, asset.sha256, onPlaybackError, projectPath]);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || audio.readyState === 0) return;
    const desiredSeconds = ((clip.sourceOffsetMs ?? 0) + playheadMs - startMs) / 1_000;
    if (Math.abs(audio.currentTime - desiredSeconds) > (playing ? 0.75 : 0.04)) audio.currentTime = desiredSeconds;
    if (!playing) {
      audio.pause();
      return;
    }
    if (audio.paused) void audio.play().catch((error: unknown) => onPlaybackError(toMessage(error)));
  }, [clip.sourceOffsetMs, onPlaybackError, playheadMs, playing, startMs, url]);
  if (!url) return null;
  return <audio className="timeline-audio-engine" data-asset-id={asset.id} ref={audioRef} src={url} preload={playing ? 'auto' : 'metadata'} onLoadedMetadata={(event) => {
    event.currentTarget.currentTime = ((clip.sourceOffsetMs ?? 0) + playheadMs - startMs) / 1_000;
    if (playing) void event.currentTarget.play().catch((error: unknown) => onPlaybackError(toMessage(error)));
  }} onError={() => onPlaybackError(`音频无法解码：${asset.name}`)} />;
}

function MediaCanvasLayer(props: {
  asset: LinkMediaAsset;
  clip: ReferenceMediaClip;
  startMs: number;
  locked: boolean;
  hidden: boolean;
  muted: boolean;
  playheadMs: number;
  playing: boolean;
  projectPath: string;
  selected: boolean;
  zIndex: number;
  canvasWidth: number;
  canvasHeight: number;
  onSnapGuides: (guides: { x: number | null; y: number | null }) => void;
  onPlaybackError: (message: string | null) => void;
  onSelect: () => void;
  onContextMenu: (event: MouseEvent<HTMLButtonElement>) => void;
  onTransform: (transform: ReferenceCanvasTransform) => void;
}): JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const [preview, setPreview] = useState(props.clip.canvasTransform);
  const gesture = useRef<CanvasGesture | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  usePreviewMediaLifecycle(videoRef, url);
  const startMs = props.startMs;
  const assetRelativePath = props.asset.relativePath;
  const assetKind = props.asset.kind;
  const assetSha256 = props.asset.sha256;
  const onPlaybackError = props.onPlaybackError;
  const playheadMs = props.playheadMs;
  const playing = props.playing;
  const projectPath = props.projectPath;
  const sourceOffsetMs = props.clip.sourceOffsetMs ?? 0;
  useEffect(() => setPreview(props.clip.canvasTransform), [props.clip.canvasTransform]);
  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    void linkDesktopViewModel.ensureMediaPreviewUrl({ projectPath, relativePath: assetRelativePath, sha256: assetSha256, kind: assetKind })
      .then((value) => { if (!cancelled) setUrl(value); })
      .catch((error: unknown) => { if (!cancelled) onPlaybackError(toMessage(error)); });
    return () => { cancelled = true; };
  }, [assetKind, assetRelativePath, assetSha256, onPlaybackError, projectPath]);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || video.readyState === 0) return;
    if (props.hidden) { video.pause(); return; }
    const desiredSeconds = (sourceOffsetMs + Math.max(0, playheadMs - startMs)) / 1_000;
    const seekThreshold = playing ? 0.75 : 0.04;
    if (Math.abs(video.currentTime - desiredSeconds) > seekThreshold) video.currentTime = desiredSeconds;
    if (!playing) {
      video.pause();
      return;
    }
    if (video.paused) void video.play().catch((error: unknown) => onPlaybackError(toMessage(error)));
  }, [onPlaybackError, playheadMs, playing, props.hidden, sourceOffsetMs, startMs]);
  const beginGesture = (event: PointerEvent<HTMLElement>, mode: CanvasGesture['mode'], handle?: CanvasHandle): void => {
    if (event.button !== 0 || props.locked) return;
    event.preventDefault();
    event.stopPropagation();
    props.onSelect();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { mode, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin: preview, latest: preview, direction: handle ? resizeDirection(handle) : { x: 0, y: 0 } };
  };
  const moveGesture = (event: PointerEvent<HTMLElement>): void => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const frame = event.currentTarget.closest('.stage-frame')?.getBoundingClientRect();
    if (!frame) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (current.mode === 'move') {
      const renderedWidth = (props.asset.width ?? props.canvasWidth) / props.canvasWidth * current.origin.scale * current.origin.scaleX;
      const renderedHeight = (props.asset.height ?? props.canvasHeight) / props.canvasHeight * current.origin.scale * current.origin.scaleY;
      const snappedX = snapCanvasAxis({ value: current.origin.x + dx / frame.width, itemSize: renderedWidth, anchor: 0.5, canvasSize: 1, threshold: event.ctrlKey ? 0 : 8 / frame.width });
      const snappedY = snapCanvasAxis({ value: current.origin.y + dy / frame.height, itemSize: renderedHeight, anchor: 0.5, canvasSize: 1, threshold: event.ctrlKey ? 0 : 8 / frame.height });
      props.onSnapGuides({ x: snappedX.guide, y: snappedY.guide });
      current.latest = { ...current.origin, x: clamp(snappedX.value, -1, 2), y: clamp(snappedY.value, -1, 2) };
      setPreview(current.latest);
      return;
    }
    props.onSnapGuides({ x: null, y: null });
    current.latest = resizeMediaCanvas({
      origin: current.origin, direction: current.direction, dx, dy,
      width: (props.asset.width ?? props.canvasWidth) / props.canvasWidth * frame.width * current.origin.scale * current.origin.scaleX,
      height: (props.asset.height ?? props.canvasHeight) / props.canvasHeight * frame.height * current.origin.scale * current.origin.scaleY,
      frameWidth: frame.width, frameHeight: frame.height, freeform: event.shiftKey
    });
    setPreview(current.latest);
  };
  const endGesture = (event: PointerEvent<HTMLElement>): void => {
    if (!gesture.current || gesture.current.pointerId !== event.pointerId) return;
    const current = gesture.current;
    gesture.current = null;
    props.onSnapGuides({ x: null, y: null });
    if (current.latest !== current.origin) props.onTransform(current.latest);
  };
  const cancelGesture = (event: PointerEvent<HTMLElement>): void => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    gesture.current = null;
    setPreview(current.origin);
    props.onSnapGuides({ x: null, y: null });
  };
  const style: CSSProperties = {
    zIndex: props.zIndex,
    width: `${(props.asset.width ?? props.canvasWidth) / props.canvasWidth * preview.scale * preview.scaleX * 100}%`,
    height: `${(props.asset.height ?? props.canvasHeight) / props.canvasHeight * preview.scale * preview.scaleY * 100}%`,
    visibility: props.hidden ? 'hidden' : 'visible',
    pointerEvents: props.hidden ? 'none' : undefined,
    left: `${preview.x * 100}%`,
    top: `${preview.y * 100}%`,
    transform: `translate(-50%, -50%) rotate(${preview.rotation}deg)`
  };
  return <button className={`stage-media-layer ${props.selected ? 'is-selected' : ''} ${props.locked ? 'is-locked' : ''}`} style={style} onContextMenu={props.onContextMenu} onPointerDown={(event) => beginGesture(event, 'move')} onPointerMove={moveGesture} onPointerUp={endGesture} onPointerCancel={cancelGesture}>
    {url && props.asset.kind === 'video' ? <video
      ref={videoRef}
      muted={props.muted}
      playsInline
      preload={props.hidden ? 'none' : playing ? 'auto' : 'metadata'}
      src={url}
      onLoadedMetadata={(event) => {
        event.currentTarget.currentTime = (sourceOffsetMs + Math.max(0, playheadMs - startMs)) / 1_000;
        if (playing && !props.hidden) void event.currentTarget.play().catch((error: unknown) => onPlaybackError(toMessage(error)));
      }}
      onError={() => props.onPlaybackError(`视频无法解码：${props.asset.name}`)}
    /> : null}
    {url && props.asset.kind === 'image' ? <img src={url} alt={props.asset.name} /> : null}
    {url && props.asset.kind === 'audio' ? <div className="stage-audio-layer"><Volume2 /><strong>{props.asset.name}</strong></div> : null}
    {!url ? <span className="preview-loading">正在准备可编辑预览：{props.asset.name}…</span> : null}
    <span className="stage-layer-name">{props.asset.name}</span>
    {props.selected && !props.locked ? CANVAS_HANDLES.map((handle) => <i key={handle} className={`stage-media-handle ${handle}`} onPointerDown={(event) => beginGesture(event, 'resize', handle)} />) : null}
  </button>;
}

function StagePlaceholder(props: { itemTitle: string | null; selectedAsset: LinkMediaAsset | null }): JSX.Element {
  return <div className="stage-placeholder"><div className="stage-safe-frame"><MonitorPlay /><strong>{props.itemTitle ?? '还没选择节目'}</strong><span>{props.selectedAsset ? '把素材拖到参考素材轨道上，播放头经过片段时就会显示' : '把本地素材或 OBS 采集画面拖到这里'}</span></div></div>;
}

type CanvasHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
type ResizeDirection = { x: -1 | 0 | 1; y: -1 | 0 | 1 };
type CanvasGesture = { mode: 'move' | 'resize'; pointerId: number; startX: number; startY: number; origin: ReferenceCanvasTransform; latest: ReferenceCanvasTransform; direction: ResizeDirection };

type ActiveObsResource = { cueId: string; resource: ObsResource; transform: SceneItemTransform | null; sourceSize: ObsSourceSize | null; canvasWidth: number; canvasHeight: number };

function resolveActiveObsResource(entry: ResolvedTimelineObsCue, inventory: LinkObsInventory | null, canvas: { width: number; height: number }): ActiveObsResource {
  const action = entry.showAction;
  const geometry = resolveObsSceneItemGeometry(inventory, action.sceneName, action.sourceName);
  const sourceSize = resolveObsSourceSize(inventory, action.sceneName, action.sourceName);
  const resource: ObsResource = { id: `scene-item:${action.sceneName}:${action.sourceName}`, kind: 'sceneItem', group: '摄像头', name: action.sourceName, sceneName: action.sceneName, sourceName: action.sourceName, ...(inventory?.inputKinds[action.sourceName] ? { inputKind: inventory.inputKinds[action.sourceName] } : {}), ...(geometry ? { transform: geometry } : {}) };
  const transformAction = entry.cue.actions.find((candidate) => (
    candidate.kind === 'obs.setSceneItemTransform'
    && candidate.sceneName === action.sceneName
    && candidate.sourceName === action.sourceName
  ));
  const inventoryTransform = geometry ? sceneItemTransformFromInventory(geometry) : null;
  const defaultTransform = sourceSize ? originalObsTransform(canvas.width, canvas.height) : null;
  const transform = transformAction?.kind === 'obs.setSceneItemTransform' ? transformAction.transform : null;
  return { cueId: entry.cue.id, resource, transform: transform ?? inventoryTransform ?? defaultTransform, sourceSize, canvasWidth: canvas.width, canvasHeight: canvas.height };
}

const CANVAS_HANDLES: CanvasHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

function resizeDirection(handle: CanvasHandle): ResizeDirection {
  return {
    x: handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0,
    y: handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0
  };
}

function sceneItemTransformFromInventory(transform: LinkObsSceneItemTransform): SceneItemTransform {
  return {
    positionX: transform.positionX,
    positionY: transform.positionY,
    scaleX: transform.scaleX,
    scaleY: transform.scaleY,
    rotation: transform.rotation,
    cropTop: transform.cropTop,
    cropRight: transform.cropRight,
    cropBottom: transform.cropBottom,
    cropLeft: transform.cropLeft,
    alignment: transform.alignment
  };
}

function originalObsTransform(canvasWidth: number, canvasHeight: number): SceneItemTransform {
  return { positionX: canvasWidth / 2, positionY: canvasHeight / 2, scaleX: 1, scaleY: 1, rotation: 0, cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0, alignment: 0 };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
