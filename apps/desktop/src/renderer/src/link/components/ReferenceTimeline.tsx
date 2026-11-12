import { useAutomaticMusicAnalysis } from '../runtime/use-automatic-music-analysis';
import { MusicBeatMarkers } from './MusicBeatMarkers';
import { musicRecognitionKey, useMusicBeatSegments } from './useMusicBeatSegments';
import { MusicAnalysisButton } from './MusicAnalysisButton';
import { usePlayheadTimeLabel } from './usePlayheadTimeLabel';
import { useAudioRowHeight } from './useAudioRowHeight';
import { useTimelineStamp } from './useTimelineStamp';
import { TimelinePanelButton } from './TimelinePanelButton';
import { Field, IconButton, MenuButton, MenuItem, Select } from '../ui';
import { useTimelineWheelSeek } from './useTimelineWheelSeek';
import { AudioRowResizeHandle } from './AudioRowResizeHandle';
import { LightingTimelineControls, MusicAnalysisPanelPortal, type LightingTimelineDisplay } from './LightingTimelineControls';
import '../lighting-music.css';
import '../lighting-timeline.css';
import { LightingMusicSectionRow } from './LightingMusicSections';
import { WaveformCuePoints } from './WaveformCuePoints';
import { lightingMaterialDropHandlers, type ConsoleCueDrag } from './lighting-material-drag';
import { useFrameValue } from './useFrameValue';
import { AudioTimelineSegments } from './AudioTimelineSegments';
import { AudioTrackLane } from './AudioTrackLane';
import type { AudioEditor } from './useAudioEditor';
import { SongPaddingHandles } from './SongPaddingHandles';
import { lightingSnapPoints, markerSnapPoints, timelineSnapPoints } from './timeline-snap-points';
import { useTimelineSnap } from '../stores/timeline-view-store';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { useTimelineAudio, type PlaybackClock } from './useTimelineAudio';
import {
  songMusicSource,
  type ContentRef,
  type ResolvedTimelineState
} from '@tb/core/link';
import type { LinkCue, LinkMediaAsset, MtcFrameRate, ReferenceMediaClip, RundownItem, VisualLayer } from '@tb/schema';
import { Music2, Trash2, MousePointer2, SquareDashedMousePointer, AudioLines, ArrowLeftRight, FolderInput, Gauge, type LucideIcon } from 'lucide-react';
import type { LightingTool } from './LightingTimelineTools';
import type { ObsResource } from './ResourceLibrary';
import { useSongWaveform, type ReferenceWaveformSource } from './ReferenceWaveform';
import { useScrollPaint } from './timeline-scroll';
import { waveformDisplay } from '../view-models/waveform-draw';
import { formatTimelineTimecode, timelineInteractionTime } from './timeline-geometry';
import { TimelineContextMenu, type TimelineClipboard, type TimelineContext } from './TimelineContextMenu';
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
import { useKeyCommands } from '../keys/useKeyCommands';
import { keyInTimeline } from '../keys/key-owner';
import { editorEditKeys, editorTransportKeys, timelineEditKeys, timelineTransportKeys, type TimelineSeek } from './timeline-commands';
import { commandKeyLabel, markSplitHintShown, splitHintShown } from '../stores/shortcut-store';
import { usePlayheadPaint, type EditorPlayhead } from './editor-playhead';
import { DragSession } from './drag-session';
import { keyRouter } from '../keys/key-router';
import type { PendingMark } from '../view-models/picture-on-air';

/**
 * The playhead a key moves (the frame steps, Shift+←/→, ↑↓, Home, End): a held key's seeks merged into one per frame
 * drawn (04 设计 4.9, K7); `from` is where the last key put it, drawn or not. A new song drops what is not drawn yet.
 */
function useKeySeek(playhead: EditorPlayhead, itemId: ResolvedTimelineState['itemId'], seek: (milliseconds: number) => void): TimelineSeek {
  const target = useRef<number | null>(null);
  const frame = useFrameValue((milliseconds: number) => { target.current = null; seek(milliseconds); });
  const cancel = frame.cancel;
  useEffect(() => { cancel(); target.current = null; }, [itemId, cancel]);
  return { from: () => target.current ?? playhead.read(), to: milliseconds => { target.current = milliseconds; frame.push(milliseconds); } };
}

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
  /** Esc in the timeline with 「单按 Esc 停止」 off: nothing selected any more (K7). */
  onDeselect?: () => void;
  /** A word for the operator: a one-time hint (S, which split before 0.5.9), what became of a beat tapped with Ctrl+J. */
  onHint?: (message: string, tone?: 'info' | 'error') => void;
  lighting?: LightingTimelineProps;
  projectPath: string | null;
  assets: LinkMediaAsset[];
  clips: ReferenceMediaClip[];
  cues: LinkCue[];
  layers: VisualLayer[];
  timelineState: ResolvedTimelineState;
  /** What the output shows of each clip and camera (SceneOutputTimeline.airtime). */
  airtime: Airtime;
  /** What OBS plays by, for the on-air marks: while the song plays, the airtime of the version it started with;
   * null when that version cannot be confirmed (view-models/picture-on-air). */
  onAirtime: Airtime | null;
  /** Parts changed while the song plays, which OBS does not have yet (view-models/pending-picture-edits). */
  pending: ReadonlySet<string>;
  /** What those parts say (view-models/picture-on-air, R9). */
  pendingMark: PendingMark;
  editRules: ContentEditRules;
  frameRate: MtcFrameRate;
  durationMs: number;
  /** Moves every frame while a song plays; the line, the readout and the auto scroll follow it here without a render (0.5.9 E2). */
  playhead: EditorPlayhead;
  referenceAudio: ReferenceWaveformSource | null;
  /** The song whose beats the lighting workspace shows and recognises (core songBeats, songMusicSource). */
  musicItem?: RundownItem | undefined;
  playing: boolean;
  /** The show is being prepared (联动台播放). */
  preparing?: boolean;
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
  onSplitClip: (clipId: string, timeMs: number, group?: string) => void;
  onDuplicateClip: (clipId: string, startMs: number) => void;
  onPasteClip: (clip: ReferenceMediaClip, startMs: number) => void;
  onDuplicateCue: (cueId: string, startMs: number) => void;
  onMoveCue: (cueId: string, timeMs: number, layerId?: string | null) => void;
  onMoveLayer: (layerId: string, targetIndex: number) => void;
  onUpdateLayer: (layer: VisualLayer) => void; onDeleteLayer: (layerId: string) => void;
  onDeleteClip: (clipId: string) => void;
  onDeleteCue: (cueId: string) => void;
};

/** The props as this timeline reads them: `playheadMs` is the playhead now, read when it is used (a key, a button). */
type TimelineProps = Props & { readonly playheadMs: number };

export function ReferenceTimeline(input: Props): JSX.Element {
  const { timelineRef, cueMouseMode, setCueMouseMode, props, layers, audioHeight, setAudioHeight, waveformGain, waveformMode, setWaveformMode } = useTimelineDisplay(input);
  // The song's beats and their recognition, the same on the editor and the lighting workbench: one record per song
  // (core songBeats) and one recognition task per song (musicRecognitionKey), 0.5.9 E11.
  const musicSource = props.musicItem ? songMusicSource(props.musicItem) : undefined;
  const analysis = useAutomaticMusicAnalysis(props.projectPath, musicSource);
  const [musicDisplay, setMusicDisplay] = useState<LightingTimelineDisplay>({ sections: true, markers: true, rawAnalysis: true });
  const beatSegments = useMusicBeatSegments(props.musicItem, analysis, musicRecognitionKey(props.projectPath, props.timelineState.itemId, musicSource), props.projectPath, props.playing, props.onHint);
  const musicPanel = { beats: beatSegments, analysis, playhead: props.playhead, source: musicSource, projectPath: props.projectPath, analysisPanel: props.analysisPanel };
  const assets = useMemo(() => new Map(props.assets.map((asset) => [asset.id, asset])), [props.assets]);
  const waveform = useSongWaveform(props.referenceAudio);

  const { audioRef, clock } = useTimelineAudio(props.externalTransport, props.transportClock);
  const wheelSeek = useTimelineWheelSeek(props, audioRef);
  const showPlayheadTime = usePlayheadTimeLabel(timelineRef);
  const viewport = useTimelineViewport(props.durationMs, props.lightingWorkspace ? 220 : undefined, props.lightingWorkspace ? wheelSeek.seek : undefined, props.lightingWorkspace ? props.referenceAudio?.sha256 ?? 'no-audio' : undefined, props.playhead.read());
  const revealTimelineTime = viewport.revealTime;
  const lightingPlayback = useLightingPreview({ enabled: (props.lightingWorkspace === true || (props.lighting?.preview ?? false)) && !props.externalTransport, document: props.lighting?.document, mtcOrigin: props.lighting?.mtcOrigin, audioRef, playing: props.playing && !props.externalTransport, frameRate: props.frameRate, onError: (message) => { props.onPlayingChange(false); props.onPlaybackError(message); } });
  const stopPlayback = (): void => { props.onStop?.(); void lightingPlayback.stop().catch((error: unknown) => props.onPlaybackError(error instanceof Error ? error.message : String(error))); };
  // Dragging the playhead (DragSession, the pointer it follows): Escape only stops it following the pointer, and does
  // not stop the show, until the pointer is let go (K5). Nothing is drawn for it, so the page does not draw again.
  const [playheadDrag] = useState(() => new DragSession<number>(globalThis, () => undefined, keyRouter));
  useEffect(() => () => playheadDrag.dispose(), [playheadDrag]);
  const [clipboard, setClipboard] = useState<TimelineClipboard | null>(null);
  const [snapEnabled, setSnapEnabled] = useTimelineSnap(props.lightingWorkspace === true);
  const [snapDistance, setSnapDistance] = useState(14);
  const [clipContext, setClipContext] = useState<TimelineContext | null>(null);
  const layerReorder = useLayerReorder(layers.length, (id, index) => { const target = layers[index]; if (target) input.onMoveLayer(id, input.layers.findIndex((layer) => layer.id === target.id)); });
  const seekSnapPointsMs = useMemo(() => props.lightingWorkspace ? lightingSnapPoints(props.lighting?.document, beatSegments.snapPoints, props.referenceAudio?.durationMs ?? props.durationMs) : [...timelineSnapPoints(props.timelineState, props.cues, props.frameRate), ...(props.audioEditor?.snapPoints ?? [])], [beatSegments.snapPoints, props.lightingWorkspace, props.lighting?.document, props.referenceAudio?.durationMs, props.durationMs, props.cues, props.frameRate, props.timelineState, props.audioEditor?.snapPoints]);
  const snapThresholdMs = snapDistance / viewport.pixelsPerSecond * 1_000;
  const musicRow = musicDisplay.sections && beatSegments.points.length > 0;
  const { sectionRow, rulerHeight } = timelineMusicLayout({ ...props, musicRow }, musicDisplay);
  const { contentStyle, headingStyle, visualTracks } = timelineLayout({ ...props, sectionRow, musicRow }, viewport.contentWidth, viewport.pixelsPerSecond, viewport.gridSize);
  // The playhead line, the time above it and the page turning while playing follow the playhead straight into the DOM.
  const playheadLine = useRef<HTMLSpanElement>(null);
  const playheadTime = useRef<HTMLElement>(null);
  const { pixelsPerSecond, scroll, viewportWidth } = viewport;
  const timeInset = props.lightingWorkspace ? 60 : 46;
  const { frameRate, playing, playhead } = props;
  // Painted on every move of the playhead and of the scroll (the time keeps inside the visible part), not by React.
  const paintPlayhead = useCallback((playheadMs: number) => {
    const at = playheadPlace(playheadMs, pixelsPerSecond, scroll.read().left, viewportWidth, timeInset);
    if (playheadLine.current) playheadLine.current.style.left = `${at.left}px`;
    const time = playheadTime.current;
    if (time) {
      time.style.left = `${at.timeLeft}px`;
      time.style.visibility = at.visible ? 'visible' : 'hidden';
      time.textContent = formatTimelineTimecode(playheadMs, frameRate);
    }
    if (playing) revealTimelineTime(playheadMs);
  }, [frameRate, pixelsPerSecond, playing, revealTimelineTime, scroll, timeInset, viewportWidth]);
  usePlayheadPaint(playhead, paintPlayhead);
  useScrollPaint(scroll, useCallback(() => paintPlayhead(playhead.read()), [paintPlayhead, playhead]));
  const drawnPlayhead = playheadPlace(playhead.read(), pixelsPerSecond, scroll.read().left, viewportWidth, timeInset);

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
  /** The play button: play from the playhead (from the start once it reached the end), or pause. Space presses it
   * anywhere on this page (0.5.9); while the show is being prepared it waits, so the preparation never starts over. */
  const playPause = (): void => {
    if (props.preparing) return;
    const audioEndMs = props.referenceAudio?.durationMs;
    if (!props.playing && (props.playheadMs >= props.durationMs || (audioEndMs !== undefined && props.playheadMs >= audioEndMs) || audioRef.current?.ended)) seekTo(0, true, false);
    props.onPlayingChange(!props.playing);
  };
  const keySeek = useKeySeek(props.playhead, props.timelineState.itemId, milliseconds => { seekTo(milliseconds, true, false); });
  // Space on this page outside the timeline presses this play button too (the window's Space, K3); the stop keys stop
  // the show and the lighting preview from anywhere on this page (K7: the window's stop finds this one first).
  useKeyCommands('timeline', { 'transport.playPause': playPause, ...(props.onStop ? { 'transport.stop': stopPlayback } : {}) });
  // The timeline's own keys, with the focus in it (K6, K7).
  useKeyCommands('timeline', {
    ...timelineEditKeys(props, clipboard, setClipboard, props.musicItem ? beatSegments.tap : undefined),
    ...timelineTransportKeys({ frameRate: props.frameRate, durationMs: props.lightingWorkspace ? props.referenceAudio?.durationMs ?? props.durationMs : props.durationMs, editPoints: seekSnapPointsMs, playing: props.playing,
      markers: props.lighting && (!props.lightingWorkspace || musicDisplay.markers) ? markerSnapPoints(props.lighting.document.markers) : [], beats: props.lightingWorkspace ? beatSegments.snapPoints : props.audioEditor?.snapPoints ?? [] }, { playPause, onPlayingChange: props.onPlayingChange, seek: keySeek }),
    'view.snap': () => setSnapEnabled(!snapEnabled),
    'view.zoomIn': viewport.zoomIn, 'view.zoomOut': viewport.zoomOut, 'view.zoomFit': viewport.fit,
    ...(props.onDeselect ? { 'edit.deselect': props.onDeselect } : {}),
    ...(props.onHint && !splitHintShown() ? { 'edit.splitMoved': () => { if (markSplitHintShown()) props.onHint?.(`分割改成了 ${commandKeyLabel('edit.split', 'timeline')}，和剪映一样。S 不再分割。`); } } : {})
  }, press => keyInTimeline(press.target));
  useKeyCommands('editor', props.lightingWorkspace ? null : { ...editorTransportKeys(props, playPause, keySeek), ...editorEditKeys(props) });
  const playheadFrame = useFrameValue((clientX: number) => { seek(clientX, true); });
  const cancelPlayheadFrame = playheadFrame.cancel;
  useEffect(() => { cancelPlayheadFrame(); playheadDrag.end(); setClipboard(null); setClipContext(null); }, [props.timelineState.itemId, cancelPlayheadFrame, playheadDrag]);
  const beginPlayhead = (event: PointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return;
    props.onPlayingChange(false);
    timelineRef.current?.focus();
    playheadDrag.begin(event.currentTarget, event.pointerId, event.pointerId);
    playheadFrame.flush(event.clientX);
  };
  const movePlayhead = (event: PointerEvent<HTMLElement>): void => {
    if (playheadDrag.current() === event.pointerId) playheadFrame.push(event.clientX);
  };
  const endPlayhead = (event: PointerEvent<HTMLElement>): void => {
    if (playheadDrag.current() !== event.pointerId) return;
    playheadFrame.flush(event.clientX);
    playheadDrag.end();
  };
  const cancelPlayhead = (event: PointerEvent<HTMLElement>): void => {
    if (playheadDrag.current() === event.pointerId) { playheadFrame.cancel(); playheadDrag.end(); }
  };
  const lanePointer = { onPointerDown: beginPlayhead, onPointerMove: movePlayhead, onPointerUp: endPlayhead, onPointerCancel: cancelPlayhead };

  const stamping = useTimelineStamp({ lighting: props.lightingWorkspace ? props.lighting : undefined, get playheadMs() { return props.playhead.read(); }, durationMs: props.referenceAudio?.durationMs ?? props.durationMs, playing: props.playing, frameRate: props.frameRate, clock, onPlayPause: playPause, onPlayingChange: props.onPlayingChange, seek: keySeek });


  return <section
    className="reference-timeline panel"
    data-lighting-timeline={props.lightingWorkspace === true} style={{ '--waveform-gain': waveformGain } as CSSProperties}
    onContextMenu={(event) => { if (event.defaultPrevented || !(event.target instanceof Element) || !event.target.closest('.timeline-lane')) return; event.preventDefault(); setClipContext({ target: null, x: event.clientX, y: event.clientY }); }}
    onContextMenuCapture={event => { if (!props.lightingWorkspace || !(event.target instanceof Element) || !event.target.closest('.waveform-lane,.waveform-cue-points') || event.target.closest('.waveform-cue-point,.effect-binding-backdrop')) return; event.preventDefault(); event.stopPropagation(); stamping.stamp(viewport.editTimeAtClientX(event.clientX)); }}
    data-duration-ms={props.durationMs} data-waveform-mode={waveformMode}
    ref={timelineRef} data-playhead-time={showPlayheadTime}
    tabIndex={0}
  >
    <div><TimelineToolbar displayControl={props.lightingWorkspace ? <LightingTimelineControls {...musicPanel} onSeek={ms => { viewport.revealTime(ms); seekTo(ms, true, false); }} display={musicDisplay} onDisplayChange={setMusicDisplay} /> : <><MusicAnalysisButton compact beats={beatSegments} analysis={analysis} playhead={props.playhead} open={props.analysisPanel?.open ?? false} onOpen={() => props.analysisPanel?.onOpen()} /><MusicAnalysisPanelPortal {...musicPanel} onSeek={ms => { viewport.revealTime(ms); seekTo(ms, true, false); }} /></>} outputControl={props.outputControl} stampControls={stamping.controls} wheelSeek={props.lightingWorkspace ? wheelSeek : undefined} compact={props.lightingWorkspace === true} tools={props.lightingWorkspace ? <><div className="cue-mouse-modes" role="group" aria-label="鼠标模式"><IconButton label="定位" title="定位：点击或拖动波形、标尺" icon={MousePointer2} aria-pressed={cueMouseMode === 'seek'} onClick={() => setCueMouseMode('seek')} /><IconButton label="框选 Cue" title="框选 Cue：拖动框选，Delete 删除" icon={SquareDashedMousePointer} aria-pressed={cueMouseMode === 'select'} onClick={() => setCueMouseMode('select')} /></div><TimelinePanelButton label="波形显示方式" icon={AudioLines}><Field stacked label="波形显示方式">{(field) => <Select {...field} value={waveformMode} onChange={event => setWaveformMode(event.currentTarget.value)}><option value="rhythm">节奏波形</option><option value="waveform">原始波形</option><option value="spectrum">频谱</option></Select>}</Field></TimelinePanelButton></> : undefined} editPoints={seekSnapPointsMs} snapDistance={snapDistance} onSnapDistanceChange={setSnapDistance} externalTransport={props.externalTransport} onStop={props.onStop ? stopPlayback : undefined} recordingControl={props.lighting ? <><MenuButton label="灯光" menuLabel="灯光工具" className="timeline-lighting-tools">{(close) => lightingTools.filter(([tool]) => !props.lightingWorkspace || tool !== 'tempo').map(([tool, label, icon]) => <MenuItem key={tool} icon={icon} onSelect={() => { close(); props.lighting?.onOpenTools?.(tool); }}>{label}</MenuItem>)}</MenuButton><TimelineLightingRecording audioAvailable={Boolean(props.referenceAudio)} document={props.lighting.document} clipId={props.lighting.selectedClipId} clock={clock} onChange={props.lighting.onChange} onError={props.onPlaybackError} /></> : null} playbackReady={lightingPlayback.ready} frameRate={props.frameRate} durationMs={props.durationMs} playhead={props.playhead} playing={props.playing} referenceAudio={props.referenceAudio} snapEnabled={snapEnabled} audioRef={audioRef} onPlayheadChange={ms => { if (props.playing) props.onPlayheadChange(ms); else seekTo(ms, true, false); }} onPlayPause={playPause} onPlayingChange={props.onPlayingChange} onPlaybackError={props.onPlaybackError} onSnapEnabledChange={setSnapEnabled} onZoomOut={viewport.zoomOut} onFit={viewport.fit} onZoomIn={viewport.zoomIn} />

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
          {props.lightingWorkspace && props.lighting ? <WaveformCuePoints frameRate={props.frameRate} mode={cueMouseMode} height={audioHeight} lighting={{ ...props.lighting, snapTime: (ms, excludedId) => snap(props, ms, snapEnabled, lightingSnapPoints(props.lighting?.document, beatSegments.snapPoints, props.referenceAudio?.durationMs ?? props.durationMs, excludedId), snapThresholdMs) }} pixelsPerSecond={viewport.pixelsPerSecond} top={rulerHeight} view={viewport.view} scroll={scroll} viewportWidth={viewportWidth} durationMs={props.referenceAudio?.durationMs ?? props.durationMs} disabled={false} /> : null}
          {props.lightingWorkspace ? <AudioRowResizeHandle height={audioHeight} rulerHeight={rulerHeight} onChange={setAudioHeight} /> : null}
          <div className="timeline-ruler" data-sections={sectionRow} data-music={musicRow} {...lanePointer}>
            {sectionRow && props.lighting ? <LightingMusicSectionRow onChange={props.lighting.onChange} candidates={undefined} document={props.lighting.document} left={viewport.view.left} width={viewport.view.width} pixelsPerSecond={viewport.pixelsPerSecond} onSeek={ms => { if (!props.playing) seekTo(ms, true, false); }} /> : null}
            {viewport.ticks.filter(() => props.lightingWorkspace || props.lighting?.document.music?.ruler !== 'beats').filter(tick => !props.lightingWorkspace || Math.round(tick.left / viewport.gridSize) % Math.ceil(104 / viewport.gridSize) === 0).map((tick) => <span key={tick.milliseconds} style={{ left: tick.left }}>{props.lightingWorkspace ? formatTimelineTimecode(tick.milliseconds, props.frameRate) : tick.label}</span>)}
            <strong ref={playheadTime} className="timeline-current-time" style={{ left: drawnPlayhead.timeLeft, visibility: drawnPlayhead.visible ? 'visible' : 'hidden' }}>{formatTimelineTimecode(playhead.read(), props.frameRate)}</strong>
            {props.lighting && (!props.lightingWorkspace || musicDisplay.markers) ? <TimelineMarkers {...props.lighting} hideAnalysis={props.lightingWorkspace === true} pixelsPerSecond={viewport.pixelsPerSecond} timeAtClientX={viewport.editTimeAtClientX} onSeek={(ms) => { props.onPlayheadChange(ms); if (!props.externalTransport && audioRef.current) audioRef.current.currentTime = ms / 1000; }} /> : null}
            {props.lightingWorkspace ? <MusicBeatMarkers beats={beatSegments} view={viewport.view} scroll={scroll} viewportWidth={viewportWidth} pixelsPerSecond={viewport.pixelsPerSecond} top={sectionRow ? 24 : 0} rulerHeight={rulerHeight} showSegments={musicDisplay.sections} showBeats={musicDisplay.rawAnalysis} disabled={props.playing} onSeek={ms => seekTo(ms, true, false)} /> : null}
          </div>
          {props.audioEditor?.tracks.length ? props.audioEditor.tracks.map(track => <AudioTrackLane readOnly={props.lightingWorkspace === true} referencePointer={props.lightingWorkspace ? lanePointer : undefined} playhead={props.playhead} display={props.lightingWorkspace === true ? waveformDisplay(waveformMode) : 'waveform'} key={track.id} track={track} snapTime={ms => snap(props, ms, snapEnabled, seekSnapPointsMs, snapThresholdMs)} editor={props.audioEditor!} projectPath={props.projectPath} pixelsPerSecond={viewport.pixelsPerSecond} view={viewport.view} scroll={scroll} onSelect={id => props.onSelectAudio?.(id)} onSeek={ms => seekTo(ms, true)} />) : <div className="timeline-lane waveform-lane" {...lanePointer}>
            {waveform.waveform && !waveform.error ? null : <span className={waveform.error ? 'timeline-lane-error' : 'timeline-lane-empty'}>{waveform.error ?? (props.referenceAudio ? '正在生成歌曲音频波形…' : '当前节目还没添加音频')}</span>}
            {props.audioEditor ? <AudioTimelineSegments readOnly={props.lightingWorkspace === true} playhead={props.playhead} editor={props.audioEditor} waveform={waveform.waveform} display="waveform" view={viewport.view} scroll={scroll} pixelsPerSecond={viewport.pixelsPerSecond} onSelect={(id) => props.onSelectAudio?.(id)} onSeek={(ms) => seekTo(ms, true)} /> : null}
          </div>}
          {props.audioEditor && !props.lightingWorkspace ? <SongPaddingHandles padding={props.audioEditor.padding} pixelsPerSecond={viewport.pixelsPerSecond} contentWidth={viewport.contentWidth} viewport={viewport} top={rulerHeight} height={Math.max(1, props.audioEditor?.tracks.length ?? 0) * (props.audioRowHeight ?? 76)} /> : null}
          {props.lightingWorkspace ? null : <ContentTracks layers={props.layers} clips={props.clips} cues={props.cues} assets={assets} frameRate={props.frameRate}
            durationMs={props.durationMs} playhead={props.playhead} timelineState={props.timelineState} airtime={props.airtime} onAirtime={props.onAirtime} pending={props.pending} pendingMark={props.pendingMark}
            selectedClipId={props.selectedClipId} selectedCueId={props.selectedCueId} beatSnapPoints={props.audioEditor?.snapPoints ?? []} markerSnapPoints={markerSnapPoints(props.lighting?.document.markers)} playing={props.playing}
            rules={props.editRules} viewport={viewport} tracks={visualTracks} snap={{ enabled: snapEnabled, thresholdMs: snapThresholdMs }}
            lanePointer={lanePointer} focusTimeline={() => timelineRef.current?.focus()}
            onOpenMenu={(target, x, y) => setClipContext({ target, x, y })} onSelectClip={props.onSelectClip} onSelectCue={props.onSelectCue}
            onMoveClip={props.onMoveClip} onMoveCue={props.onMoveCue} onTrim={props.onTrim} onDropAsset={props.onDropAsset} onDropObsResource={props.onDropObsResource} />}
          {props.lighting ? <LightingLanes {...props.lighting} snapTime={(ms) => snap({ ...props, durationMs: 86_399_000 }, ms, snapEnabled, props.lightingWorkspace ? [] : props.audioEditor?.snapPoints ?? [], snapThresholdMs)} getPlaybackPosition={() => props.playing && clock.read().ready ? clock.read().positionMs : props.playheadMs} scrollLeft={viewport.view.left} viewportWidth={viewport.view.width} playhead={props.playhead} timeAtClientX={viewport.editTimeAtClientX} onSeek={(ms) => { props.onPlayheadChange(ms); if (!props.externalTransport && audioRef.current) audioRef.current.currentTime = ms / 1000; }} pixelsPerSecond={viewport.pixelsPerSecond} /> : null}
          {props.lightingWorkspace ? <div className="timeline-new-layer-drop" /> : null}
          {!props.lightingWorkspace && props.referenceAudio ? <div className="timeline-audio-end" style={{ left: props.referenceAudio.durationMs / 1000 * viewport.pixelsPerSecond }}><span>音频结束{props.durationMs > props.referenceAudio.durationMs ? ` · 内容超出 ${((props.durationMs - props.referenceAudio.durationMs) / 1000).toFixed(2)} 秒` : ''}</span></div> : null}
          {props.referenceAudio && props.durationMs > props.referenceAudio.durationMs ? <div className="timeline-audio-overrun" aria-label="内容超出音频范围" style={{ left: props.referenceAudio.durationMs / 1000 * viewport.pixelsPerSecond, width: (props.durationMs - props.referenceAudio.durationMs) / 1000 * viewport.pixelsPerSecond }} /> : null}
          <span ref={playheadLine} className="timeline-playhead" style={{ left: drawnPlayhead.left }} />
        </div>
      </div>
    </div>
    {clipContext ? <TimelineContextMenu context={clipContext} clipboard={clipboard} clips={props.clips} cues={props.cues} layers={props.layers} frameRate={props.frameRate} playhead={props.playhead} actions={props} onCopy={setClipboard} onSeek={(ms) => seekTo(ms, true)} onClose={() => { setClipContext(null); timelineRef.current?.focus(); }} /> : null}
  </section>;
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


/** Where the playhead line and the time above it go: the time keeps `inset` inside the
 * visible part and hides when the playhead is scrolled out of view. */
function playheadPlace(playheadMs: number, pixelsPerSecond: number, scrollLeft: number, viewportWidth: number, inset: number): { left: number; timeLeft: number; visible: boolean } {
  const left = playheadMs / 1_000 * pixelsPerSecond;
  return { left, timeLeft: Math.min(Math.max(left, scrollLeft + inset), scrollLeft + viewportWidth - inset),
    visible: left >= scrollLeft && left <= scrollLeft + viewportWidth };
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
  // `playheadMs` reads the playhead when it is used, never as it was at the last render.
  const props: TimelineProps = { ...input, layers, audioRowHeight: input.lightingWorkspace ? audioHeight : 76, get playheadMs() { return input.playhead.read(); } };
  return { timelineRef, cueMouseMode, setCueMouseMode, props, layers, audioHeight, setAudioHeight, waveformGain, waveformMode, setWaveformMode };
}
