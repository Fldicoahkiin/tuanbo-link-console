import { ObsLiveCanvas, type ObsLiveMaterialEdits } from './ObsLiveCanvas';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent, type PointerEvent } from 'react';
import { obsItemPicture } from './obs-live-geometry';
import { canvasTransformFromObs, stagePlacement, type LinkObsInventory, type ResolvedTimelineClip, type ResolvedTimelineState } from '@tb/core/link';
import type { LinkMediaAsset, OutputCanvas, ReferenceCanvasTransform, ReferenceMediaClip } from '@tb/schema';
import { Boxes, MonitorPlay, RadioTower, Volume2 } from 'lucide-react';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { OBS_DRAG_TYPE, parseObsResource, type ObsResource } from './resource-library-model';
import { snapCanvasAxis } from './canvas-snap';
import { resizeMediaCanvas } from './media-canvas-geometry';
import { ObsPreviewLayer } from './ObsPreviewLayer';
import { StageMediaContextMenu } from './StageMediaContextMenu';
import { usePreviewMediaLifecycle } from './usePreviewMediaLifecycle';
import { useCapturedDrag } from './useCapturedDrag';
import { usePlayheadEffect, usePlayheadValue, type EditorPlayhead } from './editor-playhead';

type Props = {
  /** The clips the output shows; the camera, if any, lies beneath them. */
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
  /** Read every frame by the preview media, not by this stage (0.5.9 E2). */
  playhead: EditorPlayhead;
  playing: boolean;
  onSelectClip: (clipId: string) => void;
  onSelectCue: (cueId: string) => void;
  onSelectObsResource: (resource: ObsResource) => void;
  onTransformClip: (clipId: string, transform: ReferenceCanvasTransform) => void;
  /** The clip an OBS source of ours shows (core `clipOfMaterialSource`): null for any other source; throws to refuse. */
  materialClipOf?: ((sourceName: string) => string | null) | undefined;
  onMoveClipToTop: (clipId: string) => void;
  onRemoveClip: (clipId: string) => void;
  onDropObsResource: (resource: ObsResource, startMs?: number, layerId?: string) => void;
};

export function ReferenceStage(props: Props): JSX.Element {
  const aspect = props.outputCanvas.width > props.outputCanvas.height ? 'landscape' : 'portrait';
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [snapGuides, setSnapGuides] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });
  const [mediaContext, setMediaContext] = useState<{ clip: ReferenceMediaClip; asset: LinkMediaAsset; x: number; y: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  // Moving or resizing a layer on the stage (media and OBS layers) moves it as the pointer goes: while the pointer is
  // held the window's keys leave the show and the project alone (Escape, undo, delete); the gestures are as they were (K5).
  const keyDrag = useCapturedDrag();
  // On the live canvas a material's own picture is moved like any source, and the move is kept on its clip: it then
  // goes to OBS with the rest of the clip's look when the material is prepared (E16). Stable for the memoised canvas.
  const latest = useRef(props);
  latest.current = props;
  const materialEdits = useMemo<ObsLiveMaterialEdits>(() => ({
    refuse: (item) => {
      try { latest.current.materialClipOf?.(item.sourceName); return null; }
      catch (error) { return toMessage(error); }
    },
    released: (item, transform, scene) => {
      const clipId = latest.current.materialClipOf?.(item.sourceName);
      if (!clipId) return;
      latest.current.onTransformClip(clipId, canvasTransformFromObs(obsItemPicture(transform),
        { width: transform.sourceWidth, height: transform.sourceHeight }, { width: scene.width, height: scene.height }));
    }
  }), []);
  // Clips starting within 2 s are loaded ahead; the stage draws again only when that list changes.
  const upcoming = usePlayheadValue(props.playhead, positionMs => upcomingClipKey(props.timelineState, positionMs));
  // Clips under a camera stay loaded (hidden), so the camera's end reveals them without reloading.
  const visibleClips = props.timelineState?.clips.filter((entry) => entry.visual || entry.covered || upcoming.includes(`\n${entry.clip.id}\n`)) ?? [];
  const activeClipCount = props.timelineState?.activeClipIds.length ?? 0;
  const onAir = (clipId: string): boolean => props.activeMediaClipIds?.has(clipId) === true;
  const audibleClipIds = new Set(props.mutePreviewAudio ? [] : props.timelineState?.activeAudioClipIds.filter(onAir) ?? []);
  const standaloneAudio = props.timelineState?.clips.filter((entry) => audibleClipIds.has(entry.clip.id) && entry.asset.kind === 'audio') ?? [];
  const canvas = props.outputCanvas;
  const obsCanvasMatches = props.obsInventory?.videoSettings?.baseWidth === canvas.width
    && props.obsInventory.videoSettings.baseHeight === canvas.height;
  const dropObs = (event: DragEvent<HTMLDivElement>): void => {
    const value = event.dataTransfer.getData(OBS_DRAG_TYPE);
    if (!value) return;
    event.preventDefault();
    const resource = parseObsResource(value);
    props.onSelectObsResource(resource);
    props.onDropObsResource(resource, props.playhead.read());
  };

  if (props.obsStatus === 'connected') return <section className="reference-stage panel">
    <div className="stage-canvas"><ObsLiveCanvas material={materialEdits} /></div>
    <footer className="stage-statusbar"><span><RadioTower />OBS 实时画布</span><span>直接编辑 OBS 当前场景来源</span></footer>
  </section>;
  return <section className="reference-stage panel">
    <div
      className={`stage-canvas ${aspect}`}
      ref={stageRef}
      onDragOver={(event) => { if (event.dataTransfer.types.includes(OBS_DRAG_TYPE)) event.preventDefault(); }}
      onDrop={dropObs}
    >
      <div className="stage-frame" style={{ aspectRatio: `${canvas.width} / ${canvas.height}` }} {...keyDrag}>
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
          return <Fragment key={layer.id}>
            {props.projectPath ? visibleClips.filter((entry) => entry.layer?.id === layer.id).map((entry) => {
              return <MediaCanvasLayer
                key={entry.clip.id}
                asset={entry.asset}
                clip={entry.clip}
                startMs={entry.startMs}
                locked={layer.locked}
                hidden={!entry.visual || !onAir(entry.clip.id)}
                muted={!audibleClipIds.has(entry.clip.id)}
                playhead={props.playhead}
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
        {activeClipCount === 0 && !props.scenePreview ? <StagePlaceholder itemTitle={props.itemTitle} selectedAsset={props.selectedAsset} /> : null}
        {playbackError ? <div className="stage-error">{playbackError}</div> : null}
      </div>
    </div>
    {props.projectPath ? standaloneAudio.map((entry) => <StandaloneAudioPreview key={entry.clip.id} entry={entry} playhead={props.playhead} playing={props.playing} projectPath={props.projectPath ?? ''} onPlaybackError={setPlaybackError} />) : null}
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
  </section>;
}

function StandaloneAudioPreview(props: {
  entry: ResolvedTimelineClip;
  playhead: EditorPlayhead;
  playing: boolean;
  projectPath: string;
  onPlaybackError: (message: string | null) => void;
}): JSX.Element | null {
  const [url, setUrl] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  usePreviewMediaLifecycle(audioRef, url);
  const { asset, clip, startMs } = props.entry;
  const { onPlaybackError, playhead, playing, projectPath } = props;
  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    void linkDesktopViewModel.ensureMediaAudioUrl({ projectPath, relativePath: asset.relativePath, sha256: asset.sha256, kind: asset.kind })
      .then((value) => { if (!cancelled) setUrl(value); })
      .catch((error: unknown) => { if (!cancelled) onPlaybackError(toMessage(error)); });
    return () => { cancelled = true; };
  }, [asset.kind, asset.relativePath, asset.sha256, onPlaybackError, projectPath]);
  // Kept in step with the playhead on every move, not through a render (0.5.9 E2).
  usePlayheadEffect(playhead, useCallback((playheadMs: number) => {
    const audio = audioRef.current;
    // No `url`, no audio element; a new `url` is a new file, put in step again.
    if (!audio || !url || audio.readyState === 0) return;
    const desiredSeconds = ((clip.sourceOffsetMs ?? 0) + playheadMs - startMs) / 1_000;
    if (Math.abs(audio.currentTime - desiredSeconds) > (playing ? 0.75 : 0.04)) audio.currentTime = desiredSeconds;
    if (!playing) {
      audio.pause();
      return;
    }
    if (audio.paused) void audio.play().catch((error: unknown) => onPlaybackError(toMessage(error)));
  }, [clip.sourceOffsetMs, onPlaybackError, playing, startMs, url]));
  if (!url) return null;
  return <audio className="timeline-audio-engine" data-asset-id={asset.id} ref={audioRef} src={url} preload={playing ? 'auto' : 'metadata'} onLoadedMetadata={(event) => {
    event.currentTarget.currentTime = ((clip.sourceOffsetMs ?? 0) + playhead.read() - startMs) / 1_000;
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
  playhead: EditorPlayhead;
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
  const playhead = props.playhead;
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
  const hidden = props.hidden;
  // Kept in step with the playhead on every move, not through a render (0.5.9 E2): while playing only a drift over
  // 0.75 s is put right; stopped, dragging the playhead moves the video with it.
  usePlayheadEffect(playhead, useCallback((playheadMs: number) => {
    const video = videoRef.current;
    if (!video || video.readyState === 0) return;
    if (hidden) { video.pause(); return; }
    const desiredSeconds = (sourceOffsetMs + Math.max(0, playheadMs - startMs)) / 1_000;
    const seekThreshold = playing ? 0.75 : 0.04;
    if (Math.abs(video.currentTime - desiredSeconds) > seekThreshold) video.currentTime = desiredSeconds;
    if (!playing) {
      video.pause();
      return;
    }
    if (video.paused) void video.play().catch((error: unknown) => onPlaybackError(toMessage(error)));
  }, [hidden, onPlaybackError, playing, sourceOffsetMs, startMs]));
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
  // Drawn from the transform OBS gets (core media-obs-transform.ts), so the preview is what goes on air (E16).
  const placement = stagePlacement(preview, { width: props.asset.width ?? props.canvasWidth, height: props.asset.height ?? props.canvasHeight },
    { width: props.canvasWidth, height: props.canvasHeight });
  const style: CSSProperties = {
    zIndex: props.zIndex,
    width: `${placement.width * 100}%`,
    height: `${placement.height * 100}%`,
    visibility: props.hidden ? 'hidden' : 'visible',
    pointerEvents: props.hidden ? 'none' : undefined,
    left: `${placement.left * 100}%`,
    top: `${placement.top * 100}%`,
    transform: `translate(-50%, -50%) rotate(${placement.rotation}deg)`
  };
  return <button className={`stage-media-layer ${props.selected ? 'is-selected' : ''} ${props.locked ? 'is-locked' : ''}`} style={style} onContextMenu={props.onContextMenu} onPointerDown={(event) => beginGesture(event, 'move')} onPointerMove={moveGesture} onPointerUp={endGesture} onPointerCancel={cancelGesture}>
    {url && props.asset.kind === 'video' ? <video
      ref={videoRef}
      muted={props.muted}
      playsInline
      preload={props.hidden ? 'none' : playing ? 'auto' : 'metadata'}
      src={url}
      onLoadedMetadata={(event) => {
        event.currentTarget.currentTime = (sourceOffsetMs + Math.max(0, playhead.read() - startMs)) / 1_000;
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

/** The clips that start within the next 2 s, to load ahead, as one string (`\nid\n` each). */
function upcomingClipKey(state: ResolvedTimelineState | null, playheadMs: number): string {
  const ids = state?.clips.filter((entry) => !entry.visual && entry.layer?.visible !== false && entry.asset.kind !== 'audio'
    && entry.startMs > playheadMs && entry.startMs <= playheadMs + 2000).map((entry) => entry.clip.id) ?? [];
  return ids.length ? `\n${ids.join('\n\n')}\n` : '';
}

function StagePlaceholder(props: { itemTitle: string | null; selectedAsset: LinkMediaAsset | null }): JSX.Element {
  return <div className="stage-placeholder"><div className="stage-safe-frame"><MonitorPlay /><strong>{props.itemTitle ?? '还没选择节目'}</strong><span>{props.selectedAsset ? '把素材拖到参考素材轨道上，播放头经过片段时就会显示' : '把本地素材或 OBS 采集画面拖到这里'}</span></div></div>;
}

type CanvasHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
type ResizeDirection = { x: -1 | 0 | 1; y: -1 | 0 | 1 };
type CanvasGesture = { mode: 'move' | 'resize'; pointerId: number; startX: number; startY: number; origin: ReferenceCanvasTransform; latest: ReferenceCanvasTransform; direction: ResizeDirection };

const CANVAS_HANDLES: CanvasHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

function resizeDirection(handle: CanvasHandle): ResizeDirection {
  return {
    x: handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0,
    y: handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
