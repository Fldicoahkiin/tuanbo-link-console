import { useCallback, useMemo, useRef, useState, type DragEvent, type HTMLAttributes, type MouseEvent, type PointerEvent } from 'react';
import { contentPlaceTaken, contentTrimBounds, millisecondsToFrameNumber, resolveTimelineClipSpan, timecodeToMilliseconds, type ContentRef, type ResolvedTimelineState, type TimelineSpan } from '@tb/core/link';
import type { LinkCue, LinkMediaAsset, LinkProject, MtcFrameRate, ReferenceMediaClip, RundownItem, VisualLayer } from '@tb/schema';
import { MEDIA_DRAG_TYPE, OBS_DRAG_TYPE, type ObsResource } from './ResourceLibrary';
import { parseObsResource } from './resource-library-model';
import { clipLabel, cueLabel, TimelineClip, TimelineCue, timelineCueSpan, type TimelineItemHeld } from './TimelineItems';
import { TimelineNewLayerDrop } from './TimelineNewLayerDrop';
import type { TimelineTarget } from './TimelineContextMenu';
import { markedOnAir, type Airtime } from './timeline-air';
import { timelineInteractionTime } from './timeline-geometry';
import { heldSnapPoints, timelineItemDuration, timelineSnapPoints } from './timeline-snap-points';
import { useContentTrim, type ContentTrimDrag, type TrimBounds } from './useContentTrim';
import { useTimelineItemDrag, type TimelineDrag } from './useTimelineItemDrag';
import type { TimelineViewport } from './useTimelineViewport';
import { usePlayheadValue, type EditorPlayhead } from './editor-playhead';
import { EdgeScroll, TRACK_HEIGHT, showsNewTrackAbove, snapshotTimeAt, trackLayout, type DragViewport, type ItemDragSnapshot, type SnapGuide } from './drag-preview';
import './timeline-drag-hints.css';
import { useScrollPaint, type ScrollPosition } from './timeline-scroll';
import type { PendingMark } from '../view-models/picture-on-air';

/** Items this far outside the drawn window stay drawn, so a fast scroll never shows a gap. */
const CULL_MARGIN = 112;

/** The timeline rules the tracks ask while a part is dragged or trimmed, so
 * what the drag shows is what the edit does. */
export type ContentEditRules = {
  trimBounds: (ref: ContentRef) => TrimBounds;
  /** Whether a part moved to `startMs` on `layerId` lands on another part there
   * and so goes on a new track above it. */
  placeTaken: (ref: ContentRef, startMs: number, layerId: string) => boolean;
};

export function contentEditRules(project: LinkProject, itemId: string): ContentEditRules {
  return {
    trimBounds: (ref) => contentTrimBounds(project, itemId, ref),
    placeTaken: (ref, startMs, layerId) => contentPlaceTaken(project, itemId, ref, startMs, layerId)
  };
}

/**
 * The rules for the song on the page, the same object while the page shows that song (0.5.9 E3), so the timeline's
 * props stay the same between edits. They read the project as it is when they are asked, at a press.
 */
export function useContentEditRules(project: LinkProject | null, item: RundownItem | null): ContentEditRules | null {
  const latest = useRef(project);
  latest.current = project;
  const itemId = item?.id;
  return useMemo(() => {
    if (itemId === undefined) return null;
    const current = (): LinkProject => { if (!latest.current) throw new Error('工程已经关闭'); return latest.current; };
    return { trimBounds: (ref) => contentTrimBounds(current(), itemId, ref), placeTaken: (ref, startMs, layerId) => contentPlaceTaken(current(), itemId, ref, startMs, layerId) };
  }, [itemId]);
}

export type ContentTracksProps = {
  layers: VisualLayer[];
  clips: ReferenceMediaClip[];
  cues: LinkCue[];
  assets: ReadonlyMap<string, LinkMediaAsset>;
  frameRate: MtcFrameRate;
  durationMs: number;
  /** Read when snapping; the on-air marks follow it, drawn again only when they change (0.5.9 E2). */
  playhead: EditorPlayhead;
  timelineState: ResolvedTimelineState;
  /** The parts covered by upper cameras in this timeline, dimmed. */
  airtime: Airtime;
  /** What OBS plays by, for the on-air marks (view-models/picture-on-air): while the song plays, the airtime of
   * the version it started with; null when that version cannot be confirmed, so nothing is marked on air. */
  onAirtime: Airtime | null;
  /** Parts (`media:` / `cue:` keys) changed while the song plays: marked, never shown on air. */
  pending: ReadonlySet<string>;
  /** What those parts say (view-models/picture-on-air, R9). */
  pendingMark: PendingMark;
  selectedClipId: string | null;
  selectedCueId: string | null;
  /** The song's beat points snapping adds (`songBeatSnapPoints`, from `songBeats`); none for a song without beats. */
  beatSnapPoints: readonly number[];
  /** The timeline markers' times; parts snap to them like to other parts' edges. */
  markerSnapPoints: readonly number[];
  /** While the song plays the playhead is no snap point (0.5.9 E12, as in 剪映). */
  playing: boolean;
  rules: ContentEditRules;
  viewport: Pick<TimelineViewport, 'viewportRef' | 'pixelsPerSecond' | 'scroll' | 'view' | 'timeAtClientX' | 'scrollLeftTo' | 'maxScrollLeft'>;
  /** Where the first track starts, where the lighting row sits between tracks, and how much of the top the ruler covers. */
  tracks: { start: number; lightingIndex: number; lightingHeight: number; coveredTop: number };
  snap: { enabled: boolean; thresholdMs: number };
  lanePointer: Pick<HTMLAttributes<HTMLElement>, 'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel'>;
  focusTimeline: () => void;
  onOpenMenu: (target: TimelineTarget, x: number, y: number) => void;
  onSelectClip: (clipId: string) => void;
  onSelectCue: (cueId: string) => void;
  onMoveClip: (clipId: string, startMs: number, layerId?: string | null) => void;
  onMoveCue: (cueId: string, startMs: number, layerId?: string | null) => void;
  onTrim: (ref: ContentRef, startMs: number, durationMs: number) => void;
  onDropAsset: (assetId: string, startMs: number, layerId?: string | null) => void;
  onDropObsResource: (resource: ObsResource, startMs: number, layerId?: string | null) => void;
};

/** A press inside a track: the part under it (by `data-kind`/`data-id`) and, on a trim handle, its edge. */
type PartHit = { ref: ContentRef; part: HTMLElement; handle: HTMLElement | null; edge: 'start' | 'end' | null };

function partAt(event: { target: EventTarget | null; currentTarget: Element }): PartHit | null {
  if (!(event.target instanceof Element)) return null;
  const part = event.target.closest<HTMLElement>('[data-kind][data-id]');
  if (!part || !event.currentTarget.contains(part)) return null;
  const kind = part.dataset.kind, id = part.dataset.id;
  if ((kind !== 'clip' && kind !== 'cue') || id === undefined) return null;
  const handle = event.target.closest<HTMLElement>('[data-edge]');
  const edge = handle && part.contains(handle) ? handle.dataset.edge : undefined;
  return { ref: { kind, id }, part, handle: edge === 'start' || edge === 'end' ? handle : null, edge: edge === 'start' || edge === 'end' ? edge : null };
}

/** The editor's clip and camera tracks: placing, moving and trimming, and which
 * parts the output shows. The lighting workbench has none of this. */
export function ContentTracks(props: ContentTracksProps): JSX.Element {
  const { viewport, snap } = props;
  const select = (ref: ContentRef): void => { if (ref.kind === 'clip') props.onSelectClip(ref.id); else props.onSelectCue(ref.id); };
  // The playhead to snap to, read when asked: none while the song plays.
  const playing = useRef(props.playing);
  playing.current = props.playing;
  const snapPlayhead = (): number | null => playing.current ? null : props.playhead.read();
  const snapPoints = (target?: ContentRef): number[] => [...timelineSnapPoints(props.timelineState, props.cues, props.frameRate, snapPlayhead() ?? undefined, target), ...props.markerSnapPoints, ...props.beatSnapPoints];
  const dropNote = useRef<HTMLElement>(null);
  const guideLine = useRef<HTMLDivElement>(null);
  const durationNote = useRef<HTMLElement>(null);
  const latestViewport = useRef(viewport);
  latestViewport.current = viewport;
  /** The snap guide, drawn in the frame of a drag or trim (0.5.9 E12): at the snap point, coloured by what it is. A drag
   * keeps the painter it took at the press, so the scale is read when it paints: a zoom while held does not misplace it. */
  const paintGuide = (guide: SnapGuide | undefined): void => {
    const line = guideLine.current;
    if (!line) return;
    line.hidden = guide === undefined;
    if (!guide) return;
    line.dataset.kind = guide.kind;
    line.style.left = `${guide.atMs / 1000 * latestViewport.current.pixelsPerSecond}px`;
  };
  const [edgeScroll] = useState(() => new EdgeScroll({ read: () => latestViewport.current.scroll.read().left, max: () => latestViewport.current.maxScrollLeft(), to: left => latestViewport.current.scrollLeftTo(left) }));
  /** The viewport as it is on screen at a press: one read of the DOM for the whole drag. */
  const measure = (): DragViewport => {
    const element = viewport.viewportRef.current;
    const rect = element?.getBoundingClientRect();
    return { left: rect?.left ?? 0, top: rect?.top ?? 0, width: element?.clientWidth ?? 0, height: element?.clientHeight ?? 0,
      scrollLeft: element?.scrollLeft ?? 0, scrollTop: element?.scrollTop ?? 0, pixelsPerSecond: viewport.pixelsPerSecond };
  };
  // The timeline's own points for a held part, apart from the playhead, which is read in each frame.
  const ownPoints = (target: ContentRef): { before: number[]; after: number[] } => {
    const own = heldSnapPoints(props.timelineState, props.cues, props.frameRate, target);
    return { before: own.before, after: [...own.after, ...props.markerSnapPoints] };
  };
  const itemDrag = useTimelineItemDrag({
    layers: props.layers,
    snapshot: (press): ItemDragSnapshot => { const viewport = measure(), own = ownPoints(press.ref); return {
      viewport, layout: trackLayout(props.layers, props.tracks), frameRate: props.frameRate, durationMs: props.durationMs,
      snap: { enabled: snap.enabled, thresholdMs: snap.thresholdMs, before: [0, props.durationMs, ...own.before], after: own.after, beats: props.beatSnapPoints },
      placeTaken: props.rules.placeTaken, ref: press.ref, originMs: press.originMs, itemDurationMs: timelineItemDuration(props, press.ref),
      grabOffsetMs: snapshotTimeAt(viewport, press.clientX) - press.originMs, startClientX: press.clientX, startClientY: press.clientY, originLayerId: press.originLayerId, layerMovable: press.layerMovable
    }; },
    playhead: snapPlayhead, paintGuide, edgeScroll,
    label: (ref, startMs) => partLabel(ref, startMs, undefined, props),
    dropNote: () => dropNote.current,
    focusTimeline: props.focusTimeline,
    onSelectClip: props.onSelectClip, onSelectCue: props.onSelectCue, onMoveClip: props.onMoveClip, onMoveCue: props.onMoveCue
  });
  const trim = useContentTrim({
    // A trimmed edge snaps to every other part's edges, the playhead and the song's beats, fixed at the press.
    snapshot: (ref) => ({ viewport: measure(), frameRate: props.frameRate, snap: { enabled: snap.enabled, thresholdMs: snap.thresholdMs, ...ownPoints(ref), beats: props.beatSnapPoints } }),
    playhead: snapPlayhead, paintGuide, edgeScroll, durationNote: () => durationNote.current,
    focusTimeline: props.focusTimeline, bounds: props.rules.trimBounds, onSelect: select, onTrim: props.onTrim,
    label: (ref, startMs, durationMs) => partLabel(ref, startMs, durationMs, props)
  });
  // Scrolled or zoomed while a part is held: it follows from there, at the scroll event itself (0.5.9 E5).
  const { rebase: rebaseDrag } = itemDrag, { rebase: rebaseTrim } = trim, { pixelsPerSecond } = viewport;
  useScrollPaint(viewport.scroll, useCallback((scrolled: ScrollPosition) => {
    const at = { scrollLeft: scrolled.left, scrollTop: scrolled.top, pixelsPerSecond };
    rebaseDrag(at); rebaseTrim(at);
  }, [pixelsPerSecond, rebaseDrag, rebaseTrim]));
  const moving = itemDrag.drag?.target.moved === true ? itemDrag.drag : null;
  // Worked out every frame, but the tracks draw again only when what is on air changes, such as at a camera switch.
  const onAirKey = usePlayheadValue(props.playhead, positionMs => [...markedOnAir(props.onAirtime, props.pending,
    millisecondsToFrameNumber(positionMs, props.frameRate), props.timelineState.activeObsCueIds)].sort().join('\n'));
  const onAir = useMemo(() => new Set(onAirKey ? onAirKey.split('\n') : []), [onAirKey]);
  const drop = (event: DragEvent<HTMLElement>, layer?: VisualLayer): void => {
    event.preventDefault();
    event.stopPropagation();
    const startMs = timelineInteractionTime(viewport.timeAtClientX(event.clientX), props.durationMs, props.frameRate, snap.enabled, snapPoints(), snap.thresholdMs);
    const assetId = event.dataTransfer.getData(MEDIA_DRAG_TYPE);
    if (assetId) { props.onDropAsset(assetId, startMs, layer?.id ?? null); return; }
    const value = event.dataTransfer.getData(OBS_DRAG_TYPE);
    if (value) props.onDropObsResource(parseObsResource(value), startMs, layer?.id ?? null);
  };
  // The parts' events, on their track (TimelineItems): a press moves or trims a part, or else moves the playhead.
  const pressPart = (event: PointerEvent<HTMLElement>, layer: VisualLayer): void => {
    const hit = partAt(event);
    if (!hit) { props.lanePointer.onPointerDown?.(event); return; }
    if (hit.handle && hit.edge) {
      if (layer.locked) { event.stopPropagation(); return; }
      const span = hit.ref.kind === 'clip' ? partSpan(hit.ref, props) : timedCueSpan(hit.ref.id, props);
      if (span) trim.begin(event, hit.ref, span, hit.edge, hit.handle, hit.part);
      return;
    }
    if (layer.locked) { event.stopPropagation(); select(hit.ref); return; }
    const originLayerId = hit.ref.kind === 'clip' ? props.clips.find((clip) => clip.id === hit.ref.id)?.layerId : props.cues.find((cue) => cue.id === hit.ref.id)?.layerId;
    itemDrag.begin(event, { ref: hit.ref, originMs: partStart(hit.ref, props), originLayerId }, hit.part);
  };
  const lanePointer = (layer: VisualLayer): HTMLAttributes<HTMLElement> => ({
    onPointerDown: (event) => pressPart(event, layer),
    onPointerMove: (event) => { itemDrag.move(event); trim.move(event); props.lanePointer.onPointerMove?.(event); },
    onPointerUp: (event) => { itemDrag.end(event); trim.end(event); props.lanePointer.onPointerUp?.(event); },
    onPointerCancel: (event) => { itemDrag.cancel(event); trim.cancel(event); props.lanePointer.onPointerCancel?.(event); },
    onClick: (event) => { const hit = partAt(event); if (hit) select(hit.ref); },
    onContextMenu: (event: MouseEvent<HTMLElement>) => {
      const hit = partAt(event);
      if (!hit) return;
      event.preventDefault();
      select(hit.ref);
      props.onOpenMenu(hit.ref, event.clientX, event.clientY);
    }
  });
  // Culled to the scroll block's window (useTimelineViewport `view`), so a scroll inside the block draws nothing again.
  const { view } = viewport;
  const inView = (left: number, width: number): boolean => left + width >= view.left - CULL_MARGIN && left <= view.left + view.width + CULL_MARGIN;

  return <>
    {/* Painted in the frames of a drag or trim (paintGuide, the trim's length note), hidden otherwise. */}
    <div ref={guideLine} className="timeline-snap-guide" hidden><span>已吸附</span></div>
    <small ref={durationNote} className="timeline-trim-length" hidden />

    {props.layers.map((layer, index) => {
      const rowTop = props.tracks.start + index * TRACK_HEIGHT + (index >= props.tracks.lightingIndex ? props.tracks.lightingHeight : 0);
      const rowInView = rowTop + TRACK_HEIGHT >= view.top - TRACK_HEIGHT && rowTop <= view.top + view.height + TRACK_HEIGHT;
      const dropTarget = moving?.target.layerId === layer.id;
      // Dropped here the part would overlap another, so it goes on a new track above this one (drag-preview.ts `taken`).
      const dropAbove = moving !== null && showsNewTrackAbove(moving.target, layer.id);
      // The row and drop target stay in the grid. Only offscreen contents are
      // left out; a held drag or trim and the selection stay drawn.
      const heldAs = (ref: ContentRef): TimelineItemHeld => partHeld(ref, itemDrag.drag, trim.drag);
      const shown = (ref: ContentRef, startMs: number, durationMs: number): boolean => (ref.kind === 'clip' ? props.selectedClipId : props.selectedCueId) === ref.id
        || heldAs(ref) !== null || rowInView && inView(startMs / 1000 * viewport.pixelsPerSecond, durationMs / 1000 * viewport.pixelsPerSecond);
      return <div key={layer.id} style={{ order: 100 + index * 100 }}
        className={`timeline-lane cue-lane all-lane ${layer.locked ? 'is-locked' : ''} ${layer.visible ? '' : 'is-hidden'} ${dropTarget ? 'is-drop-target' : ''} ${dropAbove ? 'is-drop-above' : ''} ${moving?.originLayerId === layer.id ? 'has-item-drag' : ''}`}
        data-visual-layer-id={layer.id} data-layer-locked={String(layer.locked)} {...lanePointer(layer)}
        onDragOver={(event) => event.preventDefault()} onDrop={(event) => drop(event, layer)}>
        <span className={`visual-layer-drop-state ${layer.locked ? 'is-locked' : ''}`}>
          {dropAbove ? <em ref={dropNote} style={{ left: (moving.target.startMs + timelineItemDuration(props, moving)) / 1000 * viewport.pixelsPerSecond + 8 }}>放到新轨道</em> : null}
        </span>
        {props.clips.filter((clip) => clip.layerId === layer.id).map((clip) => {
          const ref = { kind: 'clip', id: clip.id } as const;
          const span = resolveTimelineClipSpan(clip, props.frameRate);
          if (!shown(ref, span.startMs, span.durationMs)) return null;
          return <TimelineClip key={clip.id} clip={clip} asset={props.assets.get(clip.assetId)} frameRate={props.frameRate}
            pixelsPerSecond={viewport.pixelsPerSecond} selected={props.selectedClipId === clip.id} active={onAir.has(`media:${clip.id}`)} pending={props.pending.has(`media:${clip.id}`) ? props.pendingMark : null}
            locked={layer.locked} onAir={props.airtime.get(`media:${clip.id}`)} held={heldAs(ref)} />;
        })}
        {props.cues.filter((cue) => cue.layerId === layer.id).map((cue) => {
          const ref = { kind: 'cue', id: cue.id } as const;
          if (!shown(ref, partStart(ref, props), timelineCueSpan(cue, props.frameRate)?.durationMs ?? 0)) return null;
          return <TimelineCue key={cue.id} cue={cue} frameRate={props.frameRate} pixelsPerSecond={viewport.pixelsPerSecond}
            selected={props.selectedCueId === cue.id} active={onAir.has(`cue:${cue.id}`)} pending={props.pending.has(`cue:${cue.id}`) ? props.pendingMark : null} locked={layer.locked}
            onAir={props.airtime.get(`cue:${cue.id}`)} held={heldAs(ref)} />;
        })}
      </div>;
    })}
    <TimelineNewLayerDrop active={moving?.target.layerId === null} onDrop={(event) => drop(event)} />
  </>;
}

/** What a part is doing now: pressed, moved or trimmed. */
function partHeld(ref: ContentRef, drag: TimelineDrag | null, trim: ContentTrimDrag | null): TimelineItemHeld {
  if (trim?.ref.kind === ref.kind && trim.ref.id === ref.id) return 'trim';
  if (drag?.kind === ref.kind && drag.id === ref.id) return drag.target.moved ? 'drag' : 'press';
  return null;
}

/** Where a part starts on its track. */
function partStart(ref: ContentRef, props: Pick<ContentTracksProps, 'clips' | 'cues' | 'frameRate'>): number {
  return partSpan(ref, props)?.startMs ?? 0;
}

/** A camera's (or an older shown source's) place and length; none for an instant cue. */
function timedCueSpan(id: string, props: Pick<ContentTracksProps, 'cues' | 'frameRate'>): TimelineSpan | undefined {
  const cue = props.cues.find((entry) => entry.id === id);
  return cue ? timelineCueSpan(cue, props.frameRate) : undefined;
}

/** A part's place and length; an instant cue has its time and no length. */
function partSpan(ref: ContentRef, props: Pick<ContentTracksProps, 'clips' | 'cues' | 'frameRate'>): { startMs: number; durationMs: number } | undefined {
  if (ref.kind === 'clip') {
    const clip = props.clips.find((entry) => entry.id === ref.id);
    return clip ? resolveTimelineClipSpan(clip, props.frameRate) : undefined;
  }
  const cue = props.cues.find((entry) => entry.id === ref.id);
  if (!cue) return undefined;
  return timelineCueSpan(cue, props.frameRate) ?? { startMs: timecodeToMilliseconds(cue.timecode, props.frameRate), durationMs: 0 };
}

/** The small line a held part shows at this place (and, trimmed, this length), as TimelineItems draws it. */
function partLabel(ref: ContentRef, startMs: number, durationMs: number | undefined, props: Pick<ContentTracksProps, 'clips' | 'cues' | 'assets' | 'frameRate'>): string | null {
  if (ref.kind === 'clip') return clipLabel(props.assets.get(props.clips.find((clip) => clip.id === ref.id)?.assetId ?? ''), startMs, props.frameRate);
  const cue = props.cues.find((entry) => entry.id === ref.id);
  if (!cue) return null;
  const span = timelineCueSpan(cue, props.frameRate);
  return cueLabel(cue, span !== undefined, startMs, durationMs ?? span?.durationMs ?? 0, props.frameRate);
}
