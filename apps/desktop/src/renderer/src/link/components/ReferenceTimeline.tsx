import { formatTimelineTimecode } from './timeline-geometry';
import { AudioTimelineSegments } from './AudioTimelineSegments';
import { AudioTrackLane } from './AudioTrackLane';
import type { AudioEditor } from './useAudioEditor';
import { timelineSnapPoints, displayedSceneDuration } from './timeline-snap-points';
import { useEffect, useMemo, useRef, useState, type RefObject, type CSSProperties, type DragEvent, type KeyboardEvent, type PointerEvent } from 'react';
import {
  playbackFramesPerSecond,
  resolveTimelineClipSpan,
  timecodeToMilliseconds,
  type ResolvedTimelineState,
  type TimelineSpan
} from '@tb/core/link';
import type { LinkCue, LinkMediaAsset, MtcFrameRate, ReferenceMediaClip, VisualLayer } from '@tb/schema';
import {
  Music2, Trash2,
  type LucideIcon
} from 'lucide-react';
import { MEDIA_DRAG_TYPE, OBS_DRAG_TYPE, type ObsResource } from './ResourceLibrary';
import { parseObsResource } from './resource-library-model';
import {
  TimelineWaveformCanvas,
  useReferenceWaveformPeaks,
  type ReferenceWaveformSource
} from './ReferenceWaveform';
import { timelineInteractionTime, timelineMoveSnapPoints } from './timeline-geometry';
import type { TimelineDrag } from './TimelineItems';
import { TimelineContextMenu, type TimelineContext, type TimelineTarget } from './TimelineContextMenu';
import { TimelineToolbar } from './TimelineToolbar';
import { TimelineLightingRecording } from './LightingRecordingControls';
import { TimelineLayerHeading } from './TimelineLayerHeading';
import { TimelineNewLayerDrop } from './TimelineNewLayerDrop';
import { TimelineVisualLayers } from './TimelineVisualLayers';
import { useLayerReorder } from './useLayerReorder';
import { useTimelineItemDrag } from './useTimelineItemDrag';
import { useClipResize, useCueResize } from './useTimelineResize';
import { useTimelineViewport } from './useTimelineViewport';
import { LightingHeadings, LightingLanes, type LightingTimelineProps } from './LightingTimeline';
import { TimelineMarkers } from './TimelineMarkers';
import { useLightingPreview } from '../runtime/use-lighting-preview';

type Props = {
  audioEditor?: AudioEditor;
  onSelectAudio?: (id?: string) => void;
  externalTransport?: boolean;
  transportAudioRef?: RefObject<HTMLAudioElement>;
  onStop?: () => void;
  lighting?: LightingTimelineProps;
  projectPath: string | null;
  assets: LinkMediaAsset[];
  clips: ReferenceMediaClip[];
  cues: LinkCue[];
  layers: VisualLayer[];
  timelineState: ResolvedTimelineState;
  frameRate: MtcFrameRate;
  durationMs: number;
  playheadMs: number;
  referenceAudio: ReferenceWaveformSource | null;
  playing: boolean;
  selectedClipId: string | null;
  selectedCueId: string | null;
  onPlayheadChange: (milliseconds: number) => void;
  onPlayingChange: (playing: boolean) => void;
  onPlaybackError: (message: string) => void;
  onSelectClip: (clipId: string) => void;
  onSelectCue: (cueId: string) => void;
  onDropAsset: (assetId: string, startMs: number, layerId?: string | null) => void;
  onDropObsResource: (resource: ObsResource, startMs: number, layerId?: string | null) => void;
  onMoveClip: (clipId: string, startMs: number, layerId?: string | null) => void;
  onTrimClip: (clipId: string, startMs: number, durationMs: number) => void;
  onTrimCue: (cueId: string, startMs: number, durationMs: number) => void;
  onSetClipEmbeddedAudioEnabled: (clipId: string, enabled: boolean) => void;
  onSplitClip: (clipId: string, timeMs: number) => void;
  onDuplicateClip: (clipId: string, startMs: number) => void;
  onDuplicateCue: (cueId: string, startMs: number) => void;
  onMoveCue: (cueId: string, timeMs: number, layerId?: string | null) => void;
  onMoveLayer: (layerId: string, targetIndex: number) => void;
  onUpdateLayer: (layer: VisualLayer) => void; onDeleteLayer: (layerId: string) => void;
  onDeleteClip: (clipId: string) => void;
  onDeleteCue: (cueId: string) => void;
};

type TimelineStyle = CSSProperties & { '--timeline-grid-size': string };

function useDismissContext(active: boolean, dismiss: () => void): void {
  useEffect(() => {
    if (!active) return;
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('blur', dismiss);
    const escape = (event: globalThis.KeyboardEvent): void => { if (event.key === 'Escape') { event.preventDefault(); dismiss(); } };
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('keydown', escape);
    };
  }, [active, dismiss]);
}

function deleteTimelineSelection(props: Props): void {
  const lighting = props.lighting;
  if (lighting?.selectedEventId) {
    const track = lighting.document.tracks.find((entry) => entry.clips.some((clip) => clip.id === lighting.selectedClipId));
    if (!track || track.locked) return;
    const ids = new Set(lighting.selectedEventIds ?? [lighting.selectedEventId]);
    lighting.onChange({ ...lighting.document, tracks: lighting.document.tracks.map((entry) => entry.id === track.id ? { ...entry, clips: entry.clips.map((clip) => clip.id === lighting.selectedClipId ? { ...clip, events: clip.events.filter((event) => !ids.has(event.id)) } : clip) } : entry) }, '删除灯光点');
    lighting.onSelect(track.id, lighting.selectedClipId);
  }
  else if (props.selectedClipId) props.onDeleteClip(props.selectedClipId);
  else if (props.selectedCueId) props.onDeleteCue(props.selectedCueId);
}

function useResolvedPresentation(state: ResolvedTimelineState): {
  activeClipIds: Set<string>;
  activeCueIds: Set<string>;
  clipSpans: Map<string, TimelineSpan>;
  visualCueSpans: Map<string, ResolvedTimelineState['visualObsCues'][number]>;
} {
  return useMemo(() => ({
    activeClipIds: new Set(state.activeClipIds),
    activeCueIds: new Set(state.activeObsCueIds),
    clipSpans: new Map(state.clips.map((entry) => [entry.clip.id, entry])),
    visualCueSpans: new Map(state.visualObsCues.map((entry) => [entry.cue.id, entry]))
  }), [state]);
}

function timelineLayout(props: Props, contentWidth: number, pixelsPerSecond: number, gridSize: number): {
  playheadLeft: number;
  contentStyle: TimelineStyle;
  headingStyle: CSSProperties;
  waveformContentWidth: number;
} {
  const audioRows = Math.max(1, props.audioEditor?.tracks.length ?? 0);
  const rows = [props.lighting?.document.markers.length ? '44px' : '28px', ...Array.from({ length: audioRows }, () => '76px'), ...props.layers.map(() => '50px')];
  if (props.lighting) rows.splice(1 + audioRows + Math.min(props.layers.length, props.lighting.document.laneIndex ?? 0), 0, ...Array.from({ length: Math.max(1, props.lighting.document.tracks.length) }, () => '72px'));
  rows.push('minmax(90px, 1fr)');
  const contentStyle: TimelineStyle = { width: contentWidth, gridTemplateRows: rows.join(' '), '--timeline-grid-size': `${gridSize}px` };
  return {
    playheadLeft: props.playheadMs / 1_000 * pixelsPerSecond,
    contentStyle,
    headingStyle: { gridTemplateRows: contentStyle.gridTemplateRows },
    waveformContentWidth: props.referenceAudio ? Math.min(contentWidth, props.referenceAudio.durationMs / 1_000 * pixelsPerSecond) : contentWidth
  };
}

function occupiedVisualLayers(input: Pick<Props, 'layers' | 'clips' | 'cues'>): VisualLayer[] {
  const occupied = new Set([...input.clips.map((clip) => clip.layerId), ...input.cues.map((cue) => cue.layerId)]);
  return input.layers.filter((layer) => occupied.has(layer.id));
}

export function ReferenceTimeline(input: Props): JSX.Element {
  const layers = useMemo(() => occupiedVisualLayers({ layers: input.layers, clips: input.clips, cues: input.cues }), [input.layers, input.clips, input.cues]);
  const props = { ...input, layers };
  const assets = useMemo(() => new Map(props.assets.map((asset) => [asset.id, asset])), [props.assets]);
  const viewport = useTimelineViewport(props.durationMs);
  const revealTimelineTime = viewport.revealTime;
  const waveform = useReferenceWaveformPeaks(props.referenceAudio);
  const timelineRef = useRef<HTMLElement>(null);
  const localAudioRef = useRef<HTMLAudioElement>(null);
  const audioRef = props.externalTransport && props.transportAudioRef ? props.transportAudioRef : localAudioRef;
  const lightingPreview = props.lighting?.preview ?? false;
  const lightingReady = useLightingPreview({ enabled: lightingPreview && !props.externalTransport, document: props.lighting?.document, audioRef, playing: props.playing && !props.externalTransport, frameRate: props.frameRate, onError: (message) => { props.onPlayingChange(false); props.onPlaybackError(message); } });
  const playheadPointerId = useRef<number | null>(null);
  const [clipboard, setClipboard] = useState<TimelineTarget | null>(null);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [snapDistance, setSnapDistance] = useState(14);
  const [clipContext, setClipContext] = useState<TimelineContext | null>(null);
  const layerReorder = useLayerReorder(layers.length, (id, index) => { const target = layers[index]; if (target) input.onMoveLayer(id, input.layers.findIndex((layer) => layer.id === target.id)); });
  const seekSnapPointsMs = useMemo(() => [...timelineSnapPoints(props.timelineState, props.cues, props.frameRate, viewport.pixelsPerSecond), ...(props.audioEditor?.points ?? [])], [props.cues, props.frameRate, props.timelineState, viewport.pixelsPerSecond, props.audioEditor?.points]);
  const snapThresholdMs = snapDistance / viewport.pixelsPerSecond * 1_000;
  const itemDrag = useTimelineItemDrag({
    clips: props.clips,
    cues: props.cues,
    layers: props.layers,
    focusTimeline: () => timelineRef.current?.focus(),
    timeAtClientX: viewport.editTimeAtClientX,
    snapTime: (milliseconds, target) => {
      const duration = target.kind === 'clip' ? props.clips.find((clip) => clip.id === target.id)?.durationMs ?? 0
        : displayedSceneDuration(props.cues.find((cue) => cue.id === target.id), viewport.pixelsPerSecond);
      const points = timelineSnapPoints(props.timelineState, props.cues, props.frameRate, viewport.pixelsPerSecond, props.playheadMs, target);
      return snap({ ...props, durationMs: Math.max(props.durationMs, milliseconds) }, milliseconds, snapEnabled,
        timelineMoveSnapPoints([0, props.durationMs, ...points, ...(props.audioEditor?.points ?? [])], duration), snapThresholdMs);
    },
    onSelectClip: props.onSelectClip,
    onSelectCue: props.onSelectCue,
    onMoveClip: props.onMoveClip,
    onMoveCue: props.onMoveCue,
    onMoveLayer: props.onMoveLayer
  });
  const clipResize = useClipResize({ durationMs: 86_399_000, frameRate: props.frameRate, onTrimClip: props.onTrimClip, onSelectClip: props.onSelectClip, timeAtClientX: viewport.editTimeAtClientX, focusTimeline: () => timelineRef.current?.focus(), snapEnabled, getSnapPointsMs: (clipId) => timelineSnapPoints(props.timelineState, props.cues, props.frameRate, viewport.pixelsPerSecond, props.playheadMs, { kind: 'clip', id: clipId }), snapThresholdMs });
  const cueResize = useCueResize({ durationMs: 86_399_000, frameRate: props.frameRate, onTrimCue: props.onTrimCue, onSelectCue: props.onSelectCue, timeAtClientX: viewport.editTimeAtClientX, focusTimeline: () => timelineRef.current?.focus(), snapEnabled, getSnapPointsMs: (cueId) => timelineSnapPoints(props.timelineState, props.cues, props.frameRate, viewport.pixelsPerSecond, props.playheadMs, { kind: 'cue', id: cueId }), snapThresholdMs });
  const movingItem = itemDrag.drag;
  const movingDuration = movingItem?.kind === 'clip' ? props.clips.find((clip) => clip.id === movingItem.id)?.durationMs ?? 0
    : displayedSceneDuration(props.cues.find((cue) => cue.id === movingItem?.id), viewport.pixelsPerSecond);
  const snapGuide = snapEnabled && movingItem?.moved
    ? [0, props.durationMs, ...timelineSnapPoints(props.timelineState, props.cues, props.frameRate, viewport.pixelsPerSecond, props.playheadMs, movingItem)]
      .find((point) => Math.abs(point - movingItem.previewMs) < 1 || Math.abs(point - movingItem.previewMs - movingDuration) < 1)
    : undefined;
  const { playheadLeft, contentStyle, headingStyle, waveformContentWidth } = timelineLayout(props, viewport.contentWidth, viewport.pixelsPerSecond, viewport.gridSize);
  const { activeClipIds, activeCueIds, clipSpans, visualCueSpans } = useResolvedPresentation(props.timelineState);
  useDismissContext(clipContext !== null, () => setClipContext(null));
  useEffect(() => {
    setClipboard(null);
    setClipContext(null);
  }, [props.timelineState.itemId]);
  useEffect(() => {
    if (props.playing) revealTimelineTime(props.playheadMs);
  }, [props.playheadMs, props.playing, revealTimelineTime]);

  const seekTo = (milliseconds: number, updateAudio: boolean): number => {
    const next = snap(props, milliseconds, snapEnabled, seekSnapPointsMs, snapThresholdMs);
    props.onPlayheadChange(next);
    if (!props.externalTransport && updateAudio && audioRef.current) audioRef.current.currentTime = next / 1_000;
    revealTimelineTime(next);
    return next;
  };
  const seek = (clientX: number, updateAudio: boolean): number => {
    const milliseconds = viewport.timeAtClientX(clientX);
    return seekTo(milliseconds, updateAudio);
  };
  const beginPlayhead = (event: PointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return;
    props.onPlayingChange(false);
    timelineRef.current?.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    playheadPointerId.current = event.pointerId;
    seek(event.clientX, true);
  };
  const movePlayhead = (event: PointerEvent<HTMLElement>): void => {
    if (playheadPointerId.current === event.pointerId) seek(event.clientX, true);
  };
  const endPlayhead = (event: PointerEvent<HTMLElement>): void => {
    if (playheadPointerId.current !== event.pointerId) return;
    seek(event.clientX, true);
    playheadPointerId.current = null;
  };
  const cancelPlayhead = (event: PointerEvent<HTMLElement>): void => {
    if (playheadPointerId.current === event.pointerId) playheadPointerId.current = null;
  };
  const dropVisual = (event: DragEvent<HTMLElement>, layer?: VisualLayer): void => {
    event.preventDefault();
    event.stopPropagation();
    const startMs = snap(props, viewport.timeAtClientX(event.clientX), snapEnabled, timelineSnapPoints(props.timelineState, props.cues, props.frameRate, viewport.pixelsPerSecond, props.playheadMs), snapThresholdMs);
    const assetId = event.dataTransfer.getData(MEDIA_DRAG_TYPE);
    if (assetId) {
      props.onDropAsset(assetId, startMs, layer?.id ?? null);
      return;
    }
    const value = event.dataTransfer.getData(OBS_DRAG_TYPE);
    if (value) props.onDropObsResource(parseObsResource(value), startMs, layer?.id ?? null);
  };
  const lanePointer = { onPointerDown: beginPlayhead, onPointerMove: movePlayhead, onPointerUp: endPlayhead, onPointerCancel: cancelPlayhead };
  const beginVisualDrag = (event: PointerEvent<HTMLButtonElement>, kind: TimelineDrag['kind'], id: string, originMs: number): void => {
    itemDrag.begin(event, kind, id, originMs);
  };
  const deleteSelected = (): void => deleteTimelineSelection(props);

  return <section
    className="reference-timeline panel"
    onContextMenu={(event) => { if (event.defaultPrevented || !(event.target instanceof Element) || !event.target.closest('.timeline-lane')) return; event.preventDefault(); setClipContext({ target: null, x: event.clientX, y: event.clientY }); }}
    data-duration-ms={props.durationMs}
    ref={timelineRef}
    tabIndex={0}
    onKeyDown={(event) => handleTimelineKeyDown(event, props, clipboard, setClipboard, (milliseconds) => seekTo(milliseconds, true), deleteSelected)}
  >
    <TimelineToolbar editPoints={seekSnapPointsMs} snapDistance={snapDistance} onSnapDistanceChange={setSnapDistance} externalTransport={props.externalTransport} onStop={props.onStop} recordingControl={props.lighting ? <><details className="timeline-lighting-tools"><summary>灯光</summary><div>{([['tempo', '节拍与循环'], ['files', '导入与导出'], ['sync', '节目同步']] as const).map(([tool, label]) => <button key={tool} onClick={(event) => { const menu = event.currentTarget.closest('details'); if (menu) menu.open = false; props.lighting?.onOpenTools?.(tool); }}>{label}</button>)}</div></details><TimelineLightingRecording audioAvailable={Boolean(props.referenceAudio)} document={props.lighting.document} clipId={props.lighting.selectedClipId} audioRef={audioRef} playheadMs={props.playheadMs} onChange={props.lighting.onChange} onError={props.onPlaybackError} /></> : null} playbackReady={lightingReady} frameRate={props.frameRate} durationMs={props.durationMs} playheadMs={props.playheadMs} playing={props.playing} referenceAudio={props.referenceAudio} snapEnabled={snapEnabled} audioRef={audioRef} onPlayheadChange={props.onPlayheadChange} onPlayingChange={props.onPlayingChange} onPlaybackError={props.onPlaybackError} onSnapEnabledChange={setSnapEnabled} onZoomOut={viewport.zoomOut} onFit={viewport.fit} onZoomIn={viewport.zoomIn} />
    <div className="timeline-shell">
      <div className="timeline-track-headings" style={headingStyle}>
        <div className="track-heading time-heading"><span>时间</span><small>{props.frameRate} fps</small></div>
        {props.audioEditor?.tracks.length ? props.audioEditor.tracks.map(track => <div className="track-heading" key={track.id}><Music2 /><button className="audio-track-edit" title={track.title} onClick={() => { props.audioEditor?.trackEditor(track).select(track.segments[0]!.id); props.onSelectAudio?.(track.segments[0]!.id); }}>{track.title}</button><button title={`删除音轨 ${track.title}`} disabled={props.audioEditor?.disabled} onClick={() => void props.audioEditor?.removeTrack(track.id)}><Trash2 /></button></div>) : <TrackHeading icon={Music2} label="歌曲音频" onClick={() => props.onSelectAudio?.()} />}
        {props.layers.map((layer, index) => <TimelineLayerHeading key={layer.id} layer={layer} index={index}
          dragging={layerReorder.drag?.layerId === layer.id}
          dropTarget={layerReorder.drag !== null && layerReorder.drag.targetIndex === index}
          onDragBegin={layerReorder.begin} onDragMove={layerReorder.move}
          onDragEnd={layerReorder.end} onDragCancel={layerReorder.cancel}
          onUpdateLayer={props.onUpdateLayer}
          onDeleteLayer={props.onDeleteLayer}
        />)}
        {props.lighting ? <LightingHeadings {...props.lighting} durationMs={props.durationMs} /> : null}
        <div className="timeline-new-layer-heading" />
      </div>
      <div className="timeline-viewport" ref={viewport.viewportRef} onScroll={viewport.onScroll}>
        <div className="timeline-content" style={contentStyle}>
          {snapGuide !== undefined ? <div className="timeline-snap-guide" style={{ left: snapGuide / 1000 * viewport.pixelsPerSecond }}><span>已吸附</span></div> : null}
          <div className="timeline-ruler" {...lanePointer}>
            {viewport.ticks.map((tick) => <span key={tick.milliseconds} style={{ left: tick.left }}>{tick.label}</span>)}
            <strong className="timeline-current-time" style={{ left: Math.min(Math.max(playheadLeft, viewport.scrollLeft + 46), viewport.scrollLeft + viewport.viewportWidth - 46), visibility: playheadLeft < viewport.scrollLeft || playheadLeft > viewport.scrollLeft + viewport.viewportWidth ? 'hidden' : 'visible' }}>{formatTimelineTimecode(props.playheadMs, props.frameRate)}</strong>
            {props.lighting ? <TimelineMarkers {...props.lighting} pixelsPerSecond={viewport.pixelsPerSecond} timeAtClientX={viewport.editTimeAtClientX} onSeek={(ms) => { props.onPlayheadChange(ms); if (!props.externalTransport && audioRef.current) audioRef.current.currentTime = ms / 1000; }} /> : null}
          </div>
          {props.audioEditor?.tracks.length ? props.audioEditor.tracks.map(track => <AudioTrackLane key={track.id} track={track} snapTime={ms => snap(props, ms, snapEnabled, seekSnapPointsMs, snapThresholdMs)} editor={props.audioEditor!} projectPath={props.projectPath} pixelsPerSecond={viewport.pixelsPerSecond} scrollLeft={viewport.scrollLeft} viewportWidth={viewport.viewportWidth} onSelect={id => props.onSelectAudio?.(id)} onSeek={ms => seekTo(ms, true)} />) : <div className="timeline-lane waveform-lane" {...lanePointer}>
            {!props.audioEditor && waveform.peaks.length > 0 ? <TimelineWaveformCanvas
              peaks={waveform.peaks}
              scrollLeft={viewport.scrollLeft}
              viewportWidth={viewport.viewportWidth}
              contentWidth={waveformContentWidth}
            /> : waveform.peaks.length ? null : <span className={waveform.error ? 'timeline-lane-error' : 'timeline-lane-empty'}>{waveform.error ?? (props.referenceAudio ? '正在生成歌曲音频波形…' : '尚未为当前节目添加音频')}</span>}
            {props.audioEditor ? <AudioTimelineSegments editor={props.audioEditor} peaks={waveform.peaks} scrollLeft={viewport.scrollLeft} viewportWidth={viewport.viewportWidth} pixelsPerSecond={viewport.pixelsPerSecond} onSelect={(id) => props.onSelectAudio?.(id)} onSeek={(ms) => seekTo(ms, true)} /> : null}
          </div>}
          <TimelineVisualLayers layers={props.layers} clips={props.clips} cues={props.cues} assets={assets} clipSpans={clipSpans} frameRate={props.frameRate} pixelsPerSecond={viewport.pixelsPerSecond} selectedClipId={props.selectedClipId} selectedCueId={props.selectedCueId} activeClipIds={activeClipIds} activeCueIds={activeCueIds} visualCueSpans={visualCueSpans} drag={itemDrag.drag} resizeDrag={clipResize.drag} cueResizeDrag={cueResize.drag} lanePointer={lanePointer} onDrop={dropVisual} onBeginDrag={beginVisualDrag} onMoveDrag={itemDrag.move} onEndDrag={itemDrag.end} onCancelDrag={itemDrag.cancel} onTrimBegin={clipResize.begin} onTrimMove={clipResize.move} onTrimEnd={clipResize.end} onTrimCancel={clipResize.cancel} onCueTrimBegin={cueResize.begin} onCueTrimMove={cueResize.move} onCueTrimEnd={cueResize.end} onCueTrimCancel={cueResize.cancel} onSelectClip={props.onSelectClip} onSelectCue={props.onSelectCue} onOpenCueMenu={(event, target) => setClipContext({ target: { kind: 'cue', id: target.id }, x: event.clientX, y: event.clientY })} onOpenClipMenu={(event, target) => setClipContext({ target: { kind: 'clip', id: target.id }, x: event.clientX, y: event.clientY })} />
          {props.lighting ? <LightingLanes {...props.lighting} snapTime={(ms) => snap(props, ms, snapEnabled, props.audioEditor?.points ?? [], snapThresholdMs)} getPlaybackPosition={() => props.playing && audioRef.current ? audioRef.current.currentTime * 1000 : props.playheadMs} scrollLeft={viewport.scrollLeft} viewportWidth={viewport.viewportWidth} playheadMs={props.playheadMs} timeAtClientX={viewport.editTimeAtClientX} onSeek={(ms) => { props.onPlayheadChange(ms); if (!props.externalTransport && audioRef.current) audioRef.current.currentTime = ms / 1000; }} pixelsPerSecond={viewport.pixelsPerSecond} /> : null}
          <TimelineNewLayerDrop active={itemDrag.drag?.targetLayerId === null} onDrop={(event) => dropVisual(event)} />
          {props.referenceAudio ? <div className="timeline-audio-end" style={{ left: props.referenceAudio.durationMs / 1000 * viewport.pixelsPerSecond }}><span>音频结束{props.durationMs > props.referenceAudio.durationMs ? ` · 内容超出 ${((props.durationMs - props.referenceAudio.durationMs) / 1000).toFixed(2)} 秒` : ''}</span></div> : null}
          {props.referenceAudio && props.durationMs > props.referenceAudio.durationMs ? <div className="timeline-audio-overrun" aria-label="内容超出音频范围" style={{ left: props.referenceAudio.durationMs / 1000 * viewport.pixelsPerSecond, width: (props.durationMs - props.referenceAudio.durationMs) / 1000 * viewport.pixelsPerSecond }} /> : null}
          {props.audioEditor?.points.filter((ms) => ms / 1000 * viewport.pixelsPerSecond >= viewport.scrollLeft && ms / 1000 * viewport.pixelsPerSecond <= viewport.scrollLeft + viewport.viewportWidth).map((ms) => <span key={ms} className="timeline-beat-guide" style={{ left: ms / 1000 * viewport.pixelsPerSecond }} />)}
          <span className="timeline-playhead" style={{ left: playheadLeft }} />
        </div>
      </div>
    </div>
    {clipContext ? <TimelineContextMenu context={clipContext} clipboard={clipboard} clips={props.clips} cues={props.cues} layers={props.layers} frameRate={props.frameRate} playheadMs={props.playheadMs} actions={props} onCopy={setClipboard} onSeek={(ms) => seekTo(ms, true)} onClose={() => { setClipContext(null); timelineRef.current?.focus(); }} /> : null}
  </section>;
}

function handleTimelineKeyDown(
  event: KeyboardEvent<HTMLElement>,
  props: Props,
  clipboard: TimelineTarget | null,
  setClipboard: (target: TimelineTarget | null) => void,
  seekTo: (milliseconds: number) => void,
  deleteSelected: () => void
): void {
  if (isInteractiveTarget(event.target)) return;
  const command = event.ctrlKey || event.metaKey;
  // Lighting owns its event clipboard. A previously copied media clip must
  // not be pasted when a lighting clip is currently selected.
  if (command && props.lighting?.selectedClipId && ['c', 'x', 'v'].includes(event.key.toLowerCase())) return;
  if (event.code === 'Space') {
    event.preventDefault();
    if (!props.playing && props.playheadMs >= (props.referenceAudio?.durationMs ?? props.durationMs)) seekTo(0);
    props.onPlayingChange(!props.playing);
    return;
  }
  if (event.key === 'Home') {
    event.preventDefault();
    props.onPlayingChange(false);
    seekTo(0);
    return;
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    props.onPlayingChange(false);
    const direction = event.key === 'ArrowLeft' ? -1 : 1;
    const framesPerSecond = playbackFramesPerSecond(props.frameRate);
    seekTo(props.playheadMs + direction * (event.shiftKey ? 1_000 : 1_000 / framesPerSecond));
    return;
  }
  if (command && event.key.toLowerCase() === 'c' && (props.selectedClipId || props.selectedCueId)) {
    event.preventDefault();
    setClipboard(props.selectedClipId ? { kind: 'clip', id: props.selectedClipId } : { kind: 'cue', id: props.selectedCueId! });
    return;
  }
  if (command && event.key.toLowerCase() === 'v' && clipboard) {
    event.preventDefault();
    if (clipboard.kind === 'clip') props.onDuplicateClip(clipboard.id, props.playheadMs);
    else props.onDuplicateCue(clipboard.id, props.playheadMs);
    return;
  }
  if (command && event.key.toLowerCase() === 'd' && props.selectedClipId) {
    event.preventDefault();
    const source = props.clips.find((clip) => clip.id === props.selectedClipId);
    if (source) props.onDuplicateClip(source.id, resolveTimelineClipSpan(source, props.frameRate).endMs);
    return;
  }
  if (command && event.key.toLowerCase() === 'd' && props.selectedCueId) {
    event.preventDefault();
    const source = props.cues.find((cue) => cue.id === props.selectedCueId);
    if (source) props.onDuplicateCue(source.id, timecodeToMilliseconds(source.timecode, props.frameRate) + (source.durationMs ?? 0));
    return;
  }
  if (event.key.toLowerCase() === 's' && props.selectedClipId) {
    event.preventDefault();
    props.onSplitClip(props.selectedClipId, props.playheadMs);
    return;
  }
  if (event.key === 'Delete') {
    event.preventDefault();
    deleteSelected();
  }
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('.timeline-clip, .timeline-cue, .timeline-media-waveform')) return false;
  return ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'AUDIO'].includes(target.tagName);
}

function snap(
  props: Pick<Props, 'durationMs' | 'frameRate'>,
  milliseconds: number,
  enabled: boolean,
  snapPointsMs: readonly number[],
  snapThresholdMs: number
): number {
  return timelineInteractionTime(milliseconds, props.durationMs, props.frameRate, enabled, snapPointsMs, snapThresholdMs);
}


function TrackHeading({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick?: (() => void) | undefined }): JSX.Element {
  return <div className="track-heading"><Icon />{onClick ? <button className="audio-track-edit" title="音频编辑与自动节拍" onClick={onClick}>{label}</button> : <span>{label}</span>}</div>;
}

