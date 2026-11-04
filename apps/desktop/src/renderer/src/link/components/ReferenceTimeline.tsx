import { useAutomaticMusicAnalysis } from '../runtime/use-automatic-music-analysis';
import { MusicBeatMarkers } from './MusicBeatMarkers';
import { useMusicBeatSegments } from './useMusicBeatSegments';
import { usePlayheadTimeLabel } from './usePlayheadTimeLabel';
import { useAudioRowHeight } from './useAudioRowHeight';
import { useTimelineStamp } from './useTimelineStamp';
import { TimelinePanelButton } from './TimelinePanelButton';
import { Field, IconButton, MenuButton, MenuItem, Select } from '../ui';
import { useTimelineWheelSeek } from './useTimelineWheelSeek';
import { AudioRowResizeHandle } from './AudioRowResizeHandle';
import { LightingTimelineControls, type LightingTimelineDisplay } from './LightingTimelineControls';
import '../lighting-music.css';
import '../lighting-timeline.css';
import { LightingMusicSectionRow } from './LightingMusicSections';
import { WaveformCuePoints } from './WaveformCuePoints';
import { lightingMaterialDropHandlers, type ConsoleCueDrag } from './lighting-material-drag';
import { useFrameValue } from './useFrameValue';
import { AudioTimelineSegments } from './AudioTimelineSegments';
import { AudioTrackLane } from './AudioTrackLane';
import type { AudioEditor } from './useAudioEditor';
import { lightingSnapPoints, timelineSnapPoints } from './timeline-snap-points';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { useTimelineAudio, type PlaybackClock } from './useTimelineAudio';
import {
  playbackFramesPerSecond,
  resolveTimelineClipSpan,
  timecodeToMilliseconds,
  type ContentRef,
  type ResolvedTimelineState
} from '@tb/core/link';
import type { LinkCue, LinkMediaAsset, MtcFrameRate, ReferenceMediaClip, VisualLayer } from '@tb/schema';
import { Music2, Trash2, MousePointer2, SquareDashedMousePointer, AudioLines, ArrowLeftRight, FolderInput, Gauge, type LucideIcon } from 'lucide-react';
import type { LightingTool } from './LightingTimelineTools';
import type { ObsResource } from './ResourceLibrary';
import { TimelineWaveformCanvas, useReferenceWaveformPeaks, type ReferenceWaveformSource } from './ReferenceWaveform';
import { formatTimelineTimecode, timelineInteractionTime } from './timeline-geometry';
import { TimelineContextMenu, type TimelineContext, type TimelineTarget } from './TimelineContextMenu';
import { TimelineToolbar } from './TimelineToolbar';
import { TimelineLightingRecording } from './LightingRecordingControls';
import { TimelineLayerHeading } from './TimelineLayerHeading';
import { ContentTracks, type ContentEditRules } from './ContentTracks';
import type { Airtime } from './timeline-air';
import { useLayerReorder } from './useLayerReorder';
import { useTimelineViewport } from './useTimelineViewport';
import { timelineLayout, timelineMusicLayout, timelineRulerHeight } from './timeline-layout';
import { LightingHeadings, LightingLanes, type LightingTimelineProps } from './LightingTimeline';
import { TimelineMarkers } from './TimelineMarkers';
import { useLightingPreview } from '../runtime/use-lighting-preview';

function seekTimelineAudio(audio: HTMLAudioElement, milliseconds: number): void {
  const seconds = Number.isFinite(audio.duration) ? Math.min(milliseconds / 1_000, audio.duration) : milliseconds / 1_000;
  // Reassigning the same end position queues another seek/ended cycle.
  if (Math.abs(audio.currentTime - seconds) > 0.001) audio.currentTime = seconds;
}

/** The 灯光 menu on the toolbar; the lighting workbench shows tempo in its own panel. */
const lightingTools: ReadonlyArray<readonly [LightingTool, string, LucideIcon]> = [['tempo', '节拍与循环', Gauge], ['files', '导入与导出', FolderInput], ['sync', '节目同步', ArrowLeftRight]];

type Props = {
  analysisPanel?: import('./LightingTimelineControls').MusicAnalysisHost | undefined;
  transportStatus?: import('react').ReactNode;
  outputControl?: import('react').ReactNode;
  lightingWorkspace?: boolean;
  onEffectDrop?: ((effectId: string, ms: number) => void) | undefined;
  onConsoleCueDrop?: ((reference: ConsoleCueDrag, ms: number) => void) | undefined;
  audioRowHeight?: number;
  audioEditor?: AudioEditor;
  onSelectAudio?: (id?: string) => void;
  externalTransport?: boolean;
  transportClock?: PlaybackClock | undefined;
  onStop?: () => void;
  lighting?: LightingTimelineProps;
  projectPath: string | null;
  assets: LinkMediaAsset[];
  clips: ReferenceMediaClip[];
  cues: LinkCue[];
  layers: VisualLayer[];
  timelineState: ResolvedTimelineState;
  /** What the output shows of each clip and camera (SceneOutputTimeline.airtime). */
  airtime: Airtime;
  editRules: ContentEditRules;
  frameRate: MtcFrameRate;
  durationMs: number;
  playheadMs: number;
  referenceAudio: ReferenceWaveformSource | null;
  analysisSource?: import('@tb/schema').ReferenceAudio | undefined;
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
  onTrim: (ref: ContentRef, startMs: number, durationMs: number) => void;
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

function deleteTimelineSelection(props: Props): void {
  if (!props.lightingWorkspace && props.audioEditor?.selected) { if (!props.audioEditor.disabled) void props.audioEditor.remove(); return; }
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

export function ReferenceTimeline(input: Props): JSX.Element {
  const { timelineRef, cueMouseMode, setCueMouseMode, props, layers, audioHeight, setAudioHeight, waveformGain, waveformMode, setWaveformMode } = useTimelineDisplay(input);
  const analysis = useAutomaticMusicAnalysis(props.lightingWorkspace ? props.projectPath : null, props.lightingWorkspace ? props.analysisSource : undefined);
  const [musicDisplay, setMusicDisplay] = useState<LightingTimelineDisplay>({ sections: true, markers: true, rawAnalysis: true });
  const beatSegments = useMusicBeatSegments(props.lightingWorkspace ? props.lighting : undefined, props.analysisSource, analysis, `${props.projectPath}:${props.timelineState.itemId}:${props.analysisSource?.sha256}:${props.analysisSource?.durationMs}`, props.projectPath, props.playing);
  const assets = useMemo(() => new Map(props.assets.map((asset) => [asset.id, asset])), [props.assets]);
  const waveform = useReferenceWaveformPeaks(props.referenceAudio);

  const { audioRef, clock } = useTimelineAudio(props.externalTransport, props.transportClock);
  const wheelSeek = useTimelineWheelSeek(props, audioRef);
  const showPlayheadTime = usePlayheadTimeLabel(timelineRef);
  const viewport = useTimelineViewport(props.durationMs, props.lightingWorkspace ? 220 : undefined, props.lightingWorkspace ? wheelSeek.seek : undefined, props.lightingWorkspace ? props.referenceAudio?.sha256 ?? 'no-audio' : undefined, props.playheadMs);
  const revealTimelineTime = viewport.revealTime;
  const lightingPlayback = useLightingPreview({ enabled: (props.lightingWorkspace === true || (props.lighting?.preview ?? false)) && !props.externalTransport, document: props.lighting?.document, mtcOrigin: props.lighting?.mtcOrigin, audioRef, playing: props.playing && !props.externalTransport, frameRate: props.frameRate, onError: (message) => { props.onPlayingChange(false); props.onPlaybackError(message); } });
  const stopPlayback = (): void => { props.onStop?.(); void lightingPlayback.stop().catch((error: unknown) => props.onPlaybackError(error instanceof Error ? error.message : String(error))); };
  const playheadPointerId = useRef<number | null>(null);
  const [clipboard, setClipboard] = useState<TimelineTarget | null>(null);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [snapDistance, setSnapDistance] = useState(14);
  const [clipContext, setClipContext] = useState<TimelineContext | null>(null);
  const layerReorder = useLayerReorder(layers.length, (id, index) => { const target = layers[index]; if (target) input.onMoveLayer(id, input.layers.findIndex((layer) => layer.id === target.id)); });
  const seekSnapPointsMs = useMemo(() => props.lightingWorkspace ? lightingSnapPoints(props.lighting?.document, beatSegments.snapPoints, props.referenceAudio?.durationMs ?? props.durationMs) : [...timelineSnapPoints(props.timelineState, props.cues, props.frameRate), ...(props.audioEditor?.points ?? [])], [beatSegments.snapPoints, props.lightingWorkspace, props.lighting?.document, props.referenceAudio?.durationMs, props.durationMs, props.cues, props.frameRate, props.timelineState, props.audioEditor?.points]);
  const snapThresholdMs = snapDistance / viewport.pixelsPerSecond * 1_000;
  const musicRow = musicDisplay.sections && beatSegments.points.length > 0;
  const { sectionRow, rulerHeight } = timelineMusicLayout({ ...props, musicRow }, musicDisplay);
  const { playheadLeft, contentStyle, headingStyle, waveformContentWidth, visualTracks } = timelineLayout({ ...props, sectionRow, musicRow }, viewport.contentWidth, viewport.pixelsPerSecond, viewport.gridSize);
  useEffect(() => {
    if (props.playing) revealTimelineTime(props.playheadMs);
  }, [props.playheadMs, props.playing, revealTimelineTime]);

  const seekTo = (milliseconds: number, updateAudio: boolean, snapToEdges = true): number => {
    const next = snap(props, milliseconds, snapEnabled, snapToEdges ? seekSnapPointsMs : [], snapToEdges ? snapThresholdMs : 0);
    props.onPlayheadChange(next);
    if (!props.externalTransport && updateAudio && audioRef.current) seekTimelineAudio(audioRef.current, next);
    revealTimelineTime(next);
    return next;
  };
  const seek = (clientX: number, updateAudio: boolean): number => {
    const milliseconds = viewport.timeAtClientX(clientX);
    return seekTo(milliseconds, updateAudio);
  };
  const playheadFrame = useFrameValue((clientX: number) => { seek(clientX, true); });
  const cancelPlayheadFrame = playheadFrame.cancel;
  useEffect(() => { cancelPlayheadFrame(); playheadPointerId.current = null; setClipboard(null); setClipContext(null); }, [props.timelineState.itemId, cancelPlayheadFrame]);
  const beginPlayhead = (event: PointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return;
    props.onPlayingChange(false);
    timelineRef.current?.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    playheadPointerId.current = event.pointerId;
    playheadFrame.flush(event.clientX);
  };
  const movePlayhead = (event: PointerEvent<HTMLElement>): void => {
    if (playheadPointerId.current === event.pointerId) playheadFrame.push(event.clientX);
  };
  const endPlayhead = (event: PointerEvent<HTMLElement>): void => {
    if (playheadPointerId.current !== event.pointerId) return;
    playheadFrame.flush(event.clientX);
    playheadPointerId.current = null;
  };
  const cancelPlayhead = (event: PointerEvent<HTMLElement>): void => {
    if (playheadPointerId.current === event.pointerId) { playheadFrame.cancel(); playheadPointerId.current = null; }
  };
  const lanePointer = { onPointerDown: beginPlayhead, onPointerMove: movePlayhead, onPointerUp: endPlayhead, onPointerCancel: cancelPlayhead };

  const stamping = useTimelineStamp({ lighting: props.lightingWorkspace ? props.lighting : undefined, playheadMs: props.playheadMs, durationMs: props.referenceAudio?.durationMs ?? props.durationMs, playing: props.playing, frameRate: props.frameRate, clock, onPlayingChange: props.onPlayingChange, onSeek: ms => seekTo(ms, true) });


  return <section
    className="reference-timeline panel"
    data-lighting-timeline={props.lightingWorkspace === true} style={{ '--waveform-gain': waveformGain } as CSSProperties}
    onContextMenu={(event) => { if (event.defaultPrevented || !(event.target instanceof Element) || !event.target.closest('.timeline-lane')) return; event.preventDefault(); setClipContext({ target: null, x: event.clientX, y: event.clientY }); }}
    onContextMenuCapture={event => { if (!props.lightingWorkspace || !(event.target instanceof Element) || !event.target.closest('.waveform-lane,.waveform-cue-points') || event.target.closest('.waveform-cue-point,.effect-binding-backdrop')) return; event.preventDefault(); event.stopPropagation(); stamping.stamp(viewport.editTimeAtClientX(event.clientX)); }}
    data-duration-ms={props.durationMs} data-waveform-mode={waveformMode}
    ref={timelineRef} data-playhead-time={showPlayheadTime}
    tabIndex={0}
    onKeyDown={(event) => handleTimelineKeyDown(event, props, clipboard, setClipboard, (milliseconds) => seekTo(milliseconds, true, false), () => deleteTimelineSelection(props), stopPlayback)}
  >
    <div><TimelineToolbar displayControl={props.lightingWorkspace && props.lighting ? <LightingTimelineControls playheadMs={props.playheadMs} beats={beatSegments} analysisPanel={props.analysisPanel} analysis={analysis} onChange={props.lighting.onChange} onSeek={ms => { viewport.revealTime(ms); seekTo(ms, true, false); }} projectPath={props.projectPath} source={props.analysisSource} playing={props.playing} document={props.lighting.document} display={musicDisplay} onDisplayChange={setMusicDisplay} /> : undefined} outputControl={props.outputControl} stampControls={stamping.controls} wheelSeek={props.lightingWorkspace ? wheelSeek : undefined} compact={props.lightingWorkspace === true} tools={props.lightingWorkspace ? <><div className="cue-mouse-modes" role="group" aria-label="鼠标模式"><IconButton label="定位" title="定位：点击或拖动波形、标尺" icon={MousePointer2} aria-pressed={cueMouseMode === 'seek'} onClick={() => setCueMouseMode('seek')} /><IconButton label="框选 Cue" title="框选 Cue：拖动框选，Delete 删除" icon={SquareDashedMousePointer} aria-pressed={cueMouseMode === 'select'} onClick={() => setCueMouseMode('select')} /></div><TimelinePanelButton label="波形显示方式" icon={AudioLines}><Field stacked label="波形显示方式">{(field) => <Select {...field} value={waveformMode} onChange={event => setWaveformMode(event.currentTarget.value)}><option value="rhythm">节奏波形</option><option value="waveform">原始波形</option><option value="spectrum">频谱</option></Select>}</Field></TimelinePanelButton></> : undefined} editPoints={seekSnapPointsMs} snapDistance={snapDistance} onSnapDistanceChange={setSnapDistance} externalTransport={props.externalTransport} onStop={props.onStop ? stopPlayback : undefined} recordingControl={props.lighting ? <><MenuButton label="灯光" menuLabel="灯光工具" className="timeline-lighting-tools">{(close) => lightingTools.filter(([tool]) => !props.lightingWorkspace || tool !== 'tempo').map(([tool, label, icon]) => <MenuItem key={tool} icon={icon} onSelect={() => { close(); props.lighting?.onOpenTools?.(tool); }}>{label}</MenuItem>)}</MenuButton><TimelineLightingRecording audioAvailable={Boolean(props.referenceAudio)} document={props.lighting.document} clipId={props.lighting.selectedClipId} clock={clock} playheadMs={props.playheadMs} onChange={props.lighting.onChange} onError={props.onPlaybackError} /></> : null} playbackReady={lightingPlayback.ready} frameRate={props.frameRate} durationMs={props.durationMs} playheadMs={props.playheadMs} playing={props.playing} referenceAudio={props.referenceAudio} snapEnabled={snapEnabled} audioRef={audioRef} onPlayheadChange={ms => { if (props.playing) props.onPlayheadChange(ms); else seekTo(ms, true, false); }} onPlayingChange={props.onPlayingChange} onPlaybackError={props.onPlaybackError} onSnapEnabledChange={setSnapEnabled} onZoomOut={viewport.zoomOut} onFit={viewport.fit} onZoomIn={viewport.zoomIn} />

    {props.transportStatus}</div><div className="timeline-shell">
      <div className="timeline-heading-viewport" ref={viewport.headingViewportRef} onWheel={viewport.onHeadingsWheel}><div className="timeline-track-headings" style={headingStyle}>
        <div className="track-heading time-heading"><span>时间</span><small>{props.frameRate} fps</small></div>
        {props.audioEditor?.tracks.length ? props.audioEditor.tracks.map(track => <div className="track-heading" key={track.id}><Music2 />{props.lightingWorkspace ? <span>{track.title}</span> : <><button className="audio-track-edit" title={track.title} onClick={() => { props.audioEditor?.trackEditor(track).select(track.segments[0]!.id); props.onSelectAudio?.(track.segments[0]!.id); }}>{track.title}</button><button title={`删除音轨 ${track.title}`} disabled={props.audioEditor?.disabled} onClick={() => void props.audioEditor?.removeTrack(track.id)}><Trash2 /></button></>}</div>) : <TrackHeading icon={Music2} label="歌曲音频" onClick={props.lightingWorkspace ? undefined : () => props.onSelectAudio?.()} />}
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
      </div></div>
      <div className="timeline-viewport" ref={viewport.viewportRef} onScroll={viewport.onScroll}>
        <div className="timeline-content" style={contentStyle} {...lightingMaterialDropHandlers({ onEffectDrop: props.onEffectDrop, onConsoleCueDrop: props.onConsoleCueDrop, onError: props.onPlaybackError, timeAtClientX: x => snap(props, viewport.editTimeAtClientX(x), snapEnabled, seekSnapPointsMs, snapThresholdMs) })}>
          {props.lightingWorkspace && props.lighting ? <WaveformCuePoints frameRate={props.frameRate} mode={cueMouseMode} height={audioHeight} lighting={{ ...props.lighting, snapTime: (ms, excludedId) => snap(props, ms, snapEnabled, lightingSnapPoints(props.lighting?.document, beatSegments.snapPoints, props.referenceAudio?.durationMs ?? props.durationMs, excludedId), snapThresholdMs) }} pixelsPerSecond={viewport.pixelsPerSecond} top={rulerHeight} scrollLeft={viewport.scrollLeft} viewportWidth={viewport.viewportWidth} durationMs={props.referenceAudio?.durationMs ?? props.durationMs} disabled={false} /> : null}
          {props.lightingWorkspace ? <AudioRowResizeHandle height={audioHeight} rulerHeight={rulerHeight} onChange={setAudioHeight} /> : null}
          <div className="timeline-ruler" data-sections={sectionRow} data-music={musicRow} {...lanePointer}>
            {sectionRow && props.lighting ? <LightingMusicSectionRow onChange={props.lighting.onChange} candidates={undefined} document={props.lighting.document} left={viewport.scrollLeft} width={viewport.viewportWidth} pixelsPerSecond={viewport.pixelsPerSecond} onSeek={ms => { if (!props.playing) seekTo(ms, true, false); }} /> : null}
            {viewport.ticks.filter(() => props.lightingWorkspace || props.lighting?.document.music?.ruler !== 'beats').filter(tick => !props.lightingWorkspace || Math.round(tick.left / viewport.gridSize) % Math.ceil(104 / viewport.gridSize) === 0).map((tick) => <span key={tick.milliseconds} style={{ left: tick.left }}>{props.lightingWorkspace ? formatTimelineTimecode(tick.milliseconds, props.frameRate) : tick.label}</span>)}
            <strong className="timeline-current-time" style={{ left: Math.min(Math.max(playheadLeft, viewport.scrollLeft + (props.lightingWorkspace ? 60 : 46)), viewport.scrollLeft + viewport.viewportWidth - (props.lightingWorkspace ? 60 : 46)), visibility: playheadLeft < viewport.scrollLeft || playheadLeft > viewport.scrollLeft + viewport.viewportWidth ? 'hidden' : 'visible' }}>{formatTimelineTimecode(props.playheadMs, props.frameRate)}</strong>
            {props.lighting && (!props.lightingWorkspace || musicDisplay.markers) ? <TimelineMarkers {...props.lighting} hideAnalysis={props.lightingWorkspace === true} pixelsPerSecond={viewport.pixelsPerSecond} timeAtClientX={viewport.editTimeAtClientX} onSeek={(ms) => { props.onPlayheadChange(ms); if (!props.externalTransport && audioRef.current) audioRef.current.currentTime = ms / 1000; }} /> : null}
            {props.lightingWorkspace ? <MusicBeatMarkers beats={beatSegments} left={viewport.scrollLeft} width={viewport.viewportWidth} pixelsPerSecond={viewport.pixelsPerSecond} top={sectionRow ? 24 : 0} rulerHeight={rulerHeight} showSegments={musicDisplay.sections} showBeats={musicDisplay.rawAnalysis} disabled={props.playing} onSeek={ms => seekTo(ms, true, false)} /> : null}
          </div>
          {props.audioEditor?.tracks.length ? props.audioEditor.tracks.map(track => <AudioTrackLane readOnly={props.lightingWorkspace === true} referencePointer={props.lightingWorkspace ? lanePointer : undefined} playheadMs={props.playheadMs} detailed={props.lightingWorkspace === true} rhythm={props.lightingWorkspace === true && waveformMode === 'rhythm'} key={track.id} track={track} snapTime={ms => snap(props, ms, snapEnabled, seekSnapPointsMs, snapThresholdMs)} editor={props.audioEditor!} projectPath={props.projectPath} pixelsPerSecond={viewport.pixelsPerSecond} scrollLeft={viewport.scrollLeft} viewportWidth={viewport.viewportWidth} onSelect={id => props.onSelectAudio?.(id)} onSeek={ms => seekTo(ms, true)} />) : <div className="timeline-lane waveform-lane" {...lanePointer}>
            {!props.audioEditor && waveform.peaks.length > 0 ? <TimelineWaveformCanvas
              peaks={waveform.peaks}
              scrollLeft={viewport.scrollLeft}
              viewportWidth={viewport.viewportWidth}
              contentWidth={waveformContentWidth}
            /> : waveform.peaks.length ? null : <span className={waveform.error ? 'timeline-lane-error' : 'timeline-lane-empty'}>{waveform.error ?? (props.referenceAudio ? '正在生成歌曲音频波形…' : '当前节目还没添加音频')}</span>}
            {props.audioEditor ? <AudioTimelineSegments readOnly={props.lightingWorkspace === true} playheadMs={props.playheadMs} editor={props.audioEditor} peaks={waveform.peaks} scrollLeft={viewport.scrollLeft} viewportWidth={viewport.viewportWidth} pixelsPerSecond={viewport.pixelsPerSecond} onSelect={(id) => props.onSelectAudio?.(id)} onSeek={(ms) => seekTo(ms, true)} /> : null}
          </div>}
          {props.lightingWorkspace ? null : <ContentTracks layers={props.layers} clips={props.clips} cues={props.cues} assets={assets} frameRate={props.frameRate}
            durationMs={props.durationMs} playheadMs={props.playheadMs} timelineState={props.timelineState} airtime={props.airtime}
            selectedClipId={props.selectedClipId} selectedCueId={props.selectedCueId} audioSnapPoints={props.audioEditor?.points ?? []}
            rules={props.editRules} viewport={viewport} tracks={visualTracks} snap={{ enabled: snapEnabled, thresholdMs: snapThresholdMs }}
            lanePointer={lanePointer} focusTimeline={() => timelineRef.current?.focus()}
            onOpenMenu={(target, x, y) => setClipContext({ target, x, y })} onSelectClip={props.onSelectClip} onSelectCue={props.onSelectCue}
            onMoveClip={props.onMoveClip} onMoveCue={props.onMoveCue} onTrim={props.onTrim} onDropAsset={props.onDropAsset} onDropObsResource={props.onDropObsResource} />}
          {props.lighting ? <LightingLanes {...props.lighting} snapTime={(ms) => snap({ ...props, durationMs: 86_399_000 }, ms, snapEnabled, props.lightingWorkspace ? [] : props.audioEditor?.points ?? [], snapThresholdMs)} getPlaybackPosition={() => props.playing && clock.read().ready ? clock.read().positionMs : props.playheadMs} scrollLeft={viewport.scrollLeft} viewportWidth={viewport.viewportWidth} playheadMs={props.playheadMs} timeAtClientX={viewport.editTimeAtClientX} onSeek={(ms) => { props.onPlayheadChange(ms); if (!props.externalTransport && audioRef.current) audioRef.current.currentTime = ms / 1000; }} pixelsPerSecond={viewport.pixelsPerSecond} /> : null}
          {props.lightingWorkspace ? <div className="timeline-new-layer-drop" /> : null}
          {!props.lightingWorkspace && props.referenceAudio ? <div className="timeline-audio-end" style={{ left: props.referenceAudio.durationMs / 1000 * viewport.pixelsPerSecond }}><span>音频结束{props.durationMs > props.referenceAudio.durationMs ? ` · 内容超出 ${((props.durationMs - props.referenceAudio.durationMs) / 1000).toFixed(2)} 秒` : ''}</span></div> : null}
          {props.referenceAudio && props.durationMs > props.referenceAudio.durationMs ? <div className="timeline-audio-overrun" aria-label="内容超出音频范围" style={{ left: props.referenceAudio.durationMs / 1000 * viewport.pixelsPerSecond, width: (props.durationMs - props.referenceAudio.durationMs) / 1000 * viewport.pixelsPerSecond }} /> : null}
          {!props.lightingWorkspace && props.audioEditor?.points.filter((ms) => ms / 1000 * viewport.pixelsPerSecond >= viewport.scrollLeft && ms / 1000 * viewport.pixelsPerSecond <= viewport.scrollLeft + viewport.viewportWidth).map((ms) => <span key={ms} className="timeline-beat-guide" style={{ left: ms / 1000 * viewport.pixelsPerSecond }} />)}
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
  deleteSelected: () => void,
  stop: () => void
): void {
  if (event.key === 'Escape' && props.onStop && event.target instanceof HTMLElement && !event.target.closest('details[open],[role="dialog"],[aria-expanded="true"],input,textarea,select')) { event.preventDefault(); event.stopPropagation(); stop(); return; }
  if (isInteractiveTarget(event.target)) return;
  if (props.lightingWorkspace && ['Space', 'Home', 'End', 'ArrowLeft', 'ArrowRight'].includes(event.code)) return;
  const command = event.ctrlKey || event.metaKey;
  // Lighting owns its clipboard; selecting a lighting clip excludes media paste.
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
  if (!command && event.key.toLowerCase() === 's' && !props.lightingWorkspace && props.audioEditor && props.audioEditor.selected && !props.audioEditor.disabled) { event.preventDefault(); void props.audioEditor.split(props.playheadMs); return; }
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
  props: Pick<Props, 'durationMs' | 'frameRate'> & Partial<Pick<Props, 'lightingWorkspace' | 'lighting'>>,
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


function useTimelineDisplay(input: Props) {
  const { timelineRef, audioHeight, setAudioHeight } = useAudioRowHeight(Math.max(1, input.audioEditor?.tracks.length ?? 0), timelineRulerHeight(input));
  const waveformGain = 1;
  const [cueMouseMode, setCueMouseMode] = useState<'seek' | 'select'>('seek');
  const [waveformMode, setWaveformMode] = useState('rhythm');
  // Empty tracks are removed with every edit (core content timeline), so every track has content.
  const layers = input.lightingWorkspace ? [] : input.layers;
  const props = { ...input, layers, audioRowHeight: input.lightingWorkspace ? audioHeight : 76 };
  return { timelineRef, cueMouseMode, setCueMouseMode, props, layers, audioHeight, setAudioHeight, waveformGain, waveformMode, setWaveformMode };
}
